import {query,pool} from '../db.js';
import {decryptSecret} from './secret-box.js';
import {campaignSettings} from './campaigns.js';
import {eventHash} from './campaign-rules.js';
const IMAP_ERROR='No se pudo revisar el buzón de rebotes. Comprueba IMAP y la carpeta.';
export function feedbackReport(parts){
 const text=parts.join('\n').replace(/\r?\n[ \t]+/g,' ');const id=text.match(/cernoia-campaign-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})@/i)?.[1]??text.match(/Original-Envelope-Id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i)?.[1];if(!id)return null;
 if(/Feedback-Type:\s*(abuse|fraud)/i.test(text))return {id,type:'complaint',diagnostic:'Reporte de abuso recibido por correo.'};
 const action=text.match(/(?:^|\n)Action:\s*(failed|delayed|delivered|relayed|expanded)/i)?.[1]?.toLowerCase();if(!action||['relayed','expanded'].includes(action))return null;
 const recipient=text.match(/(?:^|\n)Final-Recipient:\s*rfc822;\s*([^\s<>]+)/i)?.[1]?.toLowerCase();if(!recipient)return null;
 const code=text.match(/(?:^|\n)Status:\s*([245]\.\d+\.\d+)/i)?.[1]??'',diagnostic=text.match(/(?:^|\n)Diagnostic-Code:\s*([^\r\n]+)/i)?.[1]?.slice(0,1000)??code;
 return {id,recipient,type:action==='delivered'?'delivered':action==='delayed'?'deferred':code.startsWith('5.7.')?'rejected':'bounced',diagnostic,code};
}
export async function recordFeedback(report,eventKey){
 const client=await pool.connect();try{await client.query('BEGIN');const d=(await client.query('SELECT * FROM saas.campaign_deliveries WHERE id=$1 FOR UPDATE',[report.id])).rows[0];if(!d||report.recipient&&report.recipient!==d.email){await client.query('ROLLBACK');return false;}
 const event=await client.query('INSERT INTO saas.campaign_events(delivery_id,event_type,event_key,details) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id',[d.id,report.type,eventKey,JSON.stringify({diagnostic:report.diagnostic,code:report.code})]);if(!event.rowCount){await client.query('ROLLBACK');return false;}
 if(report.type==='complaint')await client.query('UPDATE saas.campaign_deliveries SET complaint_at=COALESCE(complaint_at,NOW()),updated_at=NOW() WHERE id=$1',[d.id]);
 else await client.query(`UPDATE saas.campaign_deliveries SET status=CASE WHEN status IN ('bounced','rejected') AND $2 IN ('delivered','deferred') THEN status ELSE $2 END,delivered_at=CASE WHEN $2='delivered' AND status NOT IN ('bounced','rejected') THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,bounced_at=CASE WHEN $2='bounced' THEN COALESCE(bounced_at,NOW()) ELSE bounced_at END,diagnostic=$3,updated_at=NOW() WHERE id=$1`,[d.id,report.type,report.diagnostic]);
 const suppression={bounced:'hard_bounce',rejected:'blocked',complaint:'complaint'}[report.type];if(suppression)await client.query('UPDATE saas.campaign_contacts SET suppression=COALESCE(suppression,$2),suppressed_at=COALESCE(suppressed_at,NOW()) WHERE id=$1',[d.contact_id,suppression]);await client.query('COMMIT');return true;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function pollCampaignFeedback(){
 const lock=await pool.connect();let locked=false,imap;try{locked=(await lock.query("SELECT pg_try_advisory_lock(hashtext('owner-campaign-feedback')) AS locked")).rows[0].locked;if(!locked)return {reason:'busy'};const s=await campaignSettings();if(!s.imap_enabled||!s.password_box)return {reason:'disabled'};
 const {ImapFlow}=await import('imapflow');const {simpleParser}=await import('mailparser');
 imap=new ImapFlow({host:s.imap_host,port:993,secure:true,auth:{user:s.sender_email,pass:decryptSecret(s.password_box)},logger:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableAutoIdle:true});
 imap.on('error',()=>{});await imap.connect();const mailbox=await imap.mailboxOpen(s.imap_folder,{readOnly:true});const validity=String(mailbox.uidValidity);let uid=s.imap_uid_validity===validity?Number(s.imap_last_uid):Math.max(0,Number(mailbox.uidNext)-200);
 const max=Number(mailbox.uidNext)-1;let processed=0,events=0,skipped=0;if(uid<max){const metadata=[];for await(const m of imap.fetch(`${uid+1}:${Math.min(max,uid+20)}`,{uid:true,size:true},{uid:true}))metadata.push(m);
 const rangeEnd=Math.min(max,uid+20);
 for(const m of metadata){if(m.size>2*1024*1024){skipped++;uid=m.uid;continue;}const message=await imap.fetchOne(m.uid,{source:true},{uid:true});if(!message?.source){uid=m.uid;continue;}const mail=await simpleParser(message.source,{keepDeliveryStatus:true,skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
 const parts=[mail.text??'',...mail.headerLines.map(h=>h.line),...(mail.attachments??[]).filter(a=>/^message\/(delivery-status|feedback-report|rfc822)$|^text\/rfc822-headers$/.test(a.contentType)).map(a=>a.content.toString())];
 const report=/multipart\/report/i.test(String(mail.headers.get('content-type')?.value??''))||mail.attachments.some(a=>/^message\/(delivery-status|feedback-report)$/.test(a.contentType))?feedbackReport(parts):null;if(report&&await recordFeedback(report,eventHash(validity+':'+m.uid+':'+s.sender_email)))events++;processed++;uid=m.uid;}uid=Math.max(uid,rangeEnd);
 }
 await query('UPDATE saas.campaign_settings SET imap_uid_validity=$1,imap_last_uid=$2,last_feedback_at=NOW(),last_error=CASE WHEN last_error=$3 THEN NULL ELSE last_error END WHERE id=TRUE',[validity,uid,IMAP_ERROR]);return {processed,events,skipped_large_messages:skipped};
 }catch(e){await query("UPDATE saas.campaign_settings SET last_error=COALESCE(last_error,$1) WHERE id=TRUE",[IMAP_ERROR]).catch(()=>{});return {error:'IMAP_UNAVAILABLE'};}finally{if(imap)await imap.logout().catch(()=>imap.close());if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('owner-campaign-feedback'))").catch(()=>{});lock.release();}
}
