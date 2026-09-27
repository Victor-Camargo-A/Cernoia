import {extname,basename} from 'node:path';
import PizZip from 'pizzip';
import {PDFDocument} from 'pdf-lib';
import {query,pool} from '../db.js';
import {config} from '../config.js';
import {downloadPublic} from './process-knowledge.js';
import {documentVersion,hash} from './process-knowledge-rules.js';
import {assertOpportunityAccess} from './bid-workspace.js';
import {scanForMalware} from './malware-scanner.js';
import {validateUploadedFile,readStoredDocument,storeDocument,removeStoredDocument,fileSha256} from './document-storage.js';
import {officeToPdf} from './document-preview.js';
const supported=new Set(['.pdf','.docx','.xlsx']);
export function archiveEntries(buffer){
 const zip=new PizZip(buffer);const entries=[];let total=0;
 for(const [name,file] of Object.entries(zip.files)){
  if(file.dir)continue;
  if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||/^[A-Za-z]:/.test(name)||(Number(file.unixPermissions)&0xf000)===0xa000)throw Object.assign(Error('El ZIP contiene rutas no admitidas.'),{statusCode:422});
  const size=file._data?.uncompressedSize??0;total+=size;
  if(size>config.documentUploadMaxBytes||total>80*1024*1024||entries.length>=100)throw Object.assign(Error('El ZIP supera el límite de 100 archivos o 80 MB descomprimidos.'),{statusCode:422});
  entries.push({id:hash(name),name,filename:basename(name),bytes:size,supported:supported.has(extname(name).toLowerCase())});
 }
 return entries;
}
export async function readSourcePreview(organizationId,id){
 const row=(await query('SELECT * FROM saas.source_document_previews WHERE id=$1 AND organization_id=$2',[id,organizationId])).rows[0];
 if(!row)throw Object.assign(Error('Documento no encontrado.'),{statusCode:404});
 if(row.process_id)await assertOpportunityAccess(organizationId,row.process_id);
 return row;
}
async function cachedSource(organizationId,kind,id,version){return (await query(`SELECT * FROM saas.source_document_previews WHERE organization_id=$1 AND source_kind=$2 AND source_id=$3 AND source_version=$4 AND (source_kind='template_version' OR created_at>NOW()-INTERVAL '24 hours')`,[organizationId,kind,id,version])).rows[0];}
async function createPreview({organizationId,kind,id,version,processId,filename,getBuffer}){
 const client=await pool.connect();const lock=`source-preview:${organizationId}:${kind}:${id}:${version}`;let locked=false;const created=[];
 try{
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[lock])).rows[0].locked;
  if(!locked)throw Object.assign(Error('El original se está preparando. Vuelve a abrirlo en unos segundos.'),{statusCode:409});
  const existing=await cachedSource(organizationId,kind,id,version);if(existing)return existing;
  const buffer=await getBuffer();if(buffer.length>config.documentUploadMaxBytes)throw Object.assign(Error('El archivo supera el límite de vista previa.'),{statusCode:413});
  await scanForMalware(buffer);
  const extension=extname(filename).toLowerCase();let pdf=null,mime,entries=[];
  if(extension==='.zip'){entries=archiveEntries(buffer);mime='application/zip';}
  else{
   const validation=validateUploadedFile(buffer,filename);
   if(!validation.valid||!supported.has(extension))throw Object.assign(Error('La vista previa admite PDF, DOCX, XLSX y ZIP de anexos.'),{statusCode:422});
   mime=validation.mime;pdf=extension==='.pdf'?buffer:await officeToPdf(buffer,extension);
  }
  const pages=pdf?(await PDFDocument.load(pdf)).getPageCount():0;
  if(pdf&&(!pages||pages>200))throw Object.assign(Error('La vista previa admite hasta 200 páginas.'),{statusCode:422});
  const original=await storeDocument({organizationId,extension,buffer});created.push(original.relativeKey);
  const rendered=pdf?await storeDocument({organizationId,extension:'.pdf',buffer:pdf}):null;if(rendered)created.push(rendered.relativeKey);
  const previous=(await client.query('SELECT original_storage_key,pdf_storage_key FROM saas.source_document_previews WHERE organization_id=$1 AND source_kind=$2 AND source_id=$3 AND source_version=$4',[organizationId,kind,id,version])).rows[0];
  const saved=(await client.query(`INSERT INTO saas.source_document_previews(organization_id,source_kind,source_id,source_version,process_id,original_filename,mime_type,source_hash,original_storage_key,pdf_storage_key,pdf_hash,page_count,archive_entries)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
  ON CONFLICT(organization_id,source_kind,source_id,source_version) DO UPDATE SET source_hash=EXCLUDED.source_hash,original_storage_key=EXCLUDED.original_storage_key,pdf_storage_key=EXCLUDED.pdf_storage_key,pdf_hash=EXCLUDED.pdf_hash,page_count=EXCLUDED.page_count,archive_entries=EXCLUDED.archive_entries,created_at=NOW() RETURNING *`,[organizationId,kind,id,version,processId,filename,mime,fileSha256(buffer),original.relativeKey,rendered?.relativeKey??null,pdf?fileSha256(pdf):null,pages,JSON.stringify(entries)])).rows[0];
  for(const key of [previous?.original_storage_key,previous?.pdf_storage_key])if(key)await removeStoredDocument(key).catch(()=>{});
  return saved;
 }catch(e){for(const key of created)await removeStoredDocument(key).catch(()=>{});throw e;}
 finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]).catch(()=>{});client.release();}
}
export async function previewProcessDocument(organizationId,processId,documentId){
 await assertOpportunityAccess(organizationId,processId);
 const doc=(await query(`SELECT d.* FROM secop.process_documents d WHERE d.process_id=$2 AND (d.id=$3 OR EXISTS(SELECT 1 FROM saas.opportunity_documents o WHERE o.id=$3 AND o.organization_id=$1 AND o.process_id=$2 AND o.process_document_id=d.id))`,[organizationId,processId,documentId])).rows[0];
 if(!doc)throw Object.assign(Error('Documento del proceso no encontrado.'),{statusCode:404});
 let filename=String(doc.file_name??'documento').trim();if(!extname(filename))filename+='.'+String(doc.file_extension??'pdf').replace(/^\./,'');
 return createPreview({organizationId,kind:'process_document',id:doc.id,version:documentVersion(doc),processId,filename,getBuffer:()=>downloadPublic(doc)});
}
export async function previewTemplateVersion(organizationId,versionId){
 const version=(await query(`SELECT v.*,t.process_id FROM saas.document_template_versions v JOIN saas.document_templates t ON t.id=v.template_id AND t.organization_id=v.organization_id WHERE v.id=$1 AND v.organization_id=$2`,[versionId,organizationId])).rows[0];
 if(!version)throw Object.assign(Error('Original de la plantilla no encontrado.'),{statusCode:404});
 if(version.process_id)await assertOpportunityAccess(organizationId,version.process_id);
 return createPreview({organizationId,kind:'template_version',id:version.id,version:version.file_hash_sha256,processId:version.process_id,filename:version.original_filename,getBuffer:async()=>{const b=await readStoredDocument(version.storage_key);if(fileSha256(b)!==version.file_hash_sha256)throw Error('El original no coincide con la versión guardada.');return b;}});
}
export async function previewArchiveEntry(organizationId,parentId,entryId){
 const parent=await readSourcePreview(organizationId,parentId);const entry=parent.archive_entries.find(e=>e.id===entryId);
 if(!entry?.supported)throw Object.assign(Error('Archivo del ZIP no disponible para vista previa.'),{statusCode:422});
 return createPreview({organizationId,kind:'archive_entry',id:parent.id,version:hash([parent.source_hash,entry.name]),processId:parent.process_id,filename:entry.filename,getBuffer:async()=>{
  const buffer=await readStoredDocument(parent.original_storage_key);if(fileSha256(buffer)!==parent.source_hash)throw Error('El ZIP no coincide con su versión.');
  const entries=archiveEntries(buffer);if(!entries.some(e=>e.id===entryId))throw Error('El archivo ya no está en el ZIP.');
  const b=new PizZip(buffer).file(entry.name).asNodeBuffer();if(b.length>config.documentUploadMaxBytes)throw Error('El archivo del ZIP supera el límite de carga.');return b;
 }});
}
export function sourcePreviewMetadata(row){return {preview_notice:row.mime_type.includes('spreadsheetml')?'Los vínculos a otros libros se muestran con sus valores guardados; no se actualizan en esta vista.':null,id:row.id,filename:row.original_filename,mime_type:row.mime_type,pages:row.page_count,hash:row.pdf_hash,source_hash:row.source_hash,pdf_url:`/api/source-previews/${row.id}/file`,page_url:`/api/source-previews/${row.id}/pages/{page}`,original_url:`/api/source-previews/${row.id}/original`,entries:row.archive_entries,process_id:row.process_id};}
