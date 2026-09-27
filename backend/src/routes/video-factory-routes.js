import {Router} from 'express';
import {statfs,stat,rm,readdir} from 'node:fs/promises';
import {query} from '../db.js';
import {encryptSecret} from '../services/secret-box.js';
export const factoryRouter=Router();
export const mediaRoot='/home/cernoiaapp/private/youtube';
export const runtimeRoot='/home/cernoiaapp/private/video-factory';
export const validId=id=>/^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const fail=(code,message)=>{const e=new Error(message);e.statusCode=code;throw e;};
export async function storageBytes(dir){let total=0;for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){const path=`${dir}/${entry.name}`;if(entry.isDirectory())total+=await storageBytes(path);else if(entry.isFile())total+=(await stat(path)).size;}return total;}
factoryRouter.get('/factory',wrap(async(_req,res)=>{
 const s=(await query('SELECT * FROM saas.video_factory_settings WHERE id=true')).rows[0];const disk=await statfs(mediaRoot);
 res.json({enabled:s.enabled,voice:s.voice,model:s.model,geminiConfigured:!!s.gemini_key,pexelsConfigured:!!s.pexels_key,freeTierConfirmed:s.free_tier_confirmed,nextRun:s.next_run,heartbeat:s.heartbeat,status:s.last_status,error:s.last_error,freeBytes:Number(disk.bavail)*Number(disk.bsize),usedBytes:await storageBytes(mediaRoot),intervalHours:3,maxLibraryBytes:2147483648,minFreeBytes:3221225472,ideas:(await query("SELECT * FROM saas.video_ideas WHERE status NOT IN ('cancelled','deleted') ORDER BY scheduled_at LIMIT 40")).rows});
}));
factoryRouter.put('/factory',wrap(async(req,res)=>{
 const {geminiKey,pexelsKey,enabled,voice,freeTierConfirmed}=req.body;
 if(typeof enabled!=='boolean'||!['ef_dora','em_alex'].includes(voice))fail(400,'Configuración no válida.');
 for(const key of [geminiKey,pexelsKey])if(key&&(!/^[a-zA-Z0-9_-]{20,200}$/.test(key)))fail(400,'La clave no tiene un formato válido.');
 const old=(await query('SELECT * FROM saas.video_factory_settings WHERE id=true')).rows[0];
 await query('UPDATE saas.video_factory_settings SET enabled=$1,voice=$2,gemini_key=$3,pexels_key=$4,free_tier_confirmed=$5,last_error=NULL,updated_at=now() WHERE id=true',[enabled,voice,geminiKey?encryptSecret(geminiKey):old.gemini_key,pexelsKey?encryptSecret(pexelsKey):old.pexels_key,freeTierConfirmed===true]);res.json({ok:true});
}));
factoryRouter.get('/factory/voice/:voice',wrap(async(req,res)=>{if(!['ef_dora','em_alex'].includes(req.params.voice))fail(404,'Voz no encontrada.');res.sendFile(`${runtimeRoot}/samples/${req.params.voice}.wav`,{cacheControl:false});}));
factoryRouter.delete('/ideas/:id',wrap(async(req,res)=>{
 const r=await query("UPDATE saas.video_ideas SET status='cancelled',updated_at=now() WHERE id=$1 AND status IN ('pending','held','failed') RETURNING id",[req.params.id]);
 if(!r.rowCount)fail(409,'La idea ya está produciéndose o fue eliminada.');res.json({ok:true});
}));
factoryRouter.get('/:id/download',wrap(async(req,res)=>{
 if(!validId(req.params.id))fail(404,'Video no encontrado.');
 const r=await query('SELECT id FROM saas.youtube_videos WHERE id=$1 AND local_deleted_at IS NULL',[req.params.id]);if(!r.rowCount)fail(404,'Video no encontrado.');
 res.download(`${mediaRoot}/${req.params.id}/video.mp4`,`${req.params.id}.mp4`,{cacheControl:false});
}));
factoryRouter.delete('/:id',wrap(async(req,res)=>{
 if(!validId(req.params.id)||req.body.confirm!==true)fail(400,'Confirma la eliminación local.');
 const r=await query("UPDATE saas.youtube_videos SET status='deleting',updated_at=now() WHERE id=$1 AND (status IN ('draft','uploaded','failed','deleting') AND upload_session IS NULL OR status='uploaded' OR status='deleting') AND local_deleted_at IS NULL RETURNING id",[req.params.id]);
 if(!r.rowCount)fail(409,'No se puede borrar mientras existe un envío activo o sin confirmar.');
 await rm(`${mediaRoot}/${req.params.id}`,{recursive:true,force:true});
 await query("UPDATE saas.youtube_videos SET status='deleted',local_deleted_at=now(),updated_at=now() WHERE id=$1",[req.params.id]);
 await query("UPDATE saas.video_ideas SET status='deleted',updated_at=now() WHERE video_id=$1",[req.params.id]);
 res.json({ok:true,message:'Video, miniaturas y archivos locales eliminados. El video en YouTube, si existe, se conserva.'});
}));
