import {createHash,randomUUID} from 'node:crypto';
import {pool,withTenantTransaction} from '../db.js';
import {extractSemanticMetadata,METADATA_VERSION} from './document-metadata-ai.js';
import {validateSemanticMetadata,mergeSemanticMetadata,addMetadataDays} from './document-metadata-validation.js';
import {extractDocumentText} from './document-extractor.js';
import {readStoredDocument} from './document-storage.js';
const hash=text=>createHash('sha256').update(String(text??'')).digest('hex');
export async function queueNewMetadata(){
 const since=process.env.DOCUMENT_METADATA_AUTOSTART_SINCE;
 if(!since)return;
 await pool.query(`UPDATE saas.organization_documents SET ai_classification=COALESCE(ai_classification,'{}'::jsonb)||jsonb_build_object('metadata_status','queued','metadata_attempts',0)
 WHERE created_at >= $1::timestamptz AND document_status<>'deleted' AND review_status<>'rejected'
 AND extraction_status IN ('extracted','success') AND length(COALESCE(extracted_text,''))>=40
 AND ai_classification->>'metadata_status' IS NULL AND ai_classification->>'metadata_version' IS DISTINCT FROM $2`,[since,METADATA_VERSION]);
}
export async function processNextMetadataJob(){
 const lease=randomUUID();
 const claimed=await pool.query(`WITH next AS (
 SELECT id FROM saas.organization_documents WHERE document_status<>'deleted' AND review_status<>'rejected'
 AND extraction_status IN ('extracted','success') AND length(COALESCE(extracted_text,''))>=40
 AND (ai_classification->>'metadata_status' IN ('queued','retry') OR (ai_classification->>'metadata_status'='processing' AND (ai_classification->>'metadata_lease_until')::timestamptz<NOW()))
 AND COALESCE((ai_classification->>'metadata_next_attempt')::timestamptz,'1900-01-01'::timestamptz)<=NOW()
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
 UPDATE saas.organization_documents d SET ai_classification=COALESCE(d.ai_classification,'{}'::jsonb)||jsonb_build_object('metadata_status','processing','metadata_lease',$1::text,'metadata_lease_until',NOW()+INTERVAL '5 minutes','metadata_attempts',COALESCE((d.ai_classification->>'metadata_attempts')::integer,0)+1)
 FROM next WHERE d.id=next.id RETURNING d.*`,[lease]);
 if(!claimed.rowCount)return false;
 const doc=claimed.rows[0];
 try{
  if(doc.mime_type==='application/pdf'&&doc.extracted_text.length<250&&doc.storage_key&&doc.ocr_status==='not_needed'){
   const buffer=await readStoredDocument(doc.storage_key);
   if(buffer){const improved=await extractDocumentText(buffer,{mimeType:doc.mime_type,filename:doc.original_filename,forceOcr:true});
    if(improved.text.length>doc.extracted_text.length){
     await pool.query(`UPDATE saas.organization_documents SET extracted_text=$3,ocr_status=$4,ocr_provider=$5,extraction_confidence=$6,updated_at=NOW() WHERE id=$1 AND organization_id=$2 AND document_status<>'deleted'`,[doc.id,doc.organization_id,improved.text,improved.ocrStatus,improved.method,improved.confidence]);
     doc.extracted_text=improved.text;
    }
   }
  }
  const raw=await extractSemanticMetadata(doc),analysis=validateSemanticMetadata(raw,doc.extracted_text);
  await withTenantTransaction(doc.organization_id,async client=>{
   const result=await client.query("SELECT * FROM saas.organization_documents WHERE id=$1 AND organization_id=$2 AND document_status<>'deleted' FOR UPDATE",[doc.id,doc.organization_id]);
   if(!result.rowCount)return;const current=result.rows[0];
   if(current.review_status==='rejected'||current.ai_classification?.metadata_lease!==lease)return;
   if(hash(current.extracted_text)!==hash(doc.extracted_text)){
    await client.query(`UPDATE saas.organization_documents SET ai_classification=ai_classification||'{"metadata_status":"queued"}'::jsonb WHERE id=$1`,[doc.id]);return;
   }
   const type=['other_document','auto_detect'].includes(current.document_type)||!['corrected','rejected'].includes(current.review_status)?analysis.document_type:current.document_type;
   const policy=(await client.query(`SELECT validity_days,alert_days_before FROM saas.document_type_policies WHERE (organization_id=$1 OR organization_id IS NULL) AND document_type=$2 AND is_active=TRUE ORDER BY organization_id IS NOT NULL DESC,updated_at DESC LIMIT 1`,[doc.organization_id,type])).rows[0]??{};
   const merged=mergeSemanticMetadata(current,analysis,policy);
   const status=merged.requires_review?'pending':current.review_status==='corrected'?'corrected':'approved';
   const classification={metadata_status:'complete',metadata_version:METADATA_VERSION,metadata_source:'ai_with_verified_quotes',document_type_label:merged.document_type_label,expiration_source:merged.expiration_source,metadata_issues:analysis.issues,metadata_evidence:analysis.evidence,metadata_completed_at:new Date().toISOString(),requires_human_review:merged.requires_review,metadata_lease:null,metadata_lease_until:null};
   await client.query(`UPDATE saas.organization_documents SET document_type=$3,document_name=$4,issue_date=$5::date,expiration_date=$6::date,renewal_due_date=$6::date,alert_due_date=$7::date,policy_validity_days=$8,alert_days_before=$9,review_status=$10,ai_classification=COALESCE(ai_classification,'{}'::jsonb)||$11::jsonb,updated_at=NOW() WHERE id=$1 AND organization_id=$2`,[doc.id,doc.organization_id,merged.document_type,merged.document_name,merged.issue_date,merged.expiration_date,merged.expiration_date?addMetadataDays(merged.expiration_date,-merged.alert_days_before):null,merged.policy_validity_days,merged.alert_days_before,status,JSON.stringify(classification)]);
   const proposed={...merged,organization_type:null};
   await client.query(`INSERT INTO saas.document_extraction_reviews(organization_id,organization_document_id,status,proposed_values,confidence,evidence) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)
    ON CONFLICT(organization_document_id) DO UPDATE SET status=EXCLUDED.status,proposed_values=EXCLUDED.proposed_values,confidence=EXCLUDED.confidence,evidence=EXCLUDED.evidence,updated_at=NOW()`,[doc.organization_id,doc.id,status,JSON.stringify(proposed),merged.requires_review?0.5:0.95,JSON.stringify({method:'IA sobre texto/OCR',...analysis.evidence,issues:analysis.issues,expiration_source:merged.expiration_source,character_count:doc.extracted_text.length})]);
   await client.query(`INSERT INTO saas.app_audit_log(organization_id,action,entity_type,entity_id,metadata) VALUES($1,'document.metadata_extracted','organization_document',$2,$3::jsonb)`,[doc.organization_id,doc.id,JSON.stringify({version:METADATA_VERSION,expiration_source:merged.expiration_source,requires_review:merged.requires_review})]);
  });
  return {document_id:doc.id,status:'complete',issues:analysis.issues};
 }catch(error){
  const transient=['AI_QUOTA_WAIT','AI_PROVIDER_WAIT'].includes(error.code);
  const attempt=Number(doc.ai_classification?.metadata_attempts??1);
  const status=error.permanent||(!transient&&attempt>=3)?'error':'retry';
  const next=new Date(Date.now()+Math.max(30,error.retryAfter??60)*1000).toISOString();
  await pool.query(`UPDATE saas.organization_documents SET ai_classification=ai_classification||$3::jsonb WHERE id=$1 AND organization_id=$2 AND ai_classification->>'metadata_lease'=$4`,[doc.id,doc.organization_id,JSON.stringify({metadata_status:status,metadata_error:String(error.message).slice(0,500),metadata_next_attempt:next,metadata_lease:null,metadata_lease_until:null}),lease]);
  return {document_id:doc.id,status,error:error.message};
 }
}
