import {boundedQuery} from '../db.js';
const normalize=value=>String(value??'').toLowerCase().replace(/[áéíóúüñ]/g,c=>({'á':'a','é':'e','í':'i','ó':'o','ú':'u','ü':'u','ñ':'n'}[c])).replace(/[^a-z0-9]+/g,' ').trim();
const array=v=>Array.isArray(v)?v.map(String).map(v=>v.trim()).filter(Boolean):[];
export function compileProfileFilters(profiles,values,alias='candidate'){
 const bind=value=>{values.push(value);return `$${values.length}`};
 return profiles.filter(p=>p.is_active!==false).map(profile=>{
  const f=profile.filter_config??{},conditions=[`pm.search_profile_id=${bind(profile.id)}::uuid`];
  for(const [key,column] of [['procurement_methods','procurement_method'],['process_statuses','process_status'],['departments','department'],['cities','city'],['contract_types','contract_type']]){
   const terms=array(f[key]).map(normalize);
   if(terms.length&&!(key==='departments'&&terms.some(v=>['nacional','cobertura nacional','todo el pais','colombia'].includes(v))))conditions.push(`trim(saas.match_text(${alias}.${column}))=ANY(${bind(terms)}::text[])`);
  }
  const codes=array(f.unspsc_codes).map(v=>v.replace(/^V\d+\./i,'').replace(/\D/g,'')).filter(v=>v.length>=2);
  if(array(f.unspsc_codes).length)conditions.push(codes.length?`(${codes.map(code=>`saas.unspsc_digits(COALESCE(${alias}.main_category_code,${alias}.raw_json->>'codigo_principal_de_categoria')) LIKE ${bind(code+'%')}`).join(' OR ')})`:'FALSE');
  if(f.minimum_budget!==null&&f.minimum_budget!==undefined&&f.minimum_budget!=='')conditions.push(`${alias}.base_price>=${bind(Number(f.minimum_budget))}::numeric`);
  if(f.maximum_budget!==null&&f.maximum_budget!==undefined&&f.maximum_budget!=='')conditions.push(`${alias}.base_price<=${bind(Number(f.maximum_budget))}::numeric`);
  if(f.only_open===true)conditions.push(`NOT COALESCE(${alias}.awarded,FALSE) AND NOT secop.deadline_passed(${alias}.response_deadline,${alias}.raw_json->>'fecha_de_recepcion_de') AND saas.match_text(${alias}.process_status)!~'(cancelad|adjudicad|terminad|cerrad)' AND saas.match_text(${alias}.opening_status)!~'(cerrad)'`);
  const text=`saas.match_text(concat_ws(' ',${['reference','process_name','description','entity_name','department','city','procurement_method','contract_type'].map(c=>alias+'.'+c).join(',')}))`;
  const any=array(f.keywords_any),all=array(f.keywords_all),excluded=array(f.excluded_keywords);
  if(any.length)conditions.push('('+any.map(v=>`position(${bind(normalize(v))} in ${text})>0`).join(' OR ')+')');
  for(const v of all)conditions.push(`position(${bind(normalize(v))} in ${text})>0`);
  for(const v of excluded)conditions.push(`position(${bind(normalize(v))} in ${text})=0`);
  return '('+conditions.join(' AND ')+')';
 }).join(' OR ')||'FALSE';
}
export const latestMatchesCte=`WITH latest_matches AS (
 SELECT DISTINCT ON (pm.process_id) pm.id,pm.organization_id,pm.process_id,pm.search_profile_id,pm.match_score,pm.match_status,
 pm.matched_reasons,pm.first_matched_at,pm.last_matched_at,pm.viewed_at,pm.created_at
 FROM secop.processes candidate JOIN saas.process_matches pm ON pm.process_id=candidate.id
 WHERE pm.organization_id=$1 AND (/*PROFILE_FILTERS*/)
 ORDER BY pm.process_id,pm.match_score DESC NULLS LAST,pm.last_matched_at DESC NULLS LAST,pm.created_at DESC,pm.id
)`;
export async function opportunityQuery(sql,parameters=[]){
 if(!sql.includes('/*PROFILE_FILTERS*/'))return boundedQuery(sql,parameters);
 const profiles=await boundedQuery('SELECT id,is_active,filter_config FROM saas.search_profiles WHERE organization_id=$1 AND is_active=TRUE',[parameters[0]]);
 const values=[...parameters];const predicate=compileProfileFilters(profiles.rows,values);
 return boundedQuery(sql.replace('/*PROFILE_FILTERS*/',predicate),values);
}
