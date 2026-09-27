import {queueSearchRefresh} from './search-refresh.js';
import {enrichContractExperience,buildBusinessSummary} from './company-business-summary.js';
import { randomUUID } from 'node:crypto';
import { pool,query,withTenantTransaction } from '../db.js';
import { config } from '../config.js';
import { readStoredDocument } from './document-storage.js';
import { scanForMalware } from './malware-scanner.js';
import { processOrganizationDocument } from './document-processing.js';
import { extractCompanyFacts,matrixModel } from './company-matrix-ai.js';
import { assembleCompanyMatrix,sourceFingerprint,fingerprint,splitDocument,validateExtractedFacts,MATRIX_PROMPT_VERSION } from './company-matrix-rules.js';

const metadataColumns=`id,organization_id,document_name,document_type,storage_provider,storage_url,document_status,extraction_status,review_status,verification_status,
 issue_date,expiration_date,malware_scan_status,matrix_source_version,updated_at,
 (NULLIF(storage_key,'') IS NOT NULL) AS has_file,(length(COALESCE(extracted_text,''))>=40) AS has_text`;
export async function requestCompanyMatrix(organizationId,reason='user_requested') {
 await query('SELECT saas.queue_company_matrix($1::uuid,$2)',[organizationId,reason]);
}
export async function readCompanyMatrix(organizationId) {
 const [state,documents,capability,history]=await Promise.all([
  query('SELECT * FROM saas.company_matrix_state WHERE organization_id=$1',[organizationId]),
  query(`SELECT ${metadataColumns} FROM saas.organization_documents WHERE organization_id=$1 AND document_status<>'deleted' ORDER BY created_at,id`,[organizationId]),
  query('SELECT to_jsonb(c) AS profile FROM saas.organization_capability_profiles c WHERE organization_id=$1 AND is_active ORDER BY updated_at DESC LIMIT 1',[organizationId]),
  query('SELECT id,revision,created_at FROM saas.company_matrix_versions WHERE organization_id=$1 ORDER BY revision DESC LIMIT 10',[organizationId]),
 ]);
 const row=state.rows[0];const inventory=documents.rows.map(d=>({...d,has_file:d.storage_provider==='google_drive'?false:d.has_file,source_fingerprint:sourceFingerprint(d)}));
 const view=assembleCompanyMatrix(enrichContractExperience(row?.matrix?.facts??[],inventory),inventory.map(d=>usable(d)?d:{...d,malware_scan_status:'blocked'}),capability.rows[0]?.profile??{});
 return {...view,business_summary:buildBusinessSummary(view,inventory),documents:inventory.map(d=>({id:d.id,name:d.document_name,type:d.document_type,extraction_status:d.extraction_status,
   has_file:d.has_file,has_text:d.has_text,review_status:d.review_status,expiration_date:d.expiration_date,
   status:!d.has_file&&!d.has_text?'missing_file':!usable(d)?'blocked':['failed','needs_review'].includes(d.extraction_status)&&!d.has_text?'unreadable':!d.has_text?'awaiting_text':'available'})),
  processing:{status:row?.status??'empty',requested_revision:Number(row?.requested_revision??0),revision:Number(row?.processed_revision??0),
   updating:row?Number(row.requested_revision)>Number(row.processed_revision)||['queued','processing','error'].includes(row.status):false,
   documents_total:row?.documents_total??inventory.length,documents_processed:row?.documents_processed??0,
   generated_at:row?.generated_at??null,next_attempt_at:row?.next_attempt_at??null,last_error:row?.last_error??null},versions:history.rows};
}

function usable(document){
 return document.review_status!=='rejected'&&document.verification_status!=='rejected'
  &&!['infected','blocked','quarantined'].includes(document.malware_scan_status)
  &&(!config.malwareScanRequired||document.malware_scan_status==='clean');
}
async function releaseJob(job,error){
 const delay=Math.max(2,Math.min(3600,Number(error.retryAfter??Math.min(3600,30*2**Math.min(job.attempts??0,6)))));
 const waiting=['AI_QUOTA_WAIT','MATRIX_WORK_REMAINING'].includes(error.code);
 await pool.query(`UPDATE saas.company_matrix_state SET status=CASE WHEN requested_revision>$3 THEN 'queued' ELSE $4 END,
   lease_token=NULL,locked_until=NULL,next_attempt_at=NOW()+($5::int*INTERVAL '1 second'),attempts=attempts+1,last_error=$6,updated_at=NOW()
   WHERE organization_id=$1 AND lease_token=$2`,[job.organization_id,job.lease_token,job.requested_revision,waiting?'queued':'error',delay,String(error.message).slice(0,500)]);
}
export async function processNextMatrixJob({organizationId=null,analyze=extractCompanyFacts}={}){
 const token=randomUUID();
 const claimed=await pool.query(`WITH candidate AS (
  SELECT organization_id FROM saas.company_matrix_state
  WHERE ($1::uuid IS NULL OR organization_id=$1) AND next_attempt_at<=NOW()
   AND (status IN ('queued','error') OR (status='processing' AND locked_until<NOW()))
  ORDER BY next_attempt_at,organization_id FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE saas.company_matrix_state s SET status='processing',lease_token=$2,locked_until=NOW()+INTERVAL '10 minutes',started_at=NOW(),updated_at=NOW()
 FROM candidate WHERE s.organization_id=candidate.organization_id RETURNING s.*`,[organizationId,token]);
 if(!claimed.rowCount)return null;
 const job=claimed.rows[0];const started=Date.now();let calls=0;
 try{
  const organization=(await pool.query('SELECT id,name,legal_name,tax_id FROM saas.organizations WHERE id=$1',[job.organization_id])).rows[0];
  const ids=(await pool.query(`SELECT id FROM saas.organization_documents WHERE organization_id=$1 AND document_status<>'deleted' ORDER BY created_at,id`,[job.organization_id])).rows;
  const declared=(await pool.query('SELECT to_jsonb(c) profile FROM saas.organization_capability_profiles c WHERE organization_id=$1 AND is_active ORDER BY updated_at DESC LIMIT 1',[job.organization_id])).rows[0]?.profile??{};
  await pool.query('UPDATE saas.company_matrix_state SET documents_total=$3,documents_processed=0 WHERE organization_id=$1 AND lease_token=$2',[job.organization_id,token,ids.length]);
  const facts=[];const inventory=[];let completed=0;let pending=false;
  for(const {id} of ids){
   let d=(await pool.query(`SELECT ${metadataColumns},extracted_text,file_hash_sha256,storage_key FROM saas.organization_documents WHERE id=$1 AND organization_id=$2 AND document_status<>'deleted'`,[id,job.organization_id])).rows[0];
   if(!d)continue;
   if(d.storage_provider==='google_drive'&&!d.has_text){inventory.push({...d,extracted_text:undefined,storage_key:undefined,has_file:false,has_text:false,source_fingerprint:sourceFingerprint(d)});completed++;continue;}
   if(d.has_file&&config.malwareScanRequired&&d.malware_scan_status!=='clean'
      &&!['infected','blocked','quarantined'].includes(d.malware_scan_status)&&d.review_status!=='rejected'){
    const buffer=await readStoredDocument(d.storage_key);
    if(!buffer)throw Error('Un archivo pendiente de lectura no está disponible.');
    try {
     const scan=await scanForMalware(buffer);
     await pool.query('UPDATE saas.organization_documents SET malware_scan_status=$3,malware_scanned_at=NOW() WHERE id=$1 AND organization_id=$2',[id,job.organization_id,scan.status]);
    }catch(error){
     if(error.code!=='MALWARE_DETECTED')throw error;
     await pool.query("UPDATE saas.organization_documents SET malware_scan_status='infected',malware_scanned_at=NOW() WHERE id=$1 AND organization_id=$2",[id,job.organization_id]);
    }
    d=(await pool.query(`SELECT ${metadataColumns},extracted_text,file_hash_sha256,storage_key FROM saas.organization_documents WHERE id=$1 AND organization_id=$2 AND document_status<>'deleted'`,[id,job.organization_id])).rows[0];
    if(!d)continue;
   }
   if(usable(d)&&d.has_file&&!d.has_text&&(d.extraction_status==='not_requested'||(d.extraction_status==='processing'&&Date.now()-new Date(d.updated_at).getTime()>600000))){
    try{await processOrganizationDocument(d.id,job.organization_id);}catch{ /* The document records its extraction error; the matrix reports the gap. */ }
    d=(await pool.query(`SELECT ${metadataColumns},extracted_text,file_hash_sha256,storage_key FROM saas.organization_documents WHERE id=$1 AND organization_id=$2 AND document_status<>'deleted'`,[id,job.organization_id])).rows[0];
    if(!d)continue;
   }
   const {extracted_text,file_hash_sha256,storage_key,...summary}=d;
   inventory.push({...summary,source_fingerprint:sourceFingerprint(d)});
   if(usable(d)&&d.has_text){
    for(const chunk of splitDocument(d.extracted_text)){
     const inputHash=fingerprint({version:MATRIX_PROMPT_VERSION,model:matrixModel,text:chunk.text,type:d.document_type,organization});
     const cached=(await pool.query('SELECT facts FROM saas.company_document_facts WHERE organization_id=$1 AND document_id=$2 AND input_hash=$3',[job.organization_id,id,inputHash])).rows[0];
     let extracted;
     if(cached){extracted=cached.facts.map(f=>({...f,source_fingerprint:sourceFingerprint(d)}));}
     else{
      if(calls>=8||Date.now()-started>100000)throw Object.assign(Error('La matriz continúa procesando los documentos restantes.'),{code:'MATRIX_WORK_REMAINING',retryAfter:5});
      await pool.query("UPDATE saas.company_matrix_state SET locked_until=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE organization_id=$1 AND lease_token=$2",[job.organization_id,token]);
      const payload=await analyze({organizationId:job.organization_id,organization,document:d,chunk,requestId:`matrix:${job.organization_id}:${inputHash.slice(0,24)}`});calls++;
      const checked=validateExtractedFacts(payload,chunk.text,d);extracted=checked.facts;
      // A response composed entirely of unsupported citations is retried, never published as a successful reading.
      if(checked.rejected>0&&!checked.facts.length)throw Error('Las citas devueltas por la IA no pudieron verificarse contra el documento.');
      await pool.query(`INSERT INTO saas.company_document_facts(organization_id,document_id,input_hash,facts,rejected_facts,provider,model_name,prompt_version)
       VALUES($1,$2,$3,$4::jsonb,$5,'google',$6,$7) ON CONFLICT DO NOTHING`,[job.organization_id,id,inputHash,JSON.stringify(extracted),checked.rejected,matrixModel,MATRIX_PROMPT_VERSION]);
     }
     facts.push(...extracted);
    }
   }else if(usable(d)&&d.has_file&&['not_requested','processing','queued','pending'].includes(d.extraction_status)){pending=true;}
   completed++;
   await pool.query('UPDATE saas.company_matrix_state SET documents_processed=$3,updated_at=NOW() WHERE organization_id=$1 AND lease_token=$2',[job.organization_id,token,completed]);
  }
  const matrix=assembleCompanyMatrix(enrichContractExperience(facts,inventory),inventory,declared);
  const status=!inventory.length?'empty':!matrix.coverage.documented_dimensions||matrix.conflicts.length?'needs_review':'ready';
  const published=await withTenantTransaction(job.organization_id,async client=>{
   const current=(await client.query('SELECT requested_revision,lease_token FROM saas.company_matrix_state WHERE organization_id=$1 FOR UPDATE',[job.organization_id])).rows[0];
   if(!current||current.lease_token!==token)return false;
   if(String(current.requested_revision)!==String(job.requested_revision)){
    await client.query("UPDATE saas.company_matrix_state SET status='queued',lease_token=NULL,locked_until=NULL,next_attempt_at=NOW()+INTERVAL '2 seconds',updated_at=NOW() WHERE organization_id=$1",[job.organization_id]);return false;
   }
   await client.query(`INSERT INTO saas.company_matrix_versions(organization_id,revision,matrix,document_inventory,provider,model_name)
     VALUES($1,$2,$3::jsonb,$4::jsonb,'google',$5) ON CONFLICT(organization_id,revision) DO UPDATE SET matrix=EXCLUDED.matrix,document_inventory=EXCLUDED.document_inventory,created_at=NOW()`,
     [job.organization_id,job.requested_revision,JSON.stringify(matrix),JSON.stringify(inventory),matrixModel]);
   await client.query(`UPDATE saas.company_matrix_state SET matrix=$3::jsonb,processed_revision=requested_revision,status=$4,
     generated_at=NOW(),as_of_date=CURRENT_DATE,lease_token=NULL,locked_until=NULL,attempts=0,last_error=NULL,
     next_attempt_at=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE organization_id=$1 AND lease_token=$2`,
     [job.organization_id,token,JSON.stringify(matrix),pending?'queued':status]);
   return true;
  });
  if(published)await queueSearchRefresh(job.organization_id);
  return {organization_id:job.organization_id,published,revision:Number(job.requested_revision),facts:matrix.facts.length,calls};
 }catch(error){await releaseJob(job,error);return {organization_id:job.organization_id,published:false,error:error.message,retry:true};}
}
export async function queueDailyMatrixRefresh(){
 await pool.query(`UPDATE saas.company_matrix_state SET requested_revision=requested_revision+1,status='queued',next_attempt_at=NOW(),
 last_reason='daily_validity_refresh',updated_at=NOW() WHERE as_of_date<CURRENT_DATE AND status IN ('ready','needs_review','empty')`);
}
