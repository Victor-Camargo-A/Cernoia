import {completePublicText} from './public-document-text.js';
import {PDFDocument} from "pdf-lib";
import {pool,query} from '../db.js';
import {config} from '../config.js';
import {extractDocumentText} from './document-extractor.js';
import {scanForMalware} from './malware-scanner.js';
import {storeDocument,validateUploadedFile,removeStoredDocument} from './document-storage.js';
import {inspectTemplate} from './template-renderer.js';
import {analyzePublicChunk} from './process-knowledge-ai.js';
import {KNOWLEDGE_VERSION,hash,documentVersion,manifestFingerprint,publicFileUrl,splitPublicText,mergePublicChunks,knowledgeFailureState} from './process-knowledge-rules.js';

export async function processSources(processId){return (await query(`SELECT id,file_name,file_extension,file_size_bytes,uploaded_at,sha256,download_url,download_url_text FROM secop.process_documents WHERE process_id=$1 ORDER BY id LIMIT 201`,[processId])).rows;}
export async function ensurePublicMatrix(processId){
 const documents=await processSources(processId);if(documents.length>200)throw Object.assign(Error('El proceso tiene más de 200 documentos. Requiere revisión del inventario antes de prepararlo.'),{statusCode:422});
 const fingerprint=manifestFingerprint(documents);const ids=[];
 for(const d of documents){const result=await query(`INSERT INTO secop.public_document_insights(process_document_id,source_version,prompt_version,filename) VALUES($1,$2,$3,$4)
 ON CONFLICT(process_document_id,source_version,prompt_version) DO UPDATE SET filename=EXCLUDED.filename RETURNING id,status,verified_at`,[d.id,documentVersion(d),KNOWLEDGE_VERSION,d.file_name]);const row=result.rows[0];ids.push(row.id);
  if(row.status==='ready'&&Date.now()-new Date(row.verified_at).getTime()>86400000)await query("UPDATE secop.public_document_insights SET status='queued',next_attempt_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='ready'",[row.id]);
 }
 const existing=(await query(`SELECT id,status FROM secop.public_process_matrices WHERE process_id=$1 AND source_fingerprint=$2 AND prompt_version=$3`,[processId,fingerprint,KNOWLEDGE_VERSION])).rows[0];
 const matrix=(await query(`INSERT INTO secop.public_process_matrices(process_id,source_fingerprint,prompt_version,document_ids,status) VALUES($1,$2,$3,$4::jsonb,$5)
 ON CONFLICT(process_id,source_fingerprint,prompt_version) DO UPDATE SET document_ids=EXCLUDED.document_ids,updated_at=NOW() RETURNING *`,[processId,fingerprint,KNOWLEDGE_VERSION,JSON.stringify(ids),ids.length?'queued':'incomplete'])).rows[0];
 await updateMatrixStatus(matrix.id);return {...matrix,reused:!!existing};
}
async function updateMatrixStatus(id){await query(`UPDATE secop.public_process_matrices m SET status=CASE
 WHEN jsonb_array_length(document_ids)=0 THEN 'incomplete'
 WHEN EXISTS(SELECT 1 FROM secop.public_document_insights i WHERE i.id::text IN (SELECT jsonb_array_elements_text(m.document_ids)) AND i.status IN ('queued','processing')) THEN 'processing'
 WHEN EXISTS(SELECT 1 FROM secop.public_document_insights i WHERE i.id::text IN (SELECT jsonb_array_elements_text(m.document_ids)) AND i.status='error') THEN 'incomplete' ELSE 'ready' END,updated_at=NOW() WHERE id=$1`,[id]);}
export async function readPublicMatrix(id){
 const matrix=(await query('SELECT id,process_id,source_fingerprint,status,created_at,updated_at FROM secop.public_process_matrices WHERE id=$1',[id])).rows[0];if(!matrix)return null;
 const docs=(await query(`SELECT i.id,i.process_document_id,i.source_version,i.content_hash,i.status,i.document_role,i.filename,i.mime_type,i.summary,i.facts,i.error_message,i.verified_at,
 d.download_url,d.download_url_text FROM secop.public_document_insights i JOIN secop.process_documents d ON d.id=i.process_document_id WHERE i.id::text IN (SELECT jsonb_array_elements_text(document_ids) FROM secop.public_process_matrices WHERE id=$1) ORDER BY i.filename,i.id`,[id])).rows;
 return {...matrix,documents:docs.map(({download_url,download_url_text,...d})=>({...d,source_url:publicFileUrl({download_url,download_url_text})})),revision_hash:hash(docs.map(d=>[d.id,d.content_hash,d.status]))};
}
export async function reusableProcessContext(processId){
 const docs=await processSources(processId);const fingerprint=manifestFingerprint(docs);
 const row=(await query(`SELECT id FROM secop.public_process_matrices WHERE process_id=$1 AND source_fingerprint=$2 AND prompt_version=$3 AND status='ready'`,[processId,fingerprint,KNOWLEDGE_VERSION])).rows[0];
 if(!row)return null;const matrix=await readPublicMatrix(row.id);
 if(matrix.documents.some(d=>!d.verified_at||Date.now()-new Date(d.verified_at).getTime()>86400000))return null;
 return {id:matrix.id,status:'ready',revision_hash:matrix.revision_hash,source:'Documentos públicos SECOP. Reutilizar estas citas; no volver a extraer los mismos documentos.',documents:matrix.documents.map(d=>({document_id:d.process_document_id,document_name:d.filename,role:d.document_role,facts:d.facts,source_url:d.source_url}))};
}
export async function downloadPublic(d){
 const source=publicFileUrl(d);if(!source)throw Object.assign(Error('El inventario no contiene un enlace oficial de descarga válido.'),{permanent:true});
 let url=new URL(source);const signal=AbortSignal.timeout(30000);let response;
 for(let hop=0;hop<4;hop++){
  if(url.protocol!=='https:'||url.hostname!=='community.secop.gov.co'||url.port||url.username||url.password||url.pathname!=='/Public/Archive/RetrieveFile/Index')throw Object.assign(Error('SECOP requiere consulta manual para descargar este archivo.'),{permanent:true});
  response=await fetch(url,{redirect:'manual',signal});
  if(response.status>=300&&response.status<400){await response.body?.cancel();url=new URL(response.headers.get('location'),url);continue;}break;
 }
 if(!response?.ok)throw Error('SECOP no entregó el documento público.');
 const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>config.documentUploadMaxBytes)throw Object.assign(Error('El documento excede el tamaño permitido.'),{permanent:true});parts.push(chunk);}return Buffer.concat(parts);
}
export async function processNextKnowledgeJob(){
 const client=await pool.connect();let locked=false;
 try{
  locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('public-process-knowledge-v1')) AS locked")).rows[0].locked;if(!locked)return null;
  const job=(await client.query(`SELECT i.*,d.file_name,d.file_extension,d.download_url,d.download_url_text FROM secop.public_document_insights i JOIN secop.process_documents d ON d.id=i.process_document_id
 WHERE (i.status='queued' OR (i.status='processing' AND i.updated_at<NOW()-INTERVAL '5 minutes')) AND i.next_attempt_at<=NOW()
 AND EXISTS(SELECT 1 FROM secop.public_process_matrices m WHERE m.document_ids ? i.id::text)
 ORDER BY CASE WHEN EXISTS(SELECT 1 FROM saas.opportunity_preparations prep JOIN secop.public_process_matrices pm ON pm.id=prep.matrix_id WHERE prep.status='reading' AND pm.document_ids ? i.id::text) THEN 0 ELSE 1 END,i.next_attempt_at,i.id LIMIT 1`)).rows[0];if(!job)return null;
  await client.query("UPDATE secop.public_document_insights SET status='processing',updated_at=NOW() WHERE id=$1",[job.id]);
  try{
   let text=job.extracted_text,chunks=job.chunks,fields=job.field_schema;
   // Revalidate an immutable public source before using an old cached analysis.
   if(!job.storage_key||!job.verified_at||Date.now()-new Date(job.verified_at).getTime()>86400000){
    const buffer=await downloadPublic(job);let filename=job.file_name||'documento';if(!/\.[a-z0-9]{2,5}$/i.test(filename))filename+='.'+String(job.file_extension||'pdf').replace(/^\./,'');
    await scanForMalware(buffer);const contentHash=hash(buffer);
    if(contentHash!==job.content_hash||!text){
     const extracted=await completePublicText(buffer,filename);text=extracted.text;
     fields=extracted.extension==='.zip'||extracted.extension==='.xlsm'?[]:await inspectTemplate(buffer,extracted.extension==='.docx'?'docx':extracted.extension==='.xlsx'?'xlsx':'pdf_form');chunks={};
     const validation={extension:extracted.extension,mime:extracted.mime};
     const stored=await storeDocument({organizationId:'public-processes',extension:validation.extension,buffer});
     await client.query(`UPDATE secop.public_document_insights SET content_hash=$2,storage_key=$3,filename=$4,mime_type=$5,extracted_text=$6,chunks='{}',field_schema=$7::jsonb,facts='[]',verified_at=NOW(),updated_at=NOW() WHERE id=$1`,[job.id,contentHash,stored.relativeKey,filename,validation.mime,text,JSON.stringify(fields)]);
     // Old public content remains encrypted until it is no longer referenced by private templates.
    }else await client.query('UPDATE secop.public_document_insights SET verified_at=NOW() WHERE id=$1',[job.id]);
   }
   const parts=splitPublicText(text);const index=parts.findIndex((part,i)=>!chunks[hash([i,part])]);
   if(index>=0){const key=hash([index,parts[index]]);chunks={...chunks,[key]:await analyzePublicChunk({text:parts[index],filename:job.filename,requestId:`public-${job.id}-${index}`})};await client.query('UPDATE secop.public_document_insights SET chunks=$2::jsonb,updated_at=NOW() WHERE id=$1',[job.id,JSON.stringify(chunks)]);}
   const complete=parts.every((part,i)=>chunks[hash([i,part])]);
   if(complete){const result=mergePublicChunks(chunks,fields);if(/\.zip$/i.test(job.filename)){result.document_role='informative';result.summary='Archivo contenedor: consulta y prepara sus formatos individuales en la lista de anexos.\n'+result.summary;}await client.query(`UPDATE secop.public_document_insights SET status='ready',document_role=$2,summary=$3,facts=$4::jsonb,error_message=NULL,attempts=0,updated_at=NOW() WHERE id=$1`,[job.id,result.document_role,result.summary,JSON.stringify(result.facts)]);}
   else await client.query("UPDATE secop.public_document_insights SET status='queued',next_attempt_at=NOW(),updated_at=NOW() WHERE id=$1",[job.id]);
   return {id:job.id,complete};
  }catch(error){const retry=knowledgeFailureState(error,job.attempts);await client.query(`UPDATE secop.public_document_insights SET status=$2,error_message=$3,attempts=$4,next_attempt_at=NOW()+($5::int*INTERVAL '1 second'),updated_at=NOW() WHERE id=$1`,[job.id,retry.status,String(error.message).slice(0,500),retry.attempts,retry.retryAfter]);return {id:job.id,error:true};}
  finally{const matrices=(await client.query('SELECT id FROM secop.public_process_matrices WHERE document_ids ? $1',[job.id])).rows;for(const m of matrices)await updateMatrixStatus(m.id);}
 }finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('public-process-knowledge-v1'))").catch(()=>{});client.release();}
}
export async function refreshActiveBidMatrices(){
 const rows=(await query("SELECT DISTINCT w.process_id FROM saas.bid_workspaces w JOIN secop.public_process_matrices m ON m.id=w.matrix_id WHERE w.updated_at>NOW()-INTERVAL '30 days' AND m.prompt_version='public-process-v2' LIMIT 200")).rows;
 for(const row of rows){try{const matrix=await ensurePublicMatrix(row.process_id);await query('UPDATE saas.bid_workspaces SET matrix_id=$2 WHERE process_id=$1 AND matrix_id IS DISTINCT FROM $2',[row.process_id,matrix.id]);}catch{}}
}
