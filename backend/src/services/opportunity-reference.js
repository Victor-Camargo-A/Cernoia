import {refreshProcessScores} from './effective-capabilities.js';
import {boundedQuery as query,withTenantTransaction} from '../db.js';
export function validReference(value){return typeof value==='string'&&value.length>=5&&value.length<=160&&/^[\p{L}\p{N} ._()/-]+$/u.test(value)&&/\d/.test(value);}
export async function findReference(organizationId,reference){
 reference=String(reference??'').trim();if(!validReference(reference))throw Object.assign(Error('Escribe la referencia exacta del proceso.'),{statusCode:400});
 let rows=(await query('SELECT * FROM secop.processes WHERE lower(reference)=lower($1) ORDER BY publication_date DESC NULLS LAST LIMIT 10',[reference])).rows;
 if(!rows.length){
  const url=new URL('https://www.datos.gov.co/resource/p6dx-8zbt.json');url.searchParams.set('$where',`upper(referencia_del_proceso)='${reference.toUpperCase().replace(/'/g,"''")}'`);url.searchParams.set('$limit','10');
  let response;try{response=await fetch(url,{signal:AbortSignal.timeout(20000)});}catch{throw Object.assign(Error('La fuente oficial tardó en responder. Intenta nuevamente.'),{statusCode:503});}if(!response.ok)throw Object.assign(Error('La fuente oficial no respondió. Intenta nuevamente.'),{statusCode:503});const source=await response.json();
  if(!Array.isArray(source))throw Error('Respuesta de la fuente oficial no válida.');
  for(const p of source){if(!/^CO1\.REQ\.\d+$/.test(p.id_del_proceso??''))continue;
   const inserted=await query(`INSERT INTO secop.processes(secop_process_id,reference,entity_name,entity_nit,department,city,process_name,description,procurement_method,contract_type,base_price,publication_date,response_deadline,source_updated_at,process_status,awarded,main_category_code,process_url,raw_json,portfolio_id,opening_status,summary_status,phase)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::timestamptz,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23)
   ON CONFLICT(secop_process_id) DO UPDATE SET last_seen_at=NOW() RETURNING *`,[p.id_del_proceso,p.referencia_del_proceso,p.entidad,p.nit_entidad,p.departamento_entidad,p.ciudad_entidad,p.nombre_del_procedimiento,p.descripci_n_del_procedimiento,p.modalidad_de_contratacion,p.tipo_de_contrato,Number.isFinite(Number(p.precio_base))?Number(p.precio_base):null,p.fecha_de_publicacion_del_proceso??null,p.fecha_de_recepcion_de??null,p.fecha_de_ultima_publicaci??null,p.estado_del_procedimiento,/^s[ií]$/i.test(p.adjudicado??''),p.codigo_principal_de_categoria,p.urlproceso?.url??null,JSON.stringify(p),p.id_del_portafolio,p.estado_de_apertura_del_proceso,p.estado_resumen,p.fase]);rows.push(inserted.rows[0]);
  }
 }
 if(!rows.length)return [];
 await withTenantTransaction(organizationId,async client=>{
  let profile=(await client.query('SELECT id FROM saas.search_profiles WHERE organization_id=$1 ORDER BY is_active DESC,created_at LIMIT 1',[organizationId])).rows[0];
  if(!profile)profile=(await client.query(`INSERT INTO saas.search_profiles(organization_id,name,is_active,filter_config) VALUES($1,'Referencias consultadas',FALSE,'{}') RETURNING id`,[organizationId])).rows[0];
  for(const p of rows){await client.query(`INSERT INTO saas.process_matches(organization_id,search_profile_id,process_id,match_score,match_status,matched_reasons,process_snapshot) VALUES($1,$2,$3,0,'new','{"reference_lookup":true,"source":"official_dataset"}'::jsonb,$4::jsonb) ON CONFLICT(search_profile_id,process_id) DO UPDATE SET matched_reasons=COALESCE(saas.process_matches.matched_reasons,'{}')||'{"reference_lookup":true}'::jsonb`,[organizationId,profile.id,p.id,JSON.stringify({reference:p.reference,secop_process_id:p.secop_process_id})]);}
 });
 await refreshProcessScores(organizationId,rows.map(p=>p.id));
 return rows.map(p=>p.id);
}
