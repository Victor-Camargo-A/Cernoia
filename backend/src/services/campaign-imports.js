import {inspectAddress} from './campaign-hygiene.js';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,unlink,statfs} from 'node:fs/promises';
import {join,extname,basename} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';
import {pool,query} from '../db.js';
import {config} from '../config.js';
import {emailAddress,fail} from './campaign-rules.js';

export const MAX_IMPORT_BYTES=200*1024*1024;
const directory=process.env.CAMPAIGN_IMPORT_DIR||join(config.documentStoragePath,'campaign-imports');
const reader=fileURLToPath(new URL('../../scripts/read-campaign-spreadsheet.py',import.meta.url));
let running=false,stopping=false,activeChild;
const pathFor=job=>join(directory,job.id+extname(job.filename).toLowerCase());
export async function listCampaignImports(){return (await query('SELECT * FROM saas.campaign_import_jobs ORDER BY created_at DESC LIMIT 10')).rows;}
export async function receiveCampaignImport(req){
 const filename=basename(String(req.query.filename??'')).slice(0,250),name=String(req.query.name??'').trim(),source=String(req.query.source_note??'').trim();
 if(!/\.(csv|xlsx)$/i.test(filename))throw fail('Selecciona un archivo CSV o XLSX.');
 if(!name||!source)throw fail('Indica el nombre y la procedencia de la lista.');
 if(Number(req.get('content-length')||0)>MAX_IMPORT_BYTES)throw fail('El archivo supera 200 MB.',413);
 if(req.body!==undefined)throw fail('Envía el archivo con el selector de CSV o Excel.');
 const pending=(await query("SELECT COUNT(*)::int n FROM saas.campaign_import_jobs WHERE status IN ('queued','processing')")).rows[0].n;
 if(pending>=3)throw fail('Ya hay tres archivos pendientes. Espera a que termine una importación.',409);
 await mkdir(directory,{recursive:true,mode:0o700});const space=await statfs(directory);
 if(space.bavail*space.bsize<1024**3)throw fail('No hay suficiente espacio temporal para importar el archivo.',503);
 const id=randomUUID(),job={id,filename},path=pathFor(job);let bytes=0;
 try{
  const bound=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>MAX_IMPORT_BYTES?fail('El archivo supera 200 MB.',413):null,chunk);}});
  await pipeline(req,bound,createWriteStream(path,{flags:'wx',mode:0o600}));
  if(!bytes)throw fail('El archivo está vacío.');
  const created=(await query(`INSERT INTO saas.campaign_import_jobs(id,filename,file_bytes,name,source_note,permission_confirmed,created_by,owner_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,filename,bytes,name.slice(0,180),source.slice(0,2000),req.query.permission_confirmed==='true',req.platformAdmin?.id??null,req.user?.id??null])).rows[0];
  setImmediate(()=>void processNextCampaignImport().catch(()=>{}));return created;
 }catch(error){await unlink(path).catch(()=>{});throw error;}
}
async function* lines(stream){
 const decoder=new StringDecoder('utf8');let buffer='';
 for await(const chunk of stream){buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)yield line;}if(buffer.length>20000)throw Error('Una fila del archivo es demasiado larga.');}
 buffer+=decoder.end();if(buffer.trim())yield buffer;
}
export async function processNextCampaignImport(){
 if(running||stopping)return;running=true;let client,locked=false,job,child,completed=false;
 try{
  client=await pool.connect();locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('campaign-file-import')) AS locked")).rows[0].locked;if(!locked)return;
  job=(await client.query("SELECT * FROM saas.campaign_import_jobs WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1")).rows[0];if(!job)return;
  await client.query('BEGIN');
  if(job.list_id)await client.query('DELETE FROM saas.campaign_list_contacts WHERE list_id=$1',[job.list_id]);
  else job.list_id=(await client.query("INSERT INTO saas.campaign_lists(name,source_note,permission_confirmed,created_by,import_status) VALUES($1,$2,FALSE,$3,'processing') RETURNING id",[job.name,job.source_note,job.created_by])).rows[0].id;
  await client.query("UPDATE saas.campaign_import_jobs SET list_id=$2,status='processing',phase='Abriendo archivo',total_rows=0,valid_rows=0,invalid_rows=0,unique_contacts=0,duplicate_rows=0,excluded_rows=0,error=NULL,updated_at=NOW() WHERE id=$1",[job.id,job.list_id]);await client.query('COMMIT');
  child=spawn('/usr/bin/python3',[reader,pathFor(job)],{stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1',OMP_NUM_THREADS:'1'}});activeChild=child;
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});exit.catch(()=>{});
  let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),20*60*1000);timer.unref();
  let total=0,valid=0,invalid=0,excluded=0,unique=0,batch=[],lastProgress=0,parseError;
  const progress=async phase=>{await client.query('UPDATE saas.campaign_import_jobs SET phase=$2,total_rows=$3,valid_rows=$4,invalid_rows=$5,unique_contacts=$6,duplicate_rows=$7,excluded_rows=$8,updated_at=NOW() WHERE id=$1',[job.id,phase,total,valid,invalid,unique,valid-unique,excluded]);};
  const flush=async()=>{
   if(batch.length){
    const blocked=new Set((await client.query("SELECT email FROM UNNEST($1::text[]) AS t(email) WHERE EXISTS(SELECT 1 FROM saas.campaign_contact_exclusions e WHERE e.email_hash=encode(sha256(convert_to(t.email,'UTF8')),'hex'))",[batch.map(c=>c.email)])).rows.map(r=>r.email));
    const removed=batch.filter(c=>blocked.has(c.email)).length;excluded+=removed;valid-=removed;
    const contacts=[...new Map(batch.filter(c=>!blocked.has(c.email)).map(c=>[c.email,{...c,...(()=>{const q=inspectAddress(c.email);return {quality_status:q.status,quality_reason:q.reason,email_suggestion:q.suggestion};})()}])).values()];
    await client.query('BEGIN');
    const rows=(await client.query(`INSERT INTO saas.campaign_contacts(email,company_name,contact_name,quality_status,quality_reason,email_suggestion)
     SELECT email,company_name,contact_name,quality_status,quality_reason,email_suggestion FROM jsonb_to_recordset($1::jsonb) AS x(email text,company_name text,contact_name text,quality_status text,quality_reason text,email_suggestion text)
     ON CONFLICT(email) DO UPDATE SET company_name=CASE WHEN EXCLUDED.company_name<>'' THEN EXCLUDED.company_name ELSE saas.campaign_contacts.company_name END RETURNING id`,[JSON.stringify(contacts)])).rows;
    unique+=(await client.query('INSERT INTO saas.campaign_list_contacts(list_id,contact_id) SELECT $1,UNNEST($2::uuid[]) ON CONFLICT DO NOTHING',[job.list_id,rows.map(r=>r.id)])).rowCount;
    await client.query('COMMIT');batch=[];
   }
   await progress('Importando contactos');
  };
  try{
   for await(const line of lines(child.stdout)){
    if(stopping)throw Error('Importación interrumpida; se reanudará al iniciar el servidor.');
    const row=JSON.parse(line);
    if(row.error){parseError=row.error;continue;}
    if(row.phase){if(Date.now()-lastProgress>2000){await progress(row.phase);lastProgress=Date.now();}continue;}
    total++;if(row.excluded===true){excluded++;if(total%500===0)await flush();continue;}const email=emailAddress(row.email);if(email){valid++;batch.push({email,company_name:String(row.company_name??'').slice(0,300),contact_name:String(row.contact_name??'').slice(0,180)});}else invalid++;
    if(total%500===0)await flush();
   }
   const code=await exit;if(code!==0||parseError)throw Error(parseError||'La lectura del archivo se interrumpió o superó el límite de recursos.');
   await flush();if(!unique)throw Error('No se encontraron correos válidos en la primera hoja del archivo.');
   await client.query('BEGIN');await client.query("UPDATE saas.campaign_lists SET import_status='ready',provider_only=TRUE,permission_confirmed=$2 WHERE id=$1",[job.list_id,job.permission_confirmed]);await client.query("UPDATE saas.campaign_import_jobs SET status='completed',phase='Completada',finished_at=NOW(),updated_at=NOW() WHERE id=$1",[job.id]);await client.query('COMMIT');completed=true;
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');await exit.catch(()=>{});}
 }catch(error){
  if(client)await client.query('ROLLBACK').catch(()=>{});
  if(job&&client&&!stopping){await client.query("UPDATE saas.campaign_import_jobs SET status='failed',error=$2,phase='No completada',updated_at=NOW(),finished_at=NOW() WHERE id=$1",[job.id,String(error.message).slice(0,500)]).catch(()=>{});if(job.list_id)await client.query("UPDATE saas.campaign_lists SET import_status='failed',permission_confirmed=FALSE WHERE id=$1",[job.list_id]).catch(()=>{});}
 }finally{
  if(job&&!stopping){await unlink(pathFor(job)).catch(()=>{});await unlink(pathFor(job)+'.strings.sqlite').catch(()=>{});}
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('campaign-file-import'))").catch(()=>{});client?.release();activeChild=undefined;running=false;
 }
 return {completed};
}
export function startCampaignImportWorker(){
 stopping=false;const tick=()=>void processNextCampaignImport().catch(()=>{});const interval=setInterval(tick,5000);interval.unref();tick();
 return ()=>{stopping=true;clearInterval(interval);activeChild?.kill('SIGTERM');};
}
