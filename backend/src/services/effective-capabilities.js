import {boundedQuery as query} from '../db.js';
export const capabilityFields=['company_summary','products_services','unspsc_codes','service_departments','procurement_methods','contract_types','minimum_contract_value','maximum_contract_value','years_experience'];
const array=v=>Array.isArray(v)?v:[];const unique=v=>[...new Set(v.filter(Boolean))];
const normal=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function deriveCapabilities(declared={},matrix={},classification={}){
 const facts=array(matrix.facts).filter(f=>f.scope==='company'&&f.evidence_status==='document_supported'&&!f.conflict);
 const services=facts.filter(f=>['service','completed_experience','contracted_experience'].includes(f.attribute));
 const products=unique(services.map(f=>f.capability));
 const types=unique(services.flatMap(f=>{const text=normal(f.value+' '+f.capability);return [...(/prestacion de servicios|servicios profesionales/.test(text)?['Prestación de servicios']:[]),...(/consultoria/.test(text)?['Consultoría']:[]),...(/suministro/.test(text)?['Suministro']:[]),...(/construccion|contrato de obra/.test(text)?['Obra']:[])];}));
 const suggested=(classification.suggestions??[]).filter(s=>s.fact_ids?.length&&s.fact_ids.every(id=>facts.some(f=>f.id===id)));
 const codes=unique(facts.filter(f=>f.attribute==='unspsc').flatMap(f=>[...String(f.value??'').matchAll(/\b\d{8}\b/g)].map(m=>m[0])));
 const amount=value=>{const s=String(value).replace(/[^\d.,]/g,'');const n=Number(/,\d{1,2}$/.test(s)?s.replace(/\./g,'').replace(',','.'):s.replace(/[.,]/g,''));return Number.isFinite(n)&&n>0?n:null;};
 const upper=facts.find(f=>f.attribute==='financial_metric'&&/capacidad maxima de contratacion|rango maximo de contratacion/.test(normal(f.label)));
 const lower=facts.find(f=>f.attribute==='financial_metric'&&/rango minimo de contratacion/.test(normal(f.label)));
 const automatic={company_summary:products.length?'Los documentos aportados identifican estas actividades: '+products.join('; ')+'. La experiencia ejecutada y la habilitación deben verificarse para cada proceso.':declared.company_summary??'',products_services:products,unspsc_codes:unique([...codes,...suggested.map(s=>s.code)]),service_departments:['Nacional'],procurement_methods:['Mínima cuantía'],contract_types:types,minimum_contract_value:lower?amount(lower.value):null,maximum_contract_value:upper?amount(upper.value):null,years_experience:null};
 const result={...declared},modes={};
 for(const field of capabilityFields){const value=declared[field],empty=value==null||value===''||(Array.isArray(value)&&!value.length)||(field==='products_services'&&array(value).every(v=>normal(v)==='servicios empresariales'))||(field==='company_summary'&&/Empresa en exploración de oportunidades/.test(value));
  modes[field]=declared.matrix_field_modes?.[field]??(empty?'auto':'manual');if(modes[field]==='auto')result[field]=automatic[field];
 }
 result.matrix_field_modes=modes;result.automatic_profile={values:automatic,unspsc_suggestions:suggested,unspsc_status:classification.status??"pending",document_ids:unique(facts.map(f=>f.document_id)),missing_fields:capabilityFields.filter(f=>modes[f]==='auto'&&(result[f]==null||(Array.isArray(result[f])&&!result[f].length))),message:'Cobertura nacional por defecto, editable. Las capacidades se completan con los documentos de tu empresa; los UNSPSC inferidos son sugerencias comerciales, no acreditación RUP. El rango solo se completa si existe evidencia explícita.'};
 result.is_ready_for_ai=String(result.company_summary??'').length>=40&&(array(result.products_services).length>0||array(result.unspsc_codes).length>0);return result;
}
export async function effectiveCapabilities(org,execute=query){
 const row=(await execute(`SELECT to_jsonb(c) AS profile,saas.company_matrix_analysis_context($1) AS matrix FROM saas.organization_capability_profiles c WHERE c.organization_id=$1 AND c.is_active ORDER BY c.updated_at DESC LIMIT 1`,[org])).rows[0];const classification=(await execute('SELECT status,suggestions FROM saas.company_unspsc_classifications WHERE organization_id=$1',[org])).rows[0]??{};return row?deriveCapabilities(row.profile,row.matrix,classification):null;
}
export async function refreshProcessScores(org,ids,execute=query){
 const cap=await effectiveCapabilities(org,execute);if(!cap)return;
 await execute(`WITH scored AS MATERIALIZED (SELECT m.id,saas.process_compatibility(to_jsonb(p)-'raw_json',$3::jsonb,sp.filter_config) AS result FROM saas.process_matches m JOIN secop.processes p ON p.id=m.process_id JOIN saas.search_profiles sp ON sp.id=m.search_profile_id WHERE m.organization_id=$1 AND m.process_id=ANY($2::uuid[])) UPDATE saas.process_matches m SET match_score=(scored.result->>'score')::numeric,matched_reasons=COALESCE(m.matched_reasons,'{}')||jsonb_build_object('compatibility',scored.result,'matrix_profile_applied',true),updated_at=NOW() FROM scored WHERE m.id=scored.id`,[org,ids,JSON.stringify(cap)]);
}
export async function persistEffectiveCapabilities(org){
 const c=await effectiveCapabilities(org);if(!c)return null;
 const values=[org,c.id,c.company_summary,JSON.stringify(c.products_services),JSON.stringify(c.unspsc_codes),JSON.stringify(c.service_departments),JSON.stringify(c.procurement_methods),JSON.stringify(c.contract_types),c.minimum_contract_value,c.maximum_contract_value,c.years_experience,JSON.stringify(c.matrix_field_modes),c.is_ready_for_ai,c.updated_at];
 await query(`UPDATE saas.organization_capability_profiles SET company_summary=$3,products_services=$4::jsonb,unspsc_codes=$5::jsonb,service_departments=$6::jsonb,procurement_methods=$7::jsonb,contract_types=$8::jsonb,minimum_contract_value=$9,maximum_contract_value=$10,years_experience=$11,matrix_field_modes=$12::jsonb,is_ready_for_ai=$13,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND updated_at=$14::timestamptz AND (company_summary,products_services,unspsc_codes,service_departments,procurement_methods,contract_types,minimum_contract_value,maximum_contract_value,years_experience,matrix_field_modes,is_ready_for_ai) IS DISTINCT FROM ($3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::numeric,$10::numeric,$11::numeric,$12::jsonb,$13)`,values);return c;
}
