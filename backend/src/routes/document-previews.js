import {annexCatalog,annexRole} from '../services/annex-catalog.js';
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {query,pool} from '../db.js';
import {requireAuth,requireRole} from '../middleware/auth.js';
import {requireEntitlement} from '../middleware/subscription.js';
import {previewProcessDocument,previewTemplateVersion,previewArchiveEntry,readSourcePreview,sourcePreviewMetadata} from '../services/source-document-preview.js';
import {readStoredDocument,fileSha256} from '../services/document-storage.js';
import {previewPage} from '../services/document-preview.js';
import {saveUploadedTemplate} from './templates.js';
export const documentPreviewsRouter=Router();
documentPreviewsRouter.use(requireAuth,requireEntitlement('document_automation'));
const limit=rateLimit({windowMs:60000,limit:120,keyGenerator:req=>req.user.organization_id,standardHeaders:true,legacyHeaders:false});
documentPreviewsRouter.use(limit);
for(const key of ['processId','documentId','versionId','previewId'])documentPreviewsRouter.param(key,(req,res,next,value)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?next():res.status(400).json({error:'Documento no válido.'}));
documentPreviewsRouter.post('/opportunities/:processId/documents/:documentId/preview',async(req,res,next)=>{try{res.json(sourcePreviewMetadata(await previewProcessDocument(req.user.organization_id,req.params.processId,req.params.documentId)));}catch(e){next(e);}});
documentPreviewsRouter.post('/template-versions/:versionId/preview',async(req,res,next)=>{try{res.json(sourcePreviewMetadata(await previewTemplateVersion(req.user.organization_id,req.params.versionId)));}catch(e){next(e);}});
documentPreviewsRouter.post('/source-previews/:previewId/entries/:entryId/preview',async(req,res,next)=>{try{res.json(sourcePreviewMetadata(await previewArchiveEntry(req.user.organization_id,req.params.previewId,req.params.entryId)));}catch(e){next(e);}});
documentPreviewsRouter.get('/source-previews/:previewId/:file',async(req,res,next)=>{try{
 if(!['file','original'].includes(req.params.file))return next();
 const p=await readSourcePreview(req.user.organization_id,req.params.previewId),original=req.params.file==='original';
 const key=original?p.original_storage_key:p.pdf_storage_key;if(!key)return res.status(422).json({error:'Abre uno de los archivos contenidos en el ZIP.'});
 const buffer=await readStoredDocument(key);if(fileSha256(buffer)!==(original?p.source_hash:p.pdf_hash))return res.status(409).json({error:'El archivo cambió. Vuelve a abrirlo.'});
 res.set({'Content-Type':original?p.mime_type:'application/pdf','Content-Disposition':`${original?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(original?p.original_filename:'vista-original.pdf')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(buffer);
}catch(e){next(e);}});
documentPreviewsRouter.get('/source-previews/:previewId/pages/:page',async(req,res,next)=>{try{
 const p=await readSourcePreview(req.user.organization_id,req.params.previewId),page=Number(req.params.page);
 if(!Number.isInteger(page)||page<1||page>p.page_count)return res.status(404).json({error:'Página no disponible.'});
 if(req.query.v&&req.query.v!==p.pdf_hash)return res.status(409).json({error:'La versión cambió. Vuelve a abrir el documento.'});
 const pdf=await readStoredDocument(p.pdf_storage_key);if(fileSha256(pdf)!==p.pdf_hash)return res.status(409).json({error:'La vista previa cambió. Vuelve a abrir el documento.'});
 res.set({'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(await previewPage(pdf,page));
}catch(e){next(e);}});
documentPreviewsRouter.post('/source-previews/:previewId/import',requireRole('owner','admin','analyst'),async(req,res,next)=>{let client,locked=false,lock;try{
 const p=await readSourcePreview(req.user.organization_id,req.params.previewId);
 if(!p.process_id||!p.pdf_storage_key)return res.status(422).json({error:'Selecciona un PDF, DOCX o XLSX del proceso para diligenciar.'});
 const parent=p.source_kind==='archive_entry'?await readSourcePreview(req.user.organization_id,p.source_id):null;
 if(annexRole(p.original_filename,parent?.original_filename)==='informative')return res.status(422).json({error:'Este archivo es informativo. Consulta los formatos diligenciables del proceso.'});
 const successful=await query("SELECT 1 FROM saas.opportunity_ai_analyses WHERE organization_id=$1 AND process_id=$2 AND analysis_status='success' LIMIT 1",[req.user.organization_id,p.process_id]);
 if(!successful.rowCount)return res.status(422).json({error:'Completa el análisis de la oportunidad antes de diligenciar sus anexos.'});
 lock=`source-import:${req.user.organization_id}:${p.process_id}:${p.source_hash}`;client=await pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[lock])).rows[0].locked;
 if(!locked)return res.status(409).json({error:'Este anexo se está preparando. Inténtalo de nuevo en unos segundos.'});
 const existing=(await query(`SELECT t.* FROM saas.document_templates t JOIN saas.document_template_versions v ON v.template_id=t.id AND v.version_number=t.current_version WHERE t.organization_id=$1 AND t.process_id=$2 AND t.status='active' AND v.file_hash_sha256=$3 LIMIT 1`,[req.user.organization_id,p.process_id,p.source_hash])).rows[0];
 if(existing)return res.json({template:existing,reused:true});
 const buffer=await readStoredDocument(p.original_storage_key);if(fileSha256(buffer)!==p.source_hash)return res.status(409).json({error:'El original cambió. Vuelve a abrirlo.'});
 req.templateUpload={buffer,metadata:{filename:p.original_filename,name:p.original_filename,scope:'process',processId:p.process_id,description:'Formato original del proceso seleccionado para diligenciar.'}};
 await saveUploadedTemplate(req,res,next);
}catch(e){next(e);}finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]).catch(()=>{});client?.release();}});

documentPreviewsRouter.post('/opportunities/:processId/annex-catalog',async(req,res,next)=>{try{res.json(await annexCatalog(req.user.organization_id,req.params.processId));}catch(e){next(e);}});
