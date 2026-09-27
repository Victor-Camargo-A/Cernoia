import {annexRole} from './annex-rules.js';
import {query,withTenantTransaction} from '../db.js';
import {readPublicMatrix,processSources} from './process-knowledge.js';
import {manifestFingerprint,artifactIsApproved,blockingIssues} from './process-knowledge-rules.js';
import {suggestContext} from './annex-fields.js';
export async function assertOpportunityAccess(organizationId,processId){const row=(await query('SELECT p.id,p.reference,p.process_name FROM secop.processes p WHERE p.id=$2 AND EXISTS(SELECT 1 FROM saas.process_matches m WHERE m.organization_id=$1 AND m.process_id=p.id)',[organizationId,processId])).rows[0];if(!row)throw Object.assign(Error('Oportunidad no encontrada.'),{statusCode:404});return row;}
export function effectiveRole(doc,decisions){const d=decisions?.[doc.id];return d&&d.content_hash===doc.content_hash?d.role:annexRole(doc.filename)==='informative'?'informative':doc.document_role;}
export async function readBidWorkspace(organizationId,processId){
 const workspace=(await query('SELECT * FROM saas.bid_workspaces WHERE organization_id=$1 AND process_id=$2',[organizationId,processId])).rows[0];if(!workspace){const result=await query("SELECT EXISTS(SELECT 1 FROM saas.opportunity_ai_analyses WHERE organization_id=$1 AND process_id=$2 AND analysis_status='success') AS can_start",[organizationId,processId]);return {workspace:null,can_start:result.rows[0].can_start};}
 const matrix=await readPublicMatrix(workspace.matrix_id);
 const sources=await processSources(processId);const stale=!matrix||manifestFingerprint(sources)!==matrix.source_fingerprint;
 const templates=(await query(`SELECT t.id,t.name,t.template_type,t.public_insight_id,t.source_content_hash,t.current_version,v.id AS version_id,v.field_schema,v.field_mapping,
 g.id AS generated_id,g.status AS generated_status,g.file_hash_sha256,g.validation_issues,g.template_version_id,g.storage_url,g.mime_type,g.generated_at,
 r.source_hash AS reviewed_source_hash,r.preview_hash AS reviewed_preview_hash,r.reviewed_at,
 pv.source_hash AS preview_source_hash,pv.pdf_hash AS preview_hash,pv.page_count
 FROM saas.document_templates t JOIN saas.document_template_versions v ON v.template_id=t.id AND v.version_number=t.current_version
 LEFT JOIN LATERAL(SELECT * FROM saas.generated_template_documents WHERE template_id=t.id AND organization_id=$1 AND process_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1)g ON TRUE
 LEFT JOIN saas.generated_document_reviews r ON r.generated_document_id=g.id AND r.organization_id=$1
 LEFT JOIN saas.generated_document_previews pv ON pv.generated_document_id=g.id AND pv.organization_id=$1
 WHERE t.organization_id=$1 AND t.process_id=$2 AND t.status='active' ORDER BY t.created_at`,[organizationId,processId])).rows;
 const docs=(matrix?.documents??[]).map(d=>({...d,effective_role:effectiveRole(d,workspace.document_decisions)}));
 const currentIds=new Set(docs.filter(d=>['fillable','mixed'].includes(d.effective_role)).map(d=>d.id));
 const currentTemplates=templates.filter(t=>!t.public_insight_id||currentIds.has(t.public_insight_id)).map(t=>({...t,approved:t.generated_status!=='generating'&&t.template_version_id===t.version_id&&artifactIsApproved({file_hash_sha256:t.file_hash_sha256,validation_issues:t.validation_issues??[]},t.reviewed_at?{source_hash:t.reviewed_source_hash,preview_hash:t.reviewed_preview_hash}:null,t.preview_hash?{source_hash:t.preview_source_hash,pdf_hash:t.preview_hash}:null)}));
 const blockers=[];
 if(stale)blockers.push('Cambió el inventario público: actualiza la matriz del proceso.');
 if(!docs.length)blockers.push('El inventario público aún no contiene documentos para este proceso.');
 for(const d of docs){if(d.effective_role==='not_required')continue;if(d.status!=='ready')blockers.push(`${d.filename}: lectura pendiente.`);if(d.effective_role==='unknown')blockers.push(`${d.filename}: confirma si es informativo o requiere diligenciamiento.`);if(d.verified_at&&Date.now()-new Date(d.verified_at).getTime()>86400000)blockers.push(`${d.filename}: falta comprobar la versión de la fuente.`);if(['fillable','mixed'].includes(d.effective_role)){const t=currentTemplates.find(t=>t.public_insight_id===d.id);if(!t)blockers.push(`${d.filename}: importa el formato para autollenarlo.`);else if(t.source_content_hash!==d.content_hash)blockers.push(`${d.filename}: el original cambió; importa su nueva versión.`);}}
 for(const t of currentTemplates)if(!t.approved)blockers.push(`${t.name}: genera, previsualiza y aprueba la versión actual.`);
 const supports=(await query(`SELECT id,document_name,original_filename,mime_type,file_size_bytes,file_hash_sha256,expiration_date,document_status,verification_status,malware_scan_status FROM saas.organization_documents WHERE organization_id=$1 AND document_status<>'deleted' AND storage_key IS NOT NULL ORDER BY document_name`,[organizationId])).rows;
 return {workspace:{id:workspace.id,created_at:workspace.created_at},matrix:matrix?{...matrix,documents:docs,stale}:null,templates:currentTemplates,supports,blockers};
}
export async function importPublicTemplate(organizationId,userId,processId,insightId){
 return withTenantTransaction(organizationId,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`bid-template:${organizationId}:${processId}:${insightId}`]);
  const d=(await client.query(`SELECT i.* FROM secop.public_document_insights i JOIN secop.public_process_matrices m ON m.document_ids ? i.id::text JOIN saas.bid_workspaces w ON w.matrix_id=m.id WHERE w.organization_id=$1 AND w.process_id=$2 AND i.id=$3 AND i.status='ready'`,[organizationId,processId,insightId])).rows[0];if(!d?.storage_key)throw Object.assign(Error('El documento público aún no está listo para diligenciar.'),{statusCode:422});
  const existing=(await client.query('SELECT * FROM saas.document_templates WHERE organization_id=$1 AND process_id=$2 AND public_insight_id=$3 AND status=\'active\' FOR UPDATE',[organizationId,processId,insightId])).rows[0];
  if(existing?.source_content_hash===d.content_hash)return existing;
  const type=d.mime_type==='application/pdf'?'pdf_form':d.mime_type.includes('spreadsheetml')?'xlsx':'docx';
  const t=existing??(await client.query(`INSERT INTO saas.document_templates(organization_id,name,template_type,scope,process_id,public_insight_id,source_content_hash,created_by_user_id) VALUES($1,$2,$3,'process',$4,$5,$6,$7) RETURNING *`,[organizationId,`${d.filename} · ${processId.slice(0,8)} · ${insightId.slice(0,8)}`,type,processId,insightId,d.content_hash,userId])).rows[0];
  const version=existing?t.current_version+1:1;const mapping=Object.fromEntries(d.field_schema.map(f=>[f.name,f.suggested_source||suggestContext(f.label??f.name)||f.name]));
  await client.query(`INSERT INTO saas.document_template_versions(template_id,organization_id,version_number,original_filename,storage_key,mime_type,file_size_bytes,file_hash_sha256,field_schema,field_mapping,source_metadata,created_by_user_id)
 VALUES($1,$2,$3,$4,$5,$6,0,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,[t.id,organizationId,version,d.filename,d.storage_key,d.mime_type,d.content_hash,JSON.stringify(d.field_schema),JSON.stringify(mapping),JSON.stringify({public_insight_id:insightId,source_content_hash:d.content_hash}),userId]);
  await client.query('UPDATE saas.document_templates SET current_version=$3,source_content_hash=$4,updated_at=NOW() WHERE id=$1 AND organization_id=$2',[t.id,organizationId,version,d.content_hash]);return {...t,current_version:version};
 });
}
