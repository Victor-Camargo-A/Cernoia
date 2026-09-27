import {mock} from 'node:test';import assert from 'node:assert/strict';
process.env.COMPANY_MATRIX_AI_KEY_FILE='/test/nonsecret-credential';
mock.module('node:fs/promises',{namedExports:{readFile:async()=>JSON.stringify({apiKey:'test-key'})}});
let calls=0;const row={dimension:'legal',attribute:'registration',value:'Inscrito',evidence_quote:'Estado: Inscrito en el registro',scope:'person',confidence:'high'};
mock.module('../src/services/provider-errors.mjs',{namedExports:{providerError:()=>new Error('unexpected'),quotaFetch:async(url,options)=>{calls++;const body=JSON.parse(options.body);if(calls===2)assert.match(body.systemInstruction.parts[0].text,/REINTENTO/);return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({facts:[{...row,value:calls===1?'Afirmación no respaldada':row.value}]})}]}}]})};}}});
const {extractCompanyFacts}=await import('../src/services/company-matrix-ai.js');const {validateExtractedFacts}=await import('../src/services/company-matrix-rules.js');
const document={id:'test',document_type:'victim_certificate',document_name:'fixture'};const chunk={index:0,text:row.evidence_quote};
const result=await extractCompanyFacts({organization:{name:'fixture'},document,chunk});assert.equal(calls,2);assert.equal(validateExtractedFacts(result,chunk.text,document).facts.length,1);console.log('PASS retries unsupported quotations once and retains strict evidence validation');
