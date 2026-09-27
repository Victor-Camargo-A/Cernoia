import {mock} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {pool,authPool} from '../src/db.js';
const c=await pool.connect(),org=randomUUID(),id=randomUUID();
const text='Certificado bancario. Se expide en Bogotá el día 22 de septiembre del año 2026.';
mock.module('../src/db.js',{namedExports:{pool:{query:(sql,args)=>c.query(sql.includes('WITH next AS')?sql.replace("SELECT id FROM saas.organization_documents WHERE",`SELECT id FROM saas.organization_documents WHERE id='${id}' AND`):sql,args)},withTenantTransaction:async(o,fn)=>{assert.equal(o,org);return fn(c);}}});
mock.module('../src/services/document-metadata-ai.js',{namedExports:{METADATA_VERSION:'test-v1',extractSemanticMetadata:async()=>({document_type:'bank_certificate',document_type_label:'Certificado bancario',type_quote:'Certificado bancario',type_confidence:'high',issue_date:'2026-09-22',issue_quote:'Se expide en Bogotá el día 22 de septiembre del año 2026.',issue_confidence:'high',expiration_kind:'not_stated',expiration_date:null})}});
const {processNextMetadataJob}=await import('../src/services/document-metadata-jobs.js');
try{
 await c.query('BEGIN');await c.query('INSERT INTO saas.organizations(id,name,slug) VALUES($1,$2,$3)',[org,'Metadata transaction fixture','metadata-test-'+org]);
 await c.query(`INSERT INTO saas.organization_documents(id,organization_id,document_type,document_name,original_filename,extracted_text,extraction_status,review_status,ai_classification) VALUES($1,$2,'other_document','scan','scan.pdf',$3,'extracted','corrected','{"metadata_status":"queued"}')`,[id,org,text]);
 const outcome=await processNextMetadataJob();assert.equal(outcome.status,'complete',JSON.stringify(outcome));
 const row=(await c.query('SELECT * FROM saas.organization_documents WHERE id=$1',[id])).rows[0];
 assert.equal(row.document_type,'bank_certificate');assert.equal(row.issue_date.toISOString().slice(0,10),'2026-09-22');assert.equal(row.expiration_date,null);assert.equal(row.ai_classification.metadata_status,'complete');assert.equal(row.ai_classification.document_type_label,'Certificado bancario');
 const review=(await c.query('SELECT * FROM saas.document_extraction_reviews WHERE organization_document_id=$1',[id])).rows[0];assert.equal(review.proposed_values.issue_date,'2026-09-22');assert.equal(review.proposed_values.document_type,'bank_certificate');
 assert.ok((await c.query('SELECT requested_revision FROM saas.company_matrix_state WHERE organization_id=$1',[org])).rowCount);
 console.log('PASS metadata job SQL, placeholder correction, separate dates, review proposals, matrix update; transaction rolled back');
}finally{await c.query('ROLLBACK');c.release();await Promise.all([pool.end(),authPool.end()]);}
