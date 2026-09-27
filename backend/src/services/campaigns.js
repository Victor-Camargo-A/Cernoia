import {campaignDestination} from './marketing.js';
import {validateCampaignAddress} from './campaign-hygiene.js';
import nodemailer from 'nodemailer';
import {randomBytes,randomUUID} from 'node:crypto';
import {pool,query} from '../db.js';
import {config} from '../config.js';
import {encryptSecret,decryptSecret} from './secret-box.js';
import {campaignMail,emailAddress,fail,smtpFailure,campaignMorningOpen} from './campaign-rules.js';
export const publicCampaignBase=[...config.allowedOrigins].find(s=>s.startsWith('https://cernoia.'))??[...config.allowedOrigins][0];
export async function campaignSettings(){return (await query('SELECT * FROM saas.campaign_settings WHERE id=TRUE')).rows[0];}
export function publicSettings(s){const {password_box,...safe}=s;return {...safe,password_configured:!!password_box,effective_daily_limit:Math.max(0,Math.min(s.daily_limit,s.provider_daily_limit-s.reserved_daily))};}
export async function ownerCampaignAuth(req,res,next){try{
 const s=await campaignSettings();
 const appOwner=!!s?.owner_user_id&&s.owner_user_id===req.user?.id;
 const platformOwner=!s?.owner_user_id&&!!s?.owner_admin_id&&s.owner_admin_id===req.platformAdmin?.id;
 if(!appOwner&&!platformOwner)return res.status(403).json({error:'Este módulo es exclusivo del dueño de CernoIA.'});
 req.campaignOwner={id:appOwner?req.user.id:req.platformAdmin.id,kind:appOwner?'app_user':'platform_admin'};
 next();
}catch(e){next(e);}}
export async function saveCampaignSettings(input){
 const old=await campaignSettings();const next={...old};
 for(const [key,min,max] of [['daily_limit',1,1000],['provider_daily_limit',1,100000],['reserved_daily',0,100000],['minimum_gap_days',2,365]])if(input[key]!==undefined){const n=Number(input[key]);if(!Number.isInteger(n)||n<min||n>max)throw fail(`Valor no válido para ${key}.`);next[key]=n;}
 if(input.sender_email!==undefined){next.sender_email=emailAddress(input.sender_email);if(!next.sender_email)throw fail('Correo remitente no válido.');}
 if(input.sender_name!==undefined)next.sender_name=String(input.sender_name).replace(/[\r\n]/g,' ').trim().slice(0,120);
 if(input.smtp_host!==undefined){if(!['smtp.hostinger.com','smtp.titan.email'].includes(input.smtp_host))throw fail('Selecciona el servidor SMTP de Hostinger o Titan.');next.smtp_host=input.smtp_host;}
 if(input.smtp_port!==undefined){if(![465,587].includes(Number(input.smtp_port)))throw fail('El puerto SMTP debe ser 465 o 587.');next.smtp_port=Number(input.smtp_port);}
 if(input.imap_host!==undefined){if(!['imap.hostinger.com','imap.titan.email'].includes(input.imap_host))throw fail('Servidor IMAP no admitido.');next.imap_host=input.imap_host;}
 if(input.imap_folder!==undefined){next.imap_folder=String(input.imap_folder).trim().slice(0,150);if(!next.imap_folder||/[\r\n\0]/.test(next.imap_folder))throw fail('Carpeta IMAP no válida.');}
 if(input.imap_enabled!==undefined)next.imap_enabled=input.imap_enabled===true;
 if(input.password){if(typeof input.password!=='string'||input.password.length>512)throw fail('Contraseña no válida.');next.password_box=encryptSecret(input.password);}
 if(input.limits_confirmed!==undefined)next.limits_confirmed=input.limits_confirmed===true;
 const changed=input.password||['smtp_host','smtp_port','sender_email'].some(k=>old[k]!==next[k]);if(changed){next.smtp_verified_at=null;next.sending_enabled=false;}
 if(input.sending_enabled!==undefined){next.sending_enabled=input.sending_enabled===true;if(next.sending_enabled&&(!next.password_box||!next.smtp_verified_at||!next.limits_confirmed||next.provider_daily_limit<=next.reserved_daily))throw fail('Configura y verifica SMTP y confirma el límite disponible antes de habilitar los envíos.');}
 if(['sender_email','imap_host','imap_folder'].some(k=>old[k]!==next[k]))await query('UPDATE saas.campaign_settings SET imap_uid_validity=NULL,imap_last_uid=0 WHERE id=TRUE');
 const keys=['sender_email','sender_name','smtp_host','smtp_port','password_box','provider_daily_limit','daily_limit','reserved_daily','minimum_gap_days','sending_enabled','smtp_verified_at','limits_confirmed','imap_host','imap_folder','imap_enabled'];
 const result=await query(`UPDATE saas.campaign_settings SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=TRUE RETURNING *`,keys.map(k=>k==='password_box'?JSON.stringify(next[k]):next[k]));return publicSettings(result.rows[0]);
}
export function campaignTransport(s){if(!s.password_box)throw fail('Falta configurar la contraseña SMTP.');return nodemailer.createTransport({host:s.smtp_host,port:s.smtp_port,secure:s.smtp_port===465,requireTLS:s.smtp_port!==465,auth:{user:s.sender_email,pass:decryptSecret(s.password_box)},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,tls:{rejectUnauthorized:true},disableFileAccess:true,disableUrlAccess:true});}
export async function verifyCampaignSmtp({transportFactory=campaignTransport}={}){const s=await campaignSettings(),transport=transportFactory(s);try{await transport.verify();const r=await query('UPDATE saas.campaign_settings SET smtp_verified_at=NOW(),last_error=NULL WHERE id=TRUE AND sender_email=$1 AND smtp_host=$2 AND smtp_port=$3 AND password_box=$4::jsonb RETURNING smtp_verified_at',[s.sender_email,s.smtp_host,s.smtp_port,JSON.stringify(s.password_box)]);if(!r.rowCount)throw fail('La configuración cambió durante la prueba. Verifica de nuevo.',409);return {verified:true};}catch(e){if(e.statusCode)throw e;throw fail('No se pudo verificar SMTP. Revisa servidor, buzón y contraseña.');}finally{transport.close();}}
export async function importCampaignList({name,source_note,permission_confirmed,contacts,adminId}){
 if(!name?.trim()||!source_note?.trim()||!contacts.length)throw fail('Indica nombre, procedencia y al menos un correo válido.');const client=await pool.connect();try{await client.query('BEGIN');const list=(await client.query('INSERT INTO saas.campaign_lists(name,source_note,permission_confirmed,created_by) VALUES($1,$2,$3,$4) RETURNING *',[name.trim().slice(0,180),source_note.trim().slice(0,2000),permission_confirmed===true,adminId])).rows[0];
 for(let offset=0;offset<contacts.length;offset+=500){const batch=contacts.slice(offset,offset+500);const rows=(await client.query(`INSERT INTO saas.campaign_contacts(email,company_name,contact_name) SELECT email,company_name,contact_name FROM jsonb_to_recordset($1::jsonb) AS x(email text,company_name text,contact_name text) ON CONFLICT(email) DO UPDATE SET company_name=CASE WHEN EXCLUDED.company_name<>'' THEN EXCLUDED.company_name ELSE saas.campaign_contacts.company_name END RETURNING id`,[JSON.stringify(batch)])).rows;await client.query('INSERT INTO saas.campaign_list_contacts(list_id,contact_id) SELECT $1,UNNEST($2::uuid[]) ON CONFLICT DO NOTHING',[list.id,rows.map(r=>r.id)]);}
 await client.query('COMMIT');return list;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function saveCampaign(input,adminId,id){
 const name=String(input.name??'').trim().slice(0,180),subject=String(input.subject??'').trim(),body=String(input.body_text??'').trim();if(!name||!subject||subject.length>180||/[\r\n]/.test(subject)||body.length<20||body.length>20000)throw fail('Completa nombre, asunto y mensaje (entre 20 y 20.000 caracteres).');
 let url;try{url=new URL(input.cta_url);}catch{throw fail('El enlace de la campaña no es válido.');}if(url.protocol!=='https:'||url.username||url.password)throw fail('El enlace debe usar HTTPS.');
 const repeat=input.repeat_days==null||input.repeat_days===''?null:Number(input.repeat_days);if(repeat!==null&&(!Number.isInteger(repeat)||repeat<2||repeat>365))throw fail('La repetición debe ser de 2 a 365 días.');
 const list=(await query("SELECT id FROM saas.campaign_lists WHERE id=$1 AND import_status='ready' AND provider_only=TRUE",[input.list_id])).rows[0];if(!list)throw fail('Selecciona una lista importada con el filtro Es proveedor = Sí.');
 const args=[list.id,name,subject,body,String(input.cta_label??'Conocer CernoIA').slice(0,100),url.href,repeat,input.track_opens!==false,input.track_clicks!==false];
 if(id){const result=await query(`UPDATE saas.email_campaigns SET list_id=$1,name=$2,subject=$3,body_text=$4,cta_label=$5,cta_url=$6,repeat_days=$7,track_opens=$8,track_clicks=$9,updated_at=NOW() WHERE id=$10 AND status IN ('draft','paused') RETURNING *`,[...args,id]);if(!result.rowCount)throw fail('Pausa la campaña antes de editarla.',409);return result.rows[0];}
 return (await query(`INSERT INTO saas.email_campaigns(list_id,name,subject,body_text,cta_label,cta_url,repeat_days,track_opens,track_clicks,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[...args,adminId])).rows[0];
}
export async function campaignStatus(id,status){if(!['active','paused'].includes(status))throw fail('Estado no válido.');if(status==='active'){const s=await campaignSettings();if(!s.sending_enabled||!s.smtp_verified_at)throw fail('Habilita primero el remitente verificado.');const list=(await query('SELECT l.permission_confirmed,l.import_status,l.provider_only FROM saas.email_campaigns c JOIN saas.campaign_lists l ON l.id=c.list_id WHERE c.id=$1',[id])).rows[0];if(!list?.provider_only)throw fail('Vuelve a importar la lista con la columna Es proveedor; solo se admite Sí.');if(!list?.permission_confirmed||list.import_status!=='ready')throw fail('Confirma que tienes autorización para contactar a esta lista.');}const r=await query('UPDATE saas.email_campaigns SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[id,status]);if(!r.rowCount)throw fail('Campaña no encontrada.',404);return r.rows[0];}
// Keep the scheduler invocation bounded: a transient SMTP failure must finish
// before n8n's HTTP timeout instead of accumulating several socket timeouts.
export async function dispatchCampaigns({transportFactory=campaignTransport,clock=()=>new Date(),addressValidator=validateCampaignAddress,maxBatch=1}={}){
 const client=await pool.connect();let locked=false,transport;const result={attempted:0,accepted:0,failed:0,reason:null};
 try{locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('owner-campaign-dispatch')) AS locked")).rows[0].locked;if(!locked)return {...result,reason:'busy'};
 await client.query("WITH stale AS (UPDATE saas.campaign_deliveries SET status='uncertain',diagnostic='El envío fue interrumpido; revisar antes de reenviar.',updated_at=NOW() WHERE status='sending' AND attempted_at<NOW()-INTERVAL '5 minutes' RETURNING contact_id) UPDATE saas.campaign_contacts SET suppression=COALESCE(suppression,'uncertain'),suppressed_at=COALESCE(suppressed_at,NOW()) WHERE id IN (SELECT contact_id FROM stale)");
 for(let n=0;n<maxBatch;n++){
  if(!campaignMorningOpen(clock())){result.reason='outside_morning_window';break;}
  await client.query('BEGIN');const s=(await client.query('SELECT * FROM saas.campaign_settings WHERE id=TRUE FOR UPDATE')).rows[0];
  if(!(s.owner_admin_id||s.owner_user_id)||!s.sending_enabled||!s.smtp_verified_at||!s.password_box||!s.limits_confirmed){await client.query('ROLLBACK');result.reason='disabled';break;}
  const cap=Math.max(0,Math.min(s.daily_limit,s.provider_daily_limit-s.reserved_daily));const usage=(await client.query(`SELECT COUNT(*)::int AS rolling,COUNT(*) FILTER(WHERE attempted_at>=date_trunc('day',NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota')::int AS today,COUNT(*) FILTER(WHERE attempted_at>NOW()-INTERVAL '60 seconds')::int AS minute FROM saas.campaign_deliveries WHERE attempted_at>NOW()-INTERVAL '24 hours'`)).rows[0];
  const minuteLimit=Number(process.env.CAMPAIGN_DISPATCH_RATE)|| (s.smtp_host==='smtp.hostinger.com'?4:2);
  if(usage.rolling>=cap||usage.today>=s.daily_limit||usage.minute>=minuteLimit){await client.query('ROLLBACK');result.reason='limit';break;}
  const candidate=(await client.query(`SELECT c.*,ct.id AS contact_id,ct.email,ct.company_name,ct.quality_status,ct.email_checked_at FROM saas.email_campaigns c JOIN saas.campaign_lists l ON l.id=c.list_id AND l.permission_confirmed AND l.import_status='ready' AND l.provider_only=TRUE JOIN saas.campaign_list_contacts lc ON lc.list_id=l.id JOIN saas.campaign_contacts ct ON ct.id=lc.contact_id WHERE c.status='active' AND ct.suppression IS NULL AND (ct.quality_status IN ('valid','unchecked') OR (ct.quality_status='pending' AND ct.email_checked_at<NOW()-INTERVAL '6 hours')) AND NOT EXISTS(SELECT 1 FROM saas.campaign_contact_exclusions ex WHERE ex.email_hash=encode(sha256(convert_to(ct.email,'UTF8')),'hex')) AND (ct.last_attempt_at IS NULL OR ct.last_attempt_at<NOW()-make_interval(days=>$1)) AND NOT EXISTS(SELECT 1 FROM saas.campaign_deliveries d WHERE d.contact_id=ct.id AND d.campaign_id=c.id AND (c.repeat_days IS NULL OR d.attempted_at>NOW()-make_interval(days=>c.repeat_days)) AND (d.status<>'deferred' OR (SELECT COUNT(*) FROM saas.campaign_deliveries retry WHERE retry.campaign_id=c.id AND retry.contact_id=ct.id AND retry.status='deferred' AND retry.attempted_at>NOW()-INTERVAL '30 days')>=3)) ORDER BY ct.last_attempt_at ASC NULLS FIRST,c.last_dispatched_at ASC NULLS FIRST,c.created_at,ct.id LIMIT 1 FOR UPDATE OF c,ct SKIP LOCKED`,[s.minimum_gap_days])).rows[0];
  if(!candidate){await client.query('ROLLBACK');result.reason='no_eligible_contacts';break;}
  if(candidate.quality_status!=='valid'||!candidate.email_checked_at||new Date(candidate.email_checked_at).getTime()<Date.now()-86400000){
   const quality=await addressValidator(candidate.email);
   await client.query('UPDATE saas.campaign_contacts SET quality_status=$2,quality_reason=$3,email_suggestion=$4,email_checked_at=NOW() WHERE id=$1',[candidate.contact_id,quality.status,quality.reason,quality.suggestion??null]);
   if(quality.status!=='valid'){await client.query('COMMIT');result.reason='contacts_quarantined';continue;}
  }
  const id=randomUUID(),token=randomBytes(32).toString('base64url'),messageId=`<cernoia-campaign-${id}@${s.sender_email.split('@')[1]}>`;
  const contact=(await client.query('UPDATE saas.campaign_contacts SET attribution_cid=COALESCE(attribution_cid,gen_random_uuid()) WHERE id=$1 RETURNING attribution_cid',[candidate.contact_id])).rows[0];
  const destination=campaignDestination(candidate.cta_url,contact.attribution_cid,candidate.id,publicCampaignBase);
  const delivery=(await client.query(`INSERT INTO saas.campaign_deliveries(id,campaign_id,contact_id,email,company_name,subject,body_text,cta_label,cta_url,tracking_token,track_opens,track_clicks,status,message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sending',$13) RETURNING *`,[id,candidate.id,candidate.contact_id,candidate.email,candidate.company_name,candidate.subject,candidate.body_text,candidate.cta_label,destination,token,candidate.track_opens,candidate.track_clicks,messageId])).rows[0];
  await client.query('UPDATE saas.campaign_contacts SET last_attempt_at=NOW() WHERE id=$1',[candidate.contact_id]);await client.query('UPDATE saas.email_campaigns SET last_dispatched_at=NOW() WHERE id=$1',[candidate.id]);await client.query('COMMIT');result.attempted++;
  // A reservation is durable before contacting SMTP. Unknown outcomes are never
  // retried automatically, so an n8n retry cannot duplicate the same delivery.
  const current=(await client.query('SELECT suppression FROM saas.campaign_contacts WHERE id=$1',[candidate.contact_id])).rows[0];const enabled=(await client.query("SELECT s.sending_enabled AND c.status='active' AS enabled FROM saas.campaign_settings s JOIN saas.email_campaigns c ON c.id=$1 WHERE s.id=TRUE",[candidate.id])).rows[0].enabled;
  if(!current||current.suppression||!enabled||!campaignMorningOpen(clock())){await client.query("UPDATE saas.campaign_deliveries SET status='rejected',diagnostic='Cancelado antes de contactar SMTP',updated_at=NOW() WHERE id=$1",[id]);continue;}
  transport??=transportFactory(s);
  try{const info=await transport.sendMail(campaignMail(delivery,s,publicCampaignBase));if(!info.accepted?.some(e=>String(e).toLowerCase()===delivery.email))throw Object.assign(Error('SMTP no aceptó el destinatario.'),{responseCode:550});await client.query("UPDATE saas.campaign_deliveries SET status='accepted',accepted_at=NOW(),smtp_response=$2,updated_at=NOW() WHERE id=$1 AND status='sending'",[id,String(info.response??'').slice(0,1000)]);await client.query('UPDATE saas.campaign_contacts SET last_sent_at=NOW() WHERE id=$1',[candidate.contact_id]);result.accepted++;await client.query("UPDATE saas.campaign_settings SET last_error=NULL WHERE id=TRUE AND last_error ~* '(timeout|timed out|connection|socket|ECONN|ENOTFOUND|EAI_AGAIN)'");}
  catch(e){const failure=smtpFailure(e);await client.query('UPDATE saas.campaign_deliveries SET status=$2,diagnostic=$3,error_code=$4,updated_at=NOW() WHERE id=$1 AND status=\'sending\'',[id,failure.status,failure.diagnostic,String(e.code??e.responseCode??'UNKNOWN').slice(0,80)]);if(failure.suppression)await client.query('UPDATE saas.campaign_contacts SET suppression=COALESCE(suppression,$2),suppressed_at=COALESCE(suppressed_at,NOW()) WHERE id=$1',[candidate.contact_id,failure.suppression]);result.failed++;if(failure.pause||(failure.status==='uncertain'&&!failure.transient)){await client.query('UPDATE saas.campaign_settings SET sending_enabled=FALSE,last_error=$1 WHERE id=TRUE',[failure.diagnostic]);break;}if(failure.transient){await client.query('UPDATE saas.campaign_settings SET last_error=$1 WHERE id=TRUE',[failure.diagnostic]);result.reason='temporary_connection_error';break;}}
 }
 await client.query('UPDATE saas.campaign_settings SET last_run_at=NOW() WHERE id=TRUE');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{transport?.close?.();if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('owner-campaign-dispatch'))").catch(()=>{});client.release();}
}
