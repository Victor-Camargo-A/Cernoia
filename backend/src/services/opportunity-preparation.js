import {pool,query,withTenantTransaction} from '../db.js';
import {assertOpportunityAccess} from './bid-workspace.js';import {syncProcessInventory} from './process-inventory.js';
import {ensurePublicMatrix,readPublicMatrix} from './process-knowledge.js';import {hash} from './process-knowledge-rules.js';
import {requestOpportunityAnalysis} from './opportunity-analysis.js';
export async function queueOpportunityPreparation(org,userId,processId){
 await assertOpportunityAccess(org,processId);
 return (await query(`INSERT INTO saas.opportunity_preparations(organization_id,process_id,requested_by_user_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,process_id) DO UPDATE SET status=CASE WHEN saas.opportunity_preparations.status IN ('queued','reading','analyzing') THEN saas.opportunity_preparations.status ELSE 'queued' END,requested_by_user_id=EXCLUDED.requested_by_user_id,next_attempt_at=NOW(),last_error=NULL,updated_at=NOW() RETURNING *`,[org,processId,userId])).rows[0];
}
export async function preparationStatus(org,processId){
 const job=(await query('SELECT status,matrix_id,analysis_id,last_error,updated_at FROM saas.opportunity_preparations WHERE organization_id=$1 AND process_id=$2',[org,processId])).rows[0];
 if(!job)return null;const matrix=job.matrix_id?await readPublicMatrix(job.matrix_id):null;
 return {...job,documents_total:matrix?.documents.length??0,documents_read:matrix?.documents.filter(d=>d.status==='ready').length??0,document_errors:matrix?.documents.filter(d=>d.status==='error').map(d=>({name:d.filename,message:d.error_message}))??[]};
}
async function materializeRequirements(org,processId,matrix){
 await withTenantTransaction(org,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`public-requirements:${org}:${processId}`]);
  await client.query("UPDATE saas.opportunity_requirements SET status='superseded',updated_at=NOW() WHERE organization_id=$1 AND process_id=$2 AND metadata->>'source'='public_matrix' AND metadata->>'matrix_id'<>$3",[org,processId,matrix.id]);
  for(const d of matrix.documents)for(const f of d.facts.filter(f=>f.is_requirement)){
   const digest=hash([d.process_document_id,f.category,f.value,f.requirement_stage]);
   const existing=(await client.query("SELECT id FROM saas.opportunity_requirements WHERE organization_id=$1 AND process_id=$2 AND requirement_hash_sha256=$3 AND metadata->>'source'='public_matrix' LIMIT 1",[org,processId,digest])).rows[0];
   const metadata=JSON.stringify({source:'public_matrix',matrix_id:matrix.id,public_insight_id:d.id,process_document_id:d.process_document_id,source_url:d.source_url});
   if(existing){await client.query("UPDATE saas.opportunity_requirements SET status='active',metadata=$2::jsonb,updated_at=NOW() WHERE id=$1",[existing.id,metadata]);continue;}
   const stage=f.requirement_stage??'other',category=['legal','technical','financial','experience'].includes(f.category)?f.category:'other';
   await client.query(`INSERT INTO saas.opportunity_requirements(organization_id,process_id,requirement_code,category,requirement_category,requirement_name,requirement_description,source_document_name,source_reference,mandatory,requirement_status,evidence_text,requirement_hash_sha256,requirement_stage,is_bid_requirement,metadata) VALUES($1,$2,$3,$4::text,$4::text,$5,$6::text,$7,$8,$9,'review_required',$6::text,$10,$11,$12,$13::jsonb)`,[org,processId,'public-'+digest.slice(0,20),category,f.label,f.quote,d.filename,d.source_url,f.mandatory===true,digest,stage,['bid_submission','eligibility','evaluation'].includes(stage),metadata]);
  }
 });
}
export async function processNextPreparation(){
 const client=await pool.connect();let locked=false;
 try{
  locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('opportunity-preparation-v1')) AS ok")).rows[0].ok;if(!locked)return null;
  const job=(await client.query("SELECT * FROM saas.opportunity_preparations WHERE status IN ('queued','reading','analyzing') AND next_attempt_at<=NOW() ORDER BY updated_at LIMIT 1")).rows[0];if(!job)return null;
  const update=(status,matrixId,analysisId,error=null)=>client.query('UPDATE saas.opportunity_preparations SET status=$3,matrix_id=$4,analysis_id=$5,last_error=$6,next_attempt_at=NOW()+INTERVAL \'10 seconds\',updated_at=NOW() WHERE organization_id=$1 AND process_id=$2',[job.organization_id,job.process_id,status,matrixId,analysisId,error]);
  try{
   if(job.status==='queued'){
    await syncProcessInventory(job.process_id);const matrix=await ensurePublicMatrix(job.process_id);
    if(!matrix.document_ids.length){await update('incomplete',matrix.id,null,'La fuente oficial aún no entrega documentos. Puedes volver a traerlos más tarde.');return {status:'incomplete'};}
    // An explicit retry also retries unreadable sources; immutable cached readings are preserved.
    await client.query("UPDATE secop.public_document_insights SET status='queued',next_attempt_at=NOW(),attempts=0 WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb)) AND status='error'",[JSON.stringify(matrix.document_ids)]);
    await update('reading',matrix.id,null);return {status:'reading',documents:matrix.document_ids.length};
   }
   if(job.status==='reading'){
    const matrix=await readPublicMatrix(job.matrix_id);if(!matrix)throw Error('La matriz del proceso no está disponible.');
    if(matrix.documents.some(d=>['queued','processing'].includes(d.status))){await update('reading',job.matrix_id,null);return null;}
    if(!matrix.documents.length||matrix.documents.some(d=>d.status!=='ready')){await update('incomplete',job.matrix_id,null,'Hay archivos pendientes de lectura. Revisa los mensajes por documento; no se ha marcado un análisis completo.');return {status:'incomplete'};}
    const context=(await client.query('SELECT saas.company_matrix_analysis_context($1) AS matrix',[job.organization_id])).rows[0].matrix;
    if(!context.can_analyze){await update('reading',job.matrix_id,null,'Esperando la matriz empresarial actualizada.');return null;}
    await materializeRequirements(job.organization_id,job.process_id,matrix);
    const analysis=await requestOpportunityAnalysis(job.organization_id,job.requested_by_user_id,job.process_id,{documentMatrixId:matrix.id});
    await update('analyzing',job.matrix_id,analysis.id);return {status:'analyzing'};
   }
   const analysis=(await client.query('SELECT analysis_status,error_message FROM saas.opportunity_ai_analyses WHERE id=$1 AND organization_id=$2',[job.analysis_id,job.organization_id])).rows[0];
   if(analysis?.analysis_status==='success')await update('ready',job.matrix_id,job.analysis_id);
   else if(['failed','review_required'].includes(analysis?.analysis_status))await update('error',job.matrix_id,job.analysis_id,'El análisis comparativo requiere un nuevo intento.');
   else await update('analyzing',job.matrix_id,job.analysis_id);
   return {status:analysis?.analysis_status};
  }catch(error){await update('error',job.matrix_id,job.analysis_id,String(error.message).slice(0,500));return {error:true};}
 }finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('opportunity-preparation-v1'))");client.release();}
}
