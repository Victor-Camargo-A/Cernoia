import {inspectAddress} from './campaign-hygiene.js';
import {createHash} from 'node:crypto';
import PizZip from 'pizzip';
export const fail=(message,statusCode=422)=>Object.assign(Error(message),{statusCode});
export const emailAddress=s=>{const value=String(s??'').trim().toLowerCase();return inspectAddress(value).status!=='invalid'&&value.length<=254&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(value)&&!value.includes('..')?value:null;};
export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const eventHash=s=>createHash('sha256').update(s).digest('hex');
const unxml=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
export function parseCsv(text){
 text=text.replace(/^\uFEFF/,'');const header=text.split(/\r?\n/,1)[0],delimiter=header.split(';').length>header.split(',').length?';':',';
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(quoted||!value)quoted=!quoted;else throw fail('Comillas no válidas en el CSV.');}else if(c===delimiter&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(s=>s.trim()))rows.push(row);row=[];value='';}else value+=c;if(rows.length>50001||value.length>10000)throw fail('El archivo supera 50.000 filas o contiene una celda demasiado larga.');}
 if(quoted)throw fail('El CSV tiene una celda entre comillas sin cerrar.');row.push(value);if(row.some(s=>s.trim()))rows.push(row);return rows;
}
export function parseXlsx(buffer){
 const zip=new PizZip(buffer);let total=0;for(const f of Object.values(zip.files)){total+=f._data?.uncompressedSize??0;if(total>40*1024*1024)throw fail('El Excel descomprimido supera 40 MB.');}
 const strings=[...(zip.file('xl/sharedStrings.xml')?.asText()??'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>unxml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')));
 const workbook=zip.file('xl/workbook.xml')?.asText()??'',rid=workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
 const rels=zip.file('xl/_rels/workbook.xml.rels')?.asText()??'';const rel=[...rels.matchAll(/<Relationship\b[^>]*\/>/g)].find(m=>m[0].includes(`Id="${rid}"`))?.[0];
 const target=rel?.match(/Target="([^"]+)"/)?.[1];if(!target||target.includes('..')||rel.includes('TargetMode="External"'))throw fail('No se pudo leer la primera hoja del Excel.');
 const sheet=zip.file(target.startsWith('/')?target.slice(1):'xl/'+target)?.asText();if(!sheet)throw fail('La primera hoja no está disponible.');const rows=[];
 for(const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){const cells=[];for(const c of r[1].matchAll(/<c\b([^>]*)(?:>([\s\S]*?)<\/c>|\/>)/g)){const ref=c[1].match(/\br="([A-Z]+)\d+"/)?.[1];if(!ref)continue;const column=[...ref].reduce((n,v)=>n*26+v.charCodeAt(0)-64,0)-1;if(column>200)throw fail('El Excel tiene demasiadas columnas.');const body=c[2]??'';if(/<f\b/.test(body))continue;const value=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]??'';cells[column]=/\bt="s"/.test(c[1])?strings[Number(value)]??'':unxml(/\bt="inlineStr"/.test(c[1])?[...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m=>m[1]).join(''):value);}
 if(cells.some(Boolean))rows.push(cells);if(rows.length>50001)throw fail('El Excel supera 50.000 filas.');}return rows;
}
export function importRows(rows){
 if(rows.length<2)throw fail('Incluye encabezados y al menos un contacto.');const normalized=rows[0].map(s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[ _-]+/g,''));
 const index=names=>normalized.findIndex(h=>names.includes(h)),email=index(['email','correo','correoelectronico','emailaddress']),company=index(['empresa','razonsocial','company','companyname']),name=index(['contacto','nombre','contactname']);if(email<0)throw fail('Falta una columna email o correo.');
 const unique=new Map(),invalid=[];let duplicates=0;for(const [i,row] of rows.slice(1).entries()){const address=emailAddress(row[email]);if(!address){if(invalid.length<20)invalid.push(i+2);continue;}if(unique.has(address)){duplicates++;continue;}unique.set(address,{email:address,company_name:String(row[company]??'').trim().slice(0,300),contact_name:String(row[name]??'').trim().slice(0,180)});}
 return {contacts:[...unique.values()],invalid_count:rows.length-1-unique.size-duplicates,invalid_rows:invalid,duplicates};
}
export function campaignMail(delivery,settings,baseUrl){
 const root=baseUrl.replace(/\/$/,''),link=`${root}/api/campaign-public/click/${delivery.tracking_token}`,unsubscribe=`${root}/api/campaign-public/unsubscribe/${delivery.tracking_token}`;
 const personalize=text=>String(text).replace(/\{empresa\}|\{\{empresa\}\}/g,delivery.company_name||'tu empresa').replace(/\{\{nombre\}\}|\{nombre\}/g,delivery.contact_name||'equipo').replace(/\{\{url_demo\}\}|\{url_demo\}/g,delivery.cta_url||'').replace(/\{\{correo_cernoia\}\}/g,settings.sender_email);
 const subject=personalize(delivery.subject).replace(/[\r\n]/g,' ').slice(0,180),body=personalize(delivery.body_text);
 const plain=body.replace(/\*\*(.*?)\*\*/g,'$1'),render=p=>escapeHtml(p).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/https:\/\/wa\.me\/573207830189/g,'<a href="https://wa.me/573207830189">Escribirme por WhatsApp</a>').replace(/\n/g,'<br>');
 return {from:{name:settings.sender_name,address:settings.sender_email},to:delivery.email,replyTo:settings.sender_email,envelope:{from:settings.sender_email,to:[delivery.email]},messageId:delivery.message_id,subject,text:`${plain}\n\n${delivery.cta_label}: ${delivery.track_clicks?link:delivery.cta_url}\n\nDejar de recibir estos correos: ${unsubscribe}`,html:`<!doctype html><html lang="es"><body><div style="max-width:620px;margin:auto;font:16px Arial,sans-serif;line-height:1.6;color:#153c44"><h2>CernoIA</h2>${body.split(/\n\n+/).map(p=>`<p>${render(p)}</p>`).join('')}<p><a href="${escapeHtml(delivery.track_clicks?link:delivery.cta_url)}">${escapeHtml(delivery.cta_label)}</a></p><hr><p style="font-size:12px">Enviado por ${escapeHtml(settings.sender_name)} · ${escapeHtml(settings.sender_email)}<br><a href="${unsubscribe}">Dejar de recibir estos correos</a></p>${delivery.track_opens?`<img src="${root}/api/campaign-public/open/${delivery.tracking_token}.gif" alt="" width="1" height="1">`:''}</div></body></html>`,headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},dsn:{id:delivery.id,return:'headers',notify:['failure','delay','success'],recipient:delivery.email}};
}
export function smtpFailure(error){const code=Number(error.responseCode),diagnostic=String(error.response??error.message??'Error SMTP').slice(0,1000);if(error.code==='EAUTH'||code===535)return {status:'deferred',suppression:null,diagnostic:'La autenticación del buzón falló. Revisa las credenciales.',pause:true};if(['ETIMEDOUT','ECONNECTION','ECONNRESET','ECONNREFUSED','EDNS','ESOCKET'].includes(error.code)&&(!code||code<500)){const beforeData=['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error.command);return {status:beforeData?'deferred':'uncertain',suppression:beforeData?null:'uncertain',diagnostic,transient:true};}if(['CONN','EHLO','HELO','STARTTLS','MAIL FROM'].includes(error.command)||/sending.{0,30}(?:limit|quota)|daily.{0,30}(?:limit|quota)|rate limit|too many messages/i.test(diagnostic))return {status:'deferred',suppression:null,diagnostic,pause:true};if(code>=500){const permanentRecipient=/5\.1\.[0-3]|5\.1\.6|5\.2\.1|user unknown|no mailbox here|mailbox.*(?:not found|unavailable)|recipient.*not found/i.test(diagnostic);return {status:permanentRecipient?'bounced':'rejected',suppression:permanentRecipient?'hard_bounce':'blocked',diagnostic};}if(code>=400)return {status:'deferred',suppression:null,diagnostic};return {status:'uncertain',suppression:'uncertain',diagnostic};}

export function campaignMorningOpen(date=new Date()) {
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Bogota',hour:'2-digit',hourCycle:'h23'}).format(date));
 return hour>=7&&hour<19;
}
