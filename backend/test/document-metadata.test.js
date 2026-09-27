import test from 'node:test';
import assert from 'node:assert/strict';
import {inferDocumentMetadata as infer} from '../src/services/document-metadata.js';
const doc={document_type:'auto_detect',document_name:'scan-001'};
test('individual names and distinct dates from OCR',()=>{
 const result=infer('REGISTRO ÚNICO TRIBUTARIO\nFecha de expedición: 23 de septiembre de 2026\nFecha de vencimiento: 30/12/2026',doc);
 assert.equal(result.document_type,'rut');assert.equal(result.issue_date,'2026-09-23');assert.equal(result.expiration_date,'2026-12-30');assert.equal(result.requires_review,false);assert.match(result.document_name,/Tributario — 2026-09-23/);
});
test('missing issue is never replaced by expiry or upload date',()=>{
 const result=infer('Registro Único Tributario\nFecha de vencimiento: 2026-12-30',doc);
 assert.equal(result.issue_date,null);assert.equal(result.requires_review,true);
});
test('conflicting and invalid dates require review',()=>{
 for(const text of ['Fecha de expedición: 31/02/2026','Fecha de expedición: 01/02/2026\nFecha de expedición: 02/02/2026']){
 const result=infer('Registro Único Tributario\n'+text,doc);assert.equal(result.issue_date,null);assert.equal(result.requires_review,true);
 }
});
test('no invented expiry and user date preserved',()=>{
 const result=infer('Registro Único Tributario\nFecha de expedición: 01/02/2026',{...doc,issue_date:'2026-02-03'});
 assert.equal(result.issue_date,'2026-02-03');assert.equal(result.expiration_date,null);
});
test('expiry before issue and unknown types are flagged',()=>{
 assert.equal(infer('Registro Único Tributario\nFecha de expedición: 2026-03-01\nVigencia hasta: 2026-02-01',doc).requires_review,true);
 assert.equal(infer('Texto sin título documental reconocible',doc).document_name,'scan-001');
});
