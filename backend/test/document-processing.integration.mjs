import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db.js';
const client=await pool.connect();
const org=randomUUID(), id=randomUUID();
let text='Registro Único Tributario\nFecha de expedición: 23/09/2026\nFecha de vencimiento: 30/12/2026';
mock.module('../src/db.js',{namedExports:{query:(sql,args)=>client.query(sql,args)}});
mock.module('../src/services/document-storage.js',{namedExports:{readStoredDocument:async()=>Buffer.from('fixture')}});
mock.module('../src/services/document-extractor.js',{namedExports:{extractDocumentText:async()=>({text,method:'fixture',ocrStatus:'not_needed',confidence:null})}});
const {processOrganizationDocument}=await import('../src/services/document-processing.js');
try {
 await client.query('BEGIN');
 await client.query('INSERT INTO saas.organizations(id,name,slug) VALUES($1,$2,$3)',[org,'Document metadata test','test-'+org]);
 await client.query(`INSERT INTO saas.organization_documents(id,organization_id,document_type,document_name,document_status,storage_key) VALUES($1,$2,'auto_detect','scan-001','uploaded','fixture')`,[id,org]);
 await processOrganizationDocument(id,org);
 let doc=(await client.query('SELECT * FROM saas.organization_documents WHERE id=$1',[id])).rows[0];
 assert.equal(doc.document_type,'rut');assert.equal(doc.review_status,'approved');assert.match(doc.document_name,/2026-09-23/);assert.equal(doc.issue_date.toISOString().slice(0,10),'2026-09-23');
 assert.equal((await client.query('SELECT status FROM saas.document_extraction_reviews WHERE organization_document_id=$1',[id])).rows[0].status,'approved');
 const revision=(await client.query('SELECT requested_revision FROM saas.company_matrix_state WHERE organization_id=$1',[org])).rows[0].requested_revision;
 await client.query("UPDATE saas.organization_documents SET review_status='corrected',document_name='Nombre manual',issue_date='2026-09-22' WHERE id=$1",[id]);
 await processOrganizationDocument(id,org);
 doc=(await client.query('SELECT * FROM saas.organization_documents WHERE id=$1',[id])).rows[0];
 assert.equal(doc.document_name,'Nombre manual');assert.equal(doc.review_status,'corrected');assert.equal(doc.extraction_status,'extracted');
 assert.ok(BigInt((await client.query('SELECT requested_revision FROM saas.company_matrix_state WHERE organization_id=$1',[org])).rows[0].requested_revision)>BigInt(revision));
 await assert.rejects(processOrganizationDocument(id,randomUUID()),/Documento no encontrado/);
 console.log('PASS SQL persistence, automatic metadata, preserved corrections, tenant isolation, matrix revision');
} finally {await client.query('ROLLBACK');client.release();await pool.end();}
