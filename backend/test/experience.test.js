import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:5432/test';
const {documentState}=await import('../src/services/document-readiness.js');
const {inspectTemplate,renderTemplate}=await import('../src/services/template-renderer.js');
const {inspectDocxBlanks,fillDocxBlanks}=await import('../src/services/annex-fields.js');
test('un documento cargado no se presenta como validado, y los vencidos prevalecen',()=>{
 assert.equal(documentState(null),'missing');
 assert.equal(documentState({extraction_status:'extracted',review_status:'pending'}),'pending_review');
 assert.equal(documentState({extraction_status:'processing'}),'processing');
 assert.equal(documentState({extraction_status:'success',verification_status:'verified'}),'available');
 assert.equal(documentState({expiration_date:'2020-01-01',verification_status:'verified'}),'expired');
});
test('DOCX conserva el texto contractual y llena solo el espacio identificado, escapando XML',()=>{
 const original='<w:document><w:p><w:r><w:t>Razón social: __________</w:t></w:r></w:p><w:p><w:r><w:t>Obligación sin cambios.</w:t></w:r></w:p></w:document>';
 const fields=inspectDocxBlanks(original);assert.equal(fields.length,1);assert.equal(fields[0].suggested_source,'legal_name');
 const issues=[];const filled=fillDocxBlanks(original,fields,{legal_name:'Empresa A & B'},{[fields[0].name]:'legal_name'},issues);
 assert.ok(filled.includes('Empresa A &amp; B'));assert.ok(filled.includes('Obligación sin cambios.'));assert.equal(issues.length,0);
 const missing=[];assert.equal(fillDocxBlanks(original,fields,{}, {},missing),original);assert.equal(missing[0].code,'required_value_missing');
});
test('un PDF sin campos queda pendiente, los campos superpuestos se deben revisar',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([600,800]);const buffer=Buffer.from(await pdf.save());
 assert.deepEqual(await inspectTemplate(buffer,'pdf_form'),[]);
 const unchanged=await renderTemplate({buffer,templateType:'pdf_form',values:{}});assert.equal(unchanged.issues[0].code,'no_fillable_fields');
 const out=await renderTemplate({buffer,templateType:'pdf_form',values:{legal_name:'Empresa de prueba'},mapping:{company:'legal_name'},fieldSchema:[{name:'company',type:'pdf_overlay',required:true,page:1,x:50,y:100}]});
 assert.ok(out.issues.some(i=>i.code==='review_overlay_position'));assert.equal((await PDFDocument.load(out.buffer)).getPageCount(),1);
 const invalid=await renderTemplate({buffer,templateType:'pdf_form',values:{company:'Texto'},fieldSchema:[{name:'company',type:'pdf_overlay',page:999,x:50,y:100}]});assert.ok(invalid.issues.some(i=>i.code==='invalid_position'));
});
test('consulta autenticada de Bold rechaza datos de otra orden y otro ambiente',async()=>{
 const {config}=await import('../src/config.js');const {fetchBoldLink}=await import('../src/services/bold.js');
 const original=globalThis.fetch;
 const order={provider_link_id:'LNK_TEST',reference:'REF_TEST',amount_cop:250000};
 const valid={id:'LNK_TEST',reference:'REF_TEST',total:250000,currency:'COP',is_sandbox:config.boldEnvironment==='test',status:'ACTIVE'};
 try {
  globalThis.fetch=async()=>({ok:true,json:async()=>valid});assert.equal((await fetchBoldLink(order)).status,'ACTIVE');
  for(const change of [{id:'LNK_OTHER'},{reference:'REF_OTHER'},{total:1},{currency:'USD'},{is_sandbox:!valid.is_sandbox}]){
   globalThis.fetch=async()=>({ok:true,json:async()=>({...valid,...change})});await assert.rejects(fetchBoldLink(order));
  }
 }finally{globalThis.fetch=original;}
});
