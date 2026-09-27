import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { query, pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { ownerCampaignAuth } from '../services/campaigns.js';
import { encryptSecret, decryptSecret } from '../services/secret-box.js';
import { validateMetadata } from '../services/youtube-validation.js';
import {factoryRouter,validId} from './video-factory-routes.js';

export const youtubeRouter = Router();
const ROOT = '/home/cernoiaapp/private/youtube';
const CALLBACK = 'https://cernoia.energeticanika.com/api/platform/youtube/oauth/callback';
const BASE = '/platform/youtube';
const hash = x => createHash('sha256').update(String(x)).digest('hex');
const encode = x => encryptSecret(JSON.stringify(x));
const decode = x => JSON.parse(decryptSecret(x));
const fail = (code, message) => { const e = new Error(message); e.statusCode = code; throw e; };
const settings = async () => (await query('SELECT * FROM saas.youtube_settings WHERE id=true')).rows[0];
const safeVideo = row => { const {upload_session, ...video} = row; return video; };
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
async function google(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(120000), redirect:'error'});
  if (!response.ok && response.status !== 308) {
    let reason = '';
    try { const body = await response.json(); reason = body.error?.errors?.[0]?.reason || (typeof body.error === 'string' ? body.error : ''); } catch {}
    const error = new Error(`YouTube/Google: HTTP ${response.status}${/^[a-zA-Z_]+$/.test(reason) ? ` (${reason})` : ''}.`);
    error.httpStatus = response.status; throw error;
  }
  return response;
}

// OAuth uses its own short-lived, browser-bound state: the platform cookie is SameSite=Strict.
youtubeRouter.get(`${BASE}/oauth/callback`, wrap(async (req,res) => {
  const state = String(req.query.state || '');
  const browser = req.cookies?.cernoia_youtube_oauth;
  if (!state || !browser) return res.status(400).send('La conexión expiró. Iníciala de nuevo desde el panel.');
  const found = await query(`DELETE FROM saas.youtube_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now()
    AND admin_id IN (SELECT owner_user_id FROM saas.campaign_settings WHERE id=true)
    AND admin_id IN (SELECT id FROM saas.app_users WHERE status='active') RETURNING admin_id`, [hash(state),hash(browser)]);
  res.clearCookie('cernoia_youtube_oauth',{path:'/api/platform/youtube/oauth',secure:true,sameSite:'lax',httpOnly:true});
  if (!found.rowCount) return res.status(400).send('La autorización no es válida o ya fue utilizada.');
  if (req.query.error) return res.redirect('/acceso?youtube=cancelled');
  try {
    const s = await settings(); const c = decode(s.credentials);
    const tokens = await (await google('https://oauth2.googleapis.com/token', {method:'POST',body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,code:String(req.query.code || ''),redirect_uri:CALLBACK,grant_type:'authorization_code'})})).json();
    if (!tokens.refresh_token) throw new Error('Falta autorización persistente.');
    const channel = await (await google('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',{headers:{Authorization:`Bearer ${tokens.access_token}`}})).json();
    if (!channel.items?.[0]?.id) throw new Error('La cuenta no tiene un canal de YouTube.');
    await query('UPDATE saas.youtube_settings SET tokens=$1,channel_id=$2,channel_title=$3,updated_at=now() WHERE id=true',[encode({refresh_token:tokens.refresh_token}),channel.items[0].id,channel.items[0].snippet.title]);
    return res.redirect('/acceso?youtube=connected');
  } catch { return res.redirect('/acceso?youtube=error'); }
}));
youtubeRouter.use(BASE, requireAuth, ownerCampaignAuth, (req,res,next) => {
  res.set('Cache-Control','private, no-store');
  next();
});
youtubeRouter.use(BASE,factoryRouter);
youtubeRouter.get(BASE, wrap(async (_req,res) => {
  const s = await settings();
  res.json({videos:(await query('SELECT * FROM saas.youtube_videos WHERE local_deleted_at IS NULL ORDER BY created_at DESC')).rows.map(safeVideo),connection:{configured:!!s.credentials,connected:!!s.tokens,channelId:s.channel_id,channelTitle:s.channel_title,redirectUri:CALLBACK}});
}));
youtubeRouter.post(`${BASE}/settings`, wrap(async (req,res) => {
  const clientId = String(req.body?.clientId || '').trim(); const clientSecret = String(req.body?.clientSecret || '').trim();
  if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length<10 || clientSecret.length>300) fail(400,'Introduce el ID y el secreto del cliente OAuth web de Google.');
  if ((await query("SELECT 1 FROM saas.youtube_videos WHERE status IN ('queued','uploading','retry') LIMIT 1")).rowCount) fail(409,'Espera a que termine el envío en curso.');
  await query('UPDATE saas.youtube_settings SET credentials=$1,tokens=NULL,channel_id=NULL,channel_title=NULL,updated_at=now() WHERE id=true',[encode({clientId,clientSecret})]);
  res.json({ok:true});
}));
youtubeRouter.post(`${BASE}/connect`, wrap(async (req,res) => {
  const s = await settings(); if (!s.credentials) fail(409,'Primero configura el cliente OAuth.');
  if ((await query("SELECT 1 FROM saas.youtube_videos WHERE status IN ('queued','uploading','retry') LIMIT 1")).rowCount) fail(409,'Hay un envío en curso.');
  const state=randomBytes(32).toString('base64url'), browser=randomBytes(32).toString('base64url');
  await query('DELETE FROM saas.youtube_oauth_states WHERE expires_at<now() OR admin_id=$1',[req.campaignOwner.id]);
  await query("INSERT INTO saas.youtube_oauth_states VALUES($1,$2,$3,now()+interval '10 minutes')",[hash(state),hash(browser),req.campaignOwner.id]);
  res.cookie('cernoia_youtube_oauth',browser,{path:'/api/platform/youtube/oauth',secure:true,httpOnly:true,sameSite:'lax',maxAge:600000});
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({client_id:decode(s.credentials).clientId,redirect_uri:CALLBACK,response_type:'code',scope:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',access_type:'offline',prompt:'consent',state}).toString();
  res.json({url:url.href});
}));
youtubeRouter.post(`${BASE}/disconnect`, wrap(async (_req,res) => {
  if ((await query("SELECT 1 FROM saas.youtube_videos WHERE status IN ('queued','uploading','retry') LIMIT 1")).rowCount) fail(409,'Hay un envío en curso.');
  const s=await settings();
  if(s.tokens) { try { await google('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:decode(s.tokens).refresh_token})}); } catch { fail(502,'Google no confirmó la revocación. Reintenta o revoca el acceso desde tu cuenta de Google.'); } }
  await query('UPDATE saas.youtube_settings SET tokens=NULL,channel_id=NULL,channel_title=NULL WHERE id=true');
  await query('DELETE FROM saas.youtube_oauth_states'); res.json({ok:true});
}));
youtubeRouter.get(`${BASE}/:id/media/:kind`, wrap(async (req,res) => {
  if(!validId(req.params.id) || !['video','thumbnail','poster'].includes(req.params.kind)) fail(404,'Archivo no encontrado.');
  if(!(await query('SELECT id FROM saas.youtube_videos WHERE id=$1 AND local_deleted_at IS NULL',[req.params.id])).rowCount)fail(404,'Archivo no encontrado.');
  const filenames={video:'video.mp4',thumbnail:'thumbnail.jpg',poster:'thumbnail-short.jpg'};
  res.sendFile(`${ROOT}/${req.params.id}/${filenames[req.params.kind]}`,{cacheControl:false,dotfiles:'deny'});
}));
youtubeRouter.put(`${BASE}/:id`, wrap(async (req,res) => {
  const metadata=validateMetadata(req.body.metadata);
  const result=await query(`UPDATE saas.youtube_videos SET metadata=$2,revision=revision+1,reviewed_at=NULL,reviewed_by=NULL,updated_at=now()
    WHERE id=$1 AND revision=$3 AND status='draft' RETURNING *`,[req.params.id,metadata,req.body.revision]);
  if(!result.rowCount) fail(409,'El video cambió o ya está en proceso de publicación. Actualiza la página.');
  res.json({video:safeVideo(result.rows[0])});
}));
youtubeRouter.post(`${BASE}/:id/publish`, wrap(async (req,res) => {
  if(req.body.reviewed!==true) fail(400,'Confirma que revisaste el video, la miniatura y sus datos.');
  const s=await settings(); if(!s.tokens) fail(409,'Conecta primero el canal de YouTube.');
  const result=await query(`UPDATE saas.youtube_videos SET status='queued',reviewed_by=$2,reviewed_at=now(),target_channel_id=$4,next_attempt=now(),updated_at=now()
    WHERE id=$1 AND revision=$3 AND status='draft' RETURNING id`,[req.params.id,req.campaignOwner.id,req.body.revision,s.channel_id]);
  if(!result.rowCount) fail(409,'Este video ya fue enviado o su revisión cambió. Actualiza la página.');
  res.status(202).json({ok:true});
}));
youtubeRouter.post(`${BASE}/:id/retry`, wrap(async (req,res) => {
  const result=await query("UPDATE saas.youtube_videos SET status='retry',attempts=0,next_attempt=now(),last_error=NULL WHERE id=$1 AND status='failed' RETURNING id",[req.params.id]);
  if(!result.rowCount) fail(409,'El video no admite reintento automático.');
  res.status(202).json({ok:true});
}));

export async function upload(row) {
  const s=await settings(); if(!s.tokens) throw new Error('Conecta nuevamente YouTube.');
  if(row.target_channel_id!==s.channel_id) throw new Error('El canal cambió desde la revisión. Reconecta el canal autorizado para este video.');
  const c=decode(s.credentials);
  const token=await (await google('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:decode(s.tokens).refresh_token,grant_type:'refresh_token'})})).json();
  const headers={Authorization:`Bearer ${token.access_token}`};
  const channel=await (await google('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',{headers})).json();
  if(channel.items?.[0]?.id!==s.channel_id) throw new Error('El canal autorizado no coincide. Vuelve a conectar YouTube.');
  if(!validId(row.id)) throw new Error('El recurso no está disponible.');
  const filename=`${ROOT}/${row.id}/video.mp4`; const size=(await stat(filename)).size;
  let videoId=row.youtube_id;
  if(!videoId) {
    const m=validateMetadata(row.metadata);
    let session=row.upload_session ? decode(row.upload_session).url : null;
    let offset=0, response;
    if(session) {
      try { response=await google(session,{method:'PUT',headers:{...headers,'Content-Length':'0','Content-Range':`bytes */${size}`}}); }
      catch(error) { if([404,410].includes(error.httpStatus)) { error.uncertain=true; error.message='La sesión de carga expiró. Comprueba YouTube Studio antes de un nuevo envío para evitar duplicados.'; } throw error; }
      if(response.status===308) offset=Number(response.headers.get('range')?.match(/-(\d+)$/)?.[1] ?? -1)+1;
    } else {
      const created=await google('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Upload-Content-Type':'video/mp4','X-Upload-Content-Length':String(size)},body:JSON.stringify({snippet:{title:m.title,description:m.description,tags:m.tags,categoryId:m.categoryId,defaultLanguage:'es',defaultAudioLanguage:'es'},status:{privacyStatus:m.privacy,selfDeclaredMadeForKids:m.madeForKids,containsSyntheticMedia:m.containsSyntheticMedia}})});
      session=created.headers.get('location');
      const url=new URL(session); if(url.protocol!=='https:' || url.hostname!=='www.googleapis.com') throw new Error('Google devolvió una sesión de carga no válida.');
      await query('UPDATE saas.youtube_videos SET upload_session=$2 WHERE id=$1',[row.id,encode({url:session})]);
    }
    if(!response || response.status===308) {
      const file=await readFile(filename);
      response=await google(session,{method:'PUT',headers:{...headers,'Content-Type':'video/mp4','Content-Length':String(size-offset),'Content-Range':`bytes ${offset}-${size-1}/${size}`},body:file.subarray(offset)});
      if(response.status===308) throw new Error('La carga está incompleta; se continuará desde el último byte confirmado.');
    }
    const published=await response.json(); videoId=published.id;
    if(!/^[\w-]{11}$/.test(videoId || '')) throw new Error('YouTube no confirmó el identificador del video.');
    await query("UPDATE saas.youtube_videos SET youtube_id=$2,actual_privacy=$3,thumbnail_status='pending',updated_at=now() WHERE id=$1",[row.id,videoId,published.status?.privacyStatus || null]);
  }
  await google(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,{method:'POST',headers:{...headers,'Content-Type':'image/jpeg'},body:await readFile(`${ROOT}/${row.id}/thumbnail.jpg`)});
  await query("UPDATE saas.youtube_videos SET status='uploaded',thumbnail_status='uploaded',last_error=NULL,updated_at=now() WHERE id=$1",[row.id]);
}
let running=false;
async function tick() {
  if(running) return; running=true; let client;
  try {
    client=await pool.connect();
    if(!(await client.query('SELECT pg_try_advisory_lock(760918) AS locked')).rows[0].locked) return;
    const result=await query("UPDATE saas.youtube_videos SET status='uploading',attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM saas.youtube_videos WHERE status IN ('queued','retry','uploading') AND next_attempt<=now() ORDER BY created_at LIMIT 1) RETURNING *");
    if(!result.rowCount) return;
    const row=result.rows[0];
    try { await upload(row); console.log(`[YouTube] project=${row.id} status=uploaded`); }
    catch(error) {
      const status=error.uncertain?'needs_attention':row.attempts>=3?'failed':'retry';
      // Error text is restricted: never log request headers, tokens or resumable URLs.
      const message=error.httpStatus || error.uncertain || /^(Conecta|El canal|La carga)/.test(error.message) ? error.message : 'El envío se interrumpió. Se conservará el avance para reintentarlo.';
      await query("UPDATE saas.youtube_videos SET status=$2,last_error=$3,next_attempt=now()+interval '2 minutes',updated_at=now() WHERE id=$1",[row.id,status,message]);
      console.log(`[YouTube] project=${row.id} status=${status} attempt=${row.attempts}`);
    }
  } catch { console.error('[YouTube] stage=worker status=unavailable'); }
  finally { if(client) { await client.query('SELECT pg_advisory_unlock(760918)').catch(()=>{});client.release(); } running=false; }
}
export function startYoutubeWorker() { setInterval(()=>void tick(),15000).unref(); }
