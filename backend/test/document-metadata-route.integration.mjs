import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {pool} from '../src/db.js';
const client=await pool.connect(), org=randomUUID(), id=randomUUID(), uid=randomUUID();
let tenant=org;
mock.module('../src/db.js',{namedExports:{query:(sql,args)=>client.query(sql,args)}});
mock.module('../src/middleware/auth.js',{namedExports:{requireAuth:(req,res,next)=>{req.user={organization_id:tenant,id:uid};next();},requireRole:()=> (req,res,next)=>next()}});
mock.module('../src/audit.js',{namedExports:{writeAudit:async()=>{}}});
mock.module('../src/services/n8n.js',{namedExports:{runWorkflow:async()=>{}}});
const {documentsRouter}=await import('../src/routes/documents.js');
const app=express();app.use(express.json());app.use(documentsRouter);app.use((error,req,res,next)=>res.status(500).json({error:error.message}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
async function patch(body){return fetch(`http://127.0.0.1:${server.address().port}/documents/${id}/metadata`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
try {
 await client.query('BEGIN');
 await client.query('INSERT INTO saas.organizations(id,name,slug) VALUES($1,$2,$3)',[org,'Document edit test','test-'+org]);
 await client.query(`INSERT INTO saas.organization_documents(id,organization_id,document_type,document_name,document_status) VALUES($1,$2,'rut','scan','uploaded')`,[id,org]);
 const body={document_name:'RUT actualizado',document_type:'rut',issue_date:'2026-09-22',expiration_date:''};
 let response=await patch(body);assert.equal(response.status,200,await response.text());
 const doc=(await client.query('SELECT document_name,review_status,expiration_date,metadata,ai_classification FROM saas.organization_documents WHERE id=$1',[id])).rows[0];
 assert.equal(doc.document_name,body.document_name);assert.equal(doc.review_status,'corrected');assert.equal(doc.expiration_date,null);assert.ok(doc.metadata.manual_metadata_fields.includes('issue_date'));assert.ok(doc.metadata.manual_metadata_fields.includes('document_name'));assert.ok(!doc.metadata.manual_metadata_fields.includes('expiration_date'));
 assert.equal((await patch({...body,expiration_date:'2026-09-01'})).status,400);
 assert.equal((await patch({...body,issue_date:'2026-02-30'})).status,400);
 tenant=randomUUID();assert.equal((await patch(body)).status,404);tenant=org;
 await client.query("UPDATE saas.organization_documents SET document_status='deleted' WHERE id=$1",[id]);
 assert.equal((await patch(body)).status,404);
 console.log('PASS HTTP edit, date validation, tenant isolation, deleted document protection');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await client.query('ROLLBACK');client.release();await pool.end();}
