import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const dir=new URL('../../n8n/workflows/',import.meta.url);const file=fs.readdirSync(dir).find(n=>n.startsWith('WF-008'));const workflow=JSON.parse(fs.readFileSync(new URL(file,dir),'utf8'));
const code=workflow.nodes.find(n=>n.name==='Normalizar resultado IA WF-008').parameters.jsCode;
const normalize=new Function('$','$json',code);
function run(patch={},ids=['fact-one']){
 const matrix={revision:31,version_id:'version-31',as_of_date:'2026-09-15',can_analyze:true,facts:[{id:'fact-one',evidence_status:'document_supported',scope:'company',conflict:false,...patch}]};
 return normalize(()=>({item:{json:{analysis_id:'analysis',capability_snapshot:{company_matrix:matrix}}}}),{output:{decision:'revisar',compatibility_score:55,confidence_score:40,executive_summary:'Revisión',human_review_required:false,company_matrix_used:{revision:999},possible_requirements:[{requirement:'Experiencia',assessment:'cumple',evidence:'Soporte',matrix_fact_ids:ids}]}}).json;
}
test('actual workflow preserves valid references and captures the real matrix version',()=>{const r=run();assert.equal(r.ai_ok,true);assert.equal(r.ai_result.company_matrix_used.revision,31);assert.equal(r.ai_result.human_review_required,true);assert.equal(r.ai_result.possible_requirements[0].assessment,'cumple');});
test('expired, declared, conflicting and third-party facts cannot confirm compliance',()=>{for(const patch of [{evidence_status:'expired'},{evidence_status:'declared'},{conflict:true},{scope:'third_party'},{scope:'person'}]){const r=run(patch);assert.equal(r.ai_ok,true);assert.equal(r.ai_result.possible_requirements[0].assessment,'por_verificar');assert.ok(r.ai_result.evidence_validation.warnings.length);}});
test('unsupported compliance becomes unverified and invented references reject the result',()=>{assert.equal(run({},[]).ai_result.possible_requirements[0].assessment,'por_verificar');assert.equal(run({},['invented']).ai_ok,false);});
test('the prompt tells the actual agent to use matrix references, status and scope',()=>{const s=workflow.nodes.find(n=>n.name==='Preparar entrada IA WF-008').parameters.jsCode;for(const text of ['company_matrix','matrix_fact_ids','expired','scope company','declaraciones'])assert.ok(s.includes(text));});
