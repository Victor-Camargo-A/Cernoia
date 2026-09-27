import {query} from '../db.js';
export async function syncProcessInventory(processId){
 const p=(await query("SELECT id,COALESCE(portfolio_id,raw_json->>'id_del_portafolio') AS portfolio FROM secop.processes WHERE id=$1",[processId])).rows[0];
 if(!p||!/^CO1\.BDOS\.\d+$/.test(p.portfolio??''))throw Error('La fuente no informa el identificador del expediente documental.');
 const url=new URL('https://www.datos.gov.co/resource/dmgg-8hin.json');url.searchParams.set('$where',`proceso='${p.portfolio}'`);url.searchParams.set('$limit','201');
 const response=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error('El inventario oficial no respondió. Se puede volver a intentar.');const rows=await response.json();if(!Array.isArray(rows))throw Error('Inventario oficial no válido.');if(rows.length>200)throw Error('El expediente supera 200 archivos; requiere revisión del inventario.');
 for(const d of rows){if(String(d.proceso)!==p.portfolio||!/^\d+$/.test(d.id_documento??''))continue;
  const u=typeof d.url_descarga_documento==='object'?d.url_descarga_documento:{url:d.url_descarga_documento};
  await query(`INSERT INTO secop.process_documents(external_document_id,process_id,secop_portfolio_id,file_name,file_size_bytes,file_extension,description,uploaded_at,entity_name,entity_nit,download_url,download_url_text,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11::jsonb,$12,$13::jsonb) ON CONFLICT(external_document_id) DO UPDATE SET process_id=EXCLUDED.process_id,file_name=EXCLUDED.file_name,file_size_bytes=EXCLUDED.file_size_bytes,file_extension=EXCLUDED.file_extension,description=EXCLUDED.description,uploaded_at=EXCLUDED.uploaded_at,download_url=EXCLUDED.download_url,download_url_text=EXCLUDED.download_url_text,raw_json=EXCLUDED.raw_json,last_seen_at=NOW(),updated_at=NOW()`,[String(d.id_documento),p.id,p.portfolio,d.nombre_archivo,Number.isFinite(Number(d.tamanno_archivo))?Number(d.tamanno_archivo):null,String(d.extensi_n??'').toLowerCase(),d.descripci_n??null,d.fecha_carga??null,d.entidad??null,d.nit_entidad??null,JSON.stringify(u),u.url??null,JSON.stringify(d)]);
 }
 return {documents:rows.length};
}
