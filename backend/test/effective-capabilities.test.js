import test from 'node:test';import assert from 'node:assert/strict';
process.env.DATABASE_URL??='postgres://unused:unused@localhost/unused';
const {deriveCapabilities,effectiveCapabilities}=await import('../src/services/effective-capabilities.js');
const fact=(id,document,capability)=>({id,document_id:document,scope:'company',attribute:'contracted_experience',evidence_status:'document_supported',capability,value:'Contrato de consultoría '+capability});
test('each company receives only UNSPSC suggestions backed by its own facts',()=>{
 const a=fact('a','doc-a','Consultoría energética'),b=fact('b','doc-b','Desarrollo de software');
 const suggestions=[{code:'81101516',fact_ids:['a']},{code:'81111500',fact_ids:['b']},{code:'00000000',fact_ids:[]}];
 assert.deepEqual(deriveCapabilities({}, {facts:[a]}, {suggestions}).unspsc_codes,['81101516']);
 assert.deepEqual(deriveCapabilities({}, {facts:[b]}, {suggestions}).unspsc_codes,['81111500']);
 assert.deepEqual(deriveCapabilities({}, {facts:[]}, {suggestions}).unspsc_codes,[]);
 assert.deepEqual(deriveCapabilities({}, {facts:[{...a,evidence_status:'expired'}]}, {suggestions}).unspsc_codes,[]);
});
test('national coverage is default, client overrides and UNSPSC choices persist',()=>{
 const matrix={facts:[fact('a','doc-a','Consultoría energética')]};
 assert.deepEqual(deriveCapabilities({},matrix).service_departments,['Nacional']);
 const declared={service_departments:['Antioquia'],unspsc_codes:['81111500'],matrix_field_modes:{service_departments:'manual',unspsc_codes:'manual'}};
 const r=deriveCapabilities(declared,matrix,{suggestions:[{code:'81101516',fact_ids:['a']}]});
 assert.deepEqual(r.service_departments,['Antioquia']);assert.deepEqual(r.unspsc_codes,['81111500']);assert.equal(r.maximum_contract_value,null);
});
test('organization identifier scopes both matrix and classification queries',async()=>{
 const seen=[];const execute=async(sql,args)=>{seen.push(args);return {rows:sql.includes('company_matrix_analysis_context')?[{profile:{},matrix:{facts:[fact('company-a','doc','Consultoría')]}}]:[{status:'ready',suggestions:[{code:'81101516',fact_ids:['other-company']}]}]};};
 const result=await effectiveCapabilities('company-a',execute);assert.deepEqual(seen,[['company-a'],['company-a']]);assert.deepEqual(result.unspsc_codes,[]);
});
