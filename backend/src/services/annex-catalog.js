import {query} from '../db.js';
import {assertOpportunityAccess} from './bid-workspace.js';
import {previewProcessDocument} from './source-document-preview.js';
import {annexRole,matchingAnnexes} from './annex-rules.js';
export {annexRole,matchingAnnexes} from './annex-rules.js';
export async function annexCatalog(org,processId){
 await assertOpportunityAccess(org,processId);
 const docs=(await query('SELECT id,file_name,file_extension FROM secop.process_documents WHERE process_id=$1 ORDER BY file_name,id',[processId])).rows;
 const entries=[],warnings=[];
 for(const d of docs){
  const filename=d.file_name??'Documento',extension=(d.file_extension||filename.split('.').at(-1)).toLowerCase().replace(/^\./,'');
  if(extension==='zip'){
   try{const archive=await previewProcessDocument(org,processId,d.id);for(const f of archive.archive_entries){entries.push({id:d.id+':'+f.id,document_id:d.id,filename:f.filename,archive_name:filename,role:annexRole(f.filename,filename),supported:f.supported,preview_endpoint:`/source-previews/${archive.id}/entries/${f.id}/preview`});}}
   catch(e){warnings.push({document_id:d.id,filename,message:e.statusCode===409?'El ZIP se está preparando. Actualiza la lista en unos segundos.':'No se pudo leer este ZIP. Abre el original o vuelve a intentar.'});}
  }else entries.push({id:d.id,document_id:d.id,filename,archive_name:null,role:annexRole(filename),supported:['pdf','docx','xlsx'].includes(extension),preview_endpoint:`/opportunities/${processId}/documents/${d.id}/preview`});
 }
 const requirements=(await query("SELECT id,requirement_name,requirement_description,condition_text,requires_signature,requires_entity_template FROM saas.opportunity_requirements WHERE organization_id=$1 AND process_id=$2 AND status<>'superseded'",[org,processId])).rows;
 return {entries:entries.map(e=>({...e,requirement_ids:requirements.filter(r=>matchingAnnexes(r,[e]).length).map(r=>r.id)})),warnings};
}
