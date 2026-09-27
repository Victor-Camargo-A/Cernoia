import { pool } from '../db.js';
import { runWorkflow } from './n8n.js';
// Queued interactive requests survive a pending matrix, unavailable workflow or worker restart.
export async function resumeMatrixAnalyses(){
 const jobs=await pool.query(`WITH candidates AS (
  SELECT a.id FROM saas.opportunity_ai_analyses a
  WHERE a.analysis_status='queued' AND a.prompt_version='interactive-v2-matrix' AND a.attempt_count<3
   AND COALESCE((a.analysis_result->>'matrix_dispatch_at')::timestamptz,'1900-01-01')<NOW()-INTERVAL '2 minutes'
   AND COALESCE((saas.company_matrix_analysis_context(a.organization_id)->>'can_analyze')::boolean,false)
  ORDER BY a.queued_at FOR UPDATE SKIP LOCKED LIMIT 3
 ) UPDATE saas.opportunity_ai_analyses a SET analysis_result=COALESCE(a.analysis_result,'{}')||jsonb_build_object('matrix_dispatch_at',NOW()),updated_at=NOW()
 FROM candidates c WHERE a.id=c.id RETURNING a.id,a.organization_id,a.process_id`);
 for(const job of jobs.rows){
  try{await runWorkflow('WF-008',{organization_id:job.organization_id,process_id:job.process_id,processing_mode:'single',max_analyses:1});}
  catch{await pool.query(`UPDATE saas.opportunity_ai_analyses SET analysis_result=analysis_result||'{"matrix_dispatch_error":"El motor se reintentará automáticamente."}'::jsonb WHERE id=$1 AND analysis_status='queued'`,[job.id]);}
 }
 return jobs.rowCount;
}
