import {officePreviewSource} from "./office-preview-source.js";
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {query,pool} from '../db.js';
import {readStoredDocument,storeDocument,removeStoredDocument,fileSha256} from './document-storage.js';
function run(command,args,timeoutMs=60000){return new Promise((resolve,reject)=>{const p=spawn(command,args,{shell:false,stdio:['ignore','ignore','pipe']});let error='';p.stderr.on('data',c=>{error=(error+c.toString()).slice(0,500);});const timer=setTimeout(()=>p.kill('SIGKILL'),timeoutMs);p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('No fue posible renderizar el documento. Comprueba el formato y vuelve a intentar.'));});});}
export async function officeToPdf(buffer,extension){
 const renderingSource=officePreviewSource(buffer,extension);

 const directory=await mkdtemp(join(tmpdir(),'cernoia-preview-'));
 try{
  const profile=join(directory,'profile');await mkdir(join(profile,'user'),{recursive:true});
  await writeFile(join(profile,'user','registrymodifications.xcu'),`<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`,{mode:0o600});
  await writeFile(join(directory,'document'+extension),renderingSource,{mode:0o600});
  await run('soffice',['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--norestore','--convert-to','pdf','--outdir',directory,join(directory,'document'+extension)]);
  return await readFile(join(directory,'document.pdf'));
 }finally{await rm(directory,{recursive:true,force:true});}
}
export async function ensureDocumentPreview(generated){
 const client=await pool.connect();let locked=false;try{
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[`preview:${generated.organization_id}:${generated.id}`])).rows[0].locked;
  if(!locked)throw Object.assign(Error('La vista previa se está generando. Inténtalo de nuevo en unos segundos.'),{statusCode:409});
  const existing=(await query('SELECT * FROM saas.generated_document_previews WHERE generated_document_id=$1 AND organization_id=$2 AND source_hash=$3',[generated.id,generated.organization_id,generated.file_hash_sha256])).rows[0];if(existing)return existing;
  const source=await readStoredDocument(generated.storage_key);if(fileSha256(source)!==generated.file_hash_sha256)throw Error('El archivo generado cambió y debe regenerarse.');
  const pdf=generated.mime_type==='application/pdf'?source:await officeToPdf(source,generated.mime_type.includes('spreadsheetml')?'.xlsx':'.docx');
  const pages=(await PDFDocument.load(pdf)).getPageCount();if(!pages||pages>200)throw Object.assign(Error('La previsualización admite hasta 200 páginas por documento.'),{statusCode:422});
  const stored=await storeDocument({organizationId:generated.organization_id,extension:'.pdf',buffer:pdf});
  try{return (await query(`INSERT INTO saas.generated_document_previews(generated_document_id,organization_id,source_hash,pdf_hash,storage_key,page_count) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(generated_document_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,pdf_hash=EXCLUDED.pdf_hash,storage_key=EXCLUDED.storage_key,page_count=EXCLUDED.page_count,created_at=NOW() RETURNING *`,[generated.id,generated.organization_id,generated.file_hash_sha256,fileSha256(pdf),stored.relativeKey,pages])).rows[0];}catch(e){await removeStoredDocument(stored.relativeKey);throw e;}
 }finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`preview:${generated.organization_id}:${generated.id}`]).catch(()=>{});client.release();}
}
export async function previewPage(pdf,page){
 const directory=await mkdtemp(join(tmpdir(),'cernoia-page-'));
 try{await writeFile(join(directory,'source.pdf'),pdf,{mode:0o600});await run('pdftoppm',['-f',String(page),'-l',String(page),'-scale-to','1600','-singlefile','-png',join(directory,'source.pdf'),join(directory,'page')],30000);return await readFile(join(directory,'page.png'));}finally{await rm(directory,{recursive:true,force:true});}
}
