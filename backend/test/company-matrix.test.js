import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExtractedFacts,assembleCompanyMatrix,sourceFingerprint,splitDocument} from '../src/services/company-matrix-rules.js';
const doc={id:'one',document_name:'Certificado',document_status:'active',review_status:'pending',matrix_source_version:1,has_file:true,has_text:true};
const text='La empresa Solar SAS ejecutó instalación de paneles solares por 100 pesos en 2025.';
const fact={evidence_kind:'execution_record',dimension:'experience',attribute:'completed_experience',label:'Experiencia',subject:'Solar SAS',scope:'company',value:'instalación de paneles solares',evidence_quote:text,confidence:'high',period:'2025',capability:'Instalación de paneles solares'};
const checked=()=>validateExtractedFacts({facts:[fact]},text,doc).facts;
const inventory=(patch={})=>[{...doc,...patch,source_fingerprint:sourceFingerprint({...doc,...patch})}];
test('rejects invented citations and paraphrases presented as literal facts',()=>{
 assert.equal(validateExtractedFacts({facts:[{...fact,value:'1000 pesos'},{...fact,evidence_quote:'La empresa instaló mil paneles solares.'}]},text,doc).rejected,2);
 assert.equal(checked().length,1);
});
test('new source versions, rejected and deleted documents immediately invalidate evidence',()=>{
 for(const patch of [{matrix_source_version:2},{review_status:'rejected'},{document_status:'deleted'},{malware_scan_status:'infected'}])assert.equal(assembleCompanyMatrix(checked(),inventory(patch)).facts.length,0);
});
test('expired, self-declared and third-party facts never become current company capabilities',()=>{
 for(const patch of [{evidence_kind:'company_declaration'},{scope:'third_party'},{valid_until:'2020-01-01'}])assert.deepEqual(assembleCompanyMatrix([{...checked()[0],...patch}],inventory()).documented_capabilities.products_services,[]);
 assert.equal(assembleCompanyMatrix(checked(),inventory()).documented_capabilities.products_services.length,1);
});
test('financial periods remain separate and contradictory tax IDs remain visible',()=>{
 const facts=validateExtractedFacts({facts:[{...fact,period:'2024'},{...fact,period:'2025'}]},text,doc).facts;assert.equal(facts.length,2);
 const rows=['123','456'].map((value,i)=>({...checked()[0],id:String(i),dimension:'identity',attribute:'tax_id',value}));
 const matrix=assembleCompanyMatrix(rows,inventory());assert.equal(matrix.conflicts.length,1);assert.ok(matrix.facts.every(f=>f.conflict));
});
test('chunking includes the entire document with overlaps',()=>{
 const text='abcdefghij'.repeat(10000);const chunks=splitDocument(text);assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).start+chunks.at(-1).text.length,text.length);
 for(let i=1;i<chunks.length;i++)assert.equal(chunks[i-1].text.slice(-800),chunks[i].text.slice(0,800));
});

test('Postgres DATE objects retain expiry semantics',()=>{assert.equal(assembleCompanyMatrix(checked(),inventory({expiration_date:new Date('2020-01-01T00:00:00Z')})).facts[0].evidence_status,'expired');});
