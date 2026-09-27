import PizZip from 'pizzip';
// Only the disposable rendering copy is changed. Original templates and downloads
// retain their formulas, relationships and byte-for-byte source contents.
export function officePreviewSource(buffer,extension){
 const zip=new PizZip(buffer);let expanded=0;
 const fail=message=>{throw Object.assign(Error(message),{statusCode:422});};
 for(const [name,file] of Object.entries(zip.files)){
  expanded+=file._data?.uncompressedSize??0;
  if(expanded>80*1024*1024||/vbaProject|connections\.xml|queryTables/i.test(name))fail('El documento contiene macros, conexiones de datos o excede el tamaño de conversión.');
 }
 if(extension==='.xlsx'&&Object.keys(zip.files).some(n=>n.startsWith('xl/externalLinks/'))){
  for(const [name,file] of Object.entries(zip.files)){
   if(/^xl\/worksheets\/sheet\d+\.xml$/.test(name)){
    const xml=file.asText(),externalShared=new Set();
    for(const m of xml.matchAll(/<f\b([^>]*)>([\s\S]*?)<\/f>/g))if(/\[\d+\]/.test(m[2])){const si=m[1].match(/\bsi="(\d+)"/);if(si)externalShared.add(si[1]);}
    zip.file(name,xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g,cell=>{
     const f=cell.match(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);if(!f)return cell;
     const si=f[1].match(/\bsi="(\d+)"/);
     if(!/\[\d+\]/.test(f[2]??'')&&!(si&&externalShared.has(si[1])))return cell;
     if(!/<v\b[^>]*>[\s\S]*?<\/v>/.test(cell))fail('Una fórmula externa no tiene un valor guardado para mostrar. Abre el original y guarda sus valores antes de generar la vista.');
     return cell.replace(f[0],'');
    }));
   }
   if(name==='xl/workbook.xml'){
    const xml=file.asText();if(/<definedName\b[^>]*>[^<]*\[\d+\]/.test(xml))fail('El Excel contiene nombres vinculados a otro libro que requieren revisión en el original.');
    zip.file(name,xml.replace(/<externalReferences\b[^>]*>[\s\S]*?<\/externalReferences>/g,''));
   }
   if(name==='xl/_rels/workbook.xml.rels')zip.file(name,file.asText().replace(/<Relationship\b[^>]*Type=["'][^"']*\/(?:externalLink|calcChain)["'][^>]*\/>/g,''));
   if(name==='[Content_Types].xml')zip.file(name,file.asText().replace(/<Override\b[^>]*PartName=["']\/xl\/(?:externalLinks\/[^"']*|calcChain\.xml)["'][^>]*\/>/g,''));
  }
  zip.remove('xl/externalLinks');zip.remove('xl/calcChain.xml');
 }
 for(const [name,file] of Object.entries(zip.files)){
  if(/externalLinks/i.test(name))fail('La vista previa no admite este vínculo externo.');
  if(name.endsWith('.rels'))for(const relation of file.asText().matchAll(/<Relationship\b[^>]*>/g))if(/TargetMode=["']External["']/.test(relation[0])&&!/relationships\/hyperlink["']/.test(relation[0]))fail('La vista previa requiere un documento sin imágenes ni contenido vinculados externamente.');
 }
 return zip.generate({type:'nodebuffer',compression:'DEFLATE'});
}
