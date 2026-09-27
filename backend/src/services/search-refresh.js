import {queueUnspscClassification} from './company-unspsc.js';
import {refreshProcessScores,persistEffectiveCapabilities} from './effective-capabilities.js';
import {randomUUID} from 'node:crypto';
import {pool,query} from '../db.js';
import {compileProfileFilters} from './opportunity-query.js';
export async function queueSearchRefresh(organizationId){
 await queueUnspscClassification(organizationId);
 await persistEffectiveCapabilities(organizationId);
 await query(`INSERT INTO saas.search_refresh_jobs(organization_id) VALUES($1) ON CONFLICT(organization_id) DO UPDATE SET requested_revision=saas.search_refresh_jobs.requested_revision+1,cursor_id=NULL,status=CASE WHEN saas.search_refresh_jobs.status='processing' THEN 'processing' ELSE 'queued' END,next_attempt_at=NOW(),updated_at=NOW()`,[organizationId]);
}
export async function refreshNextSearchBatch(){
 const token=randomUUID();const claimed=await pool.query(`WITH job AS (SELECT organization_id FROM saas.search_refresh_jobs WHERE next_attempt_at<=NOW() AND (status IN ('queued','error') OR (status='processing' AND locked_until<NOW())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE saas.search_refresh_jobs j SET status='processing',lease_token=$1,locked_until=NOW()+INTERVAL '1 minute' FROM job WHERE j.organization_id=job.organization_id RETURNING j.*`,[token]);
 if(!claimed.rowCount)return false;const job=claimed.rows[0];const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='12s'");
  const profiles=(await client.query('SELECT id,is_active,filter_config FROM saas.search_profiles WHERE organization_id=$1 AND is_active=TRUE',[job.organization_id])).rows;
  const values=[job.organization_id,job.cursor_id];const filters=compileProfileFilters(profiles,values);
  const ids=(await client.query(`SELECT id FROM ((SELECT pm.id FROM saas.process_matches pm JOIN secop.processes candidate ON candidate.id=pm.process_id WHERE pm.organization_id=$1 AND ($2::uuid IS NULL OR pm.id>$2::uuid) AND (${filters}) ORDER BY pm.id LIMIT 20) UNION (SELECT pm.id FROM saas.process_matches pm WHERE pm.organization_id=$1 AND ($2::uuid IS NULL OR pm.id>$2::uuid) AND pm.matched_reasons->>'reference_lookup'='true' ORDER BY pm.id LIMIT 20)) candidates ORDER BY id LIMIT 20`,values)).rows.map(d=>d.id);
  if(ids.length){const processes=(await client.query('SELECT DISTINCT process_id FROM saas.process_matches WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.process_id);await refreshProcessScores(job.organization_id,processes,(sql,args)=>client.query(sql,args));}
  await client.query(`UPDATE saas.search_refresh_jobs SET cursor_id=CASE WHEN requested_revision=$3 THEN $4::uuid ELSE NULL END,status=CASE WHEN requested_revision=$3 AND $5 THEN 'ready' ELSE 'queued' END,processed_revision=CASE WHEN requested_revision=$3 AND $5 THEN $3 ELSE processed_revision END,lease_token=NULL,locked_until=NULL,last_error=NULL,next_attempt_at=NOW(),updated_at=NOW() WHERE organization_id=$1 AND lease_token=$2`,[job.organization_id,token,job.requested_revision,ids.at(-1)??null,ids.length<20]);
  await client.query('COMMIT');return {organization_id:job.organization_id,processed:ids.length};
 }catch(error){await client.query('ROLLBACK');await pool.query(`UPDATE saas.search_refresh_jobs SET status='error',last_error=$3,next_attempt_at=NOW()+INTERVAL '1 minute',lease_token=NULL,locked_until=NULL WHERE organization_id=$1 AND lease_token=$2`,[job.organization_id,token,error.message.slice(0,400)]);return {error:error.message};}finally{client.release();}
}
