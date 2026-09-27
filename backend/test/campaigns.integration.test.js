import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';

test('Campañas: aislamiento, límites, concurrencia, bajas y notificaciones', {skip:process.env.CAMPAIGN_TEST_DATABASE!=='isolated'},async()=>{
 const {pool,query}=await import('../src/db.js');const {config}=await import('../src/config.js');
 assert.match(new URL(config.databaseUrl).pathname,/^\/cernoia_campaign_test_/,'Solo se permite una base efímera de pruebas');
 const {encryptSecret}=await import('../src/services/secret-box.js');
 const {importCampaignList,saveCampaign,dispatchCampaigns,publicSettings,campaignSettings}=await import('../src/services/campaigns.js');
 const {recordFeedback}=await import('../src/services/campaign-feedback.js');
 const {campaignOwnerRouter,campaignIntegrationRouter,campaignPublicRouter}=await import('../src/routes/campaigns.js');
 const {validateCsrf}=await import('../src/middleware/csrf.js');
 const {hashPlatformToken}=await import('../src/middleware/platform-auth.js');const {default:express}=await import('express');const {default:cookieParser}=await import('cookie-parser');
 let server;
 try{
 const admin=randomUUID(),other=randomUUID();await query("INSERT INTO saas.platform_admin_users(id,email,full_name,status,password_hash) VALUES($1,'owner@example.com','Owner','active','unused-test'),($2,'other@example.com','Other','active','unused-test')",[admin,other]);
 const ownerToken=randomBytes(32).toString('hex'),otherToken=randomBytes(32).toString('hex');
 for(const [id,token] of [[admin,ownerToken],[other,otherToken]])await query("INSERT INTO saas.platform_admin_sessions(admin_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')",[id,hashPlatformToken(token)]);
 await query('UPDATE saas.campaign_settings SET owner_admin_id=$1,password_box=$2,smtp_verified_at=NOW(),sending_enabled=TRUE,limits_confirmed=TRUE,provider_daily_limit=1000,daily_limit=2,reserved_daily=0',[admin,JSON.stringify(encryptSecret('fake-password-no-network'))]);
 assert.ok(!('password_box' in publicSettings(await campaignSettings())));
 const contacts=Array.from({length:5},(_,i)=>({email:`company${i}@example.com`,company_name:`Empresa ${i}`,contact_name:''}));
 const list=await importCampaignList({name:'Lista aislada',source_note:'Prueba autorizada sin envío',permission_confirmed:true,contacts,adminId:admin});
 const campaign=await saveCampaign({list_id:list.id,name:'Prueba',subject:'Hola {empresa}',body_text:'Mensaje de prueba completamente simulado.',cta_url:'https://example.com',repeat_days:null},admin);
 await query("UPDATE saas.email_campaigns SET status='active' WHERE id=$1",[campaign.id]);
 const sends=[];const transportFactory=()=>({async sendMail(mail){sends.push(mail.to);await new Promise(r=>setTimeout(r,30));return {accepted:[mail.to],response:'250 mock accepted'};},close(){}});
 const both=await Promise.all([dispatchCampaigns({transportFactory,maxBatch:2}),dispatchCampaigns({transportFactory,maxBatch:2})]);
 assert.equal(sends.length,2);assert.equal(new Set(sends).size,2);assert.ok(both.some(r=>r.reason==='busy'));assert.equal((await dispatchCampaigns({transportFactory})).reason,'limit');
 const d=(await query('SELECT * FROM saas.campaign_deliveries ORDER BY attempted_at LIMIT 1')).rows[0];
 assert.equal(await recordFeedback({id:d.id,recipient:'wrong@example.com',type:'bounced',diagnostic:'wrong'},'bad-recipient'),false);
 assert.equal(await recordFeedback({id:d.id,recipient:d.email,type:'bounced',diagnostic:'5.1.1'},'bounce-one'),true);
 assert.equal(await recordFeedback({id:d.id,recipient:d.email,type:'bounced',diagnostic:'5.1.1'},'bounce-one'),false);
 await recordFeedback({id:d.id,recipient:d.email,type:'delivered',diagnostic:'Late success'},'late-success');
 const after=(await query('SELECT status,delivered_at FROM saas.campaign_deliveries WHERE id=$1',[d.id])).rows[0];assert.equal(after.status,'bounced');assert.equal(after.delivered_at,null);
 const app=express();app.use('/api/campaign-public',campaignPublicRouter);app.use(express.json(),cookieParser(),validateCsrf);app.use('/api',campaignOwnerRouter,campaignIntegrationRouter);app.use((e,req,res,next)=>res.status(e.statusCode??500).json({error:e.message}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const headers=token=>({Cookie:`${config.platformCookieName}=${token}`});
 assert.equal((await fetch(base+'/api/platform/campaigns')).status,401);assert.equal((await fetch(base+'/api/platform/campaigns',{headers:headers(otherToken)})).status,403);
 const ownerResponse=await fetch(base+'/api/platform/campaigns',{headers:headers(ownerToken)});assert.equal(ownerResponse.status,200);assert.ok(!(await ownerResponse.text()).includes('password_box'));
 assert.equal((await fetch(base+'/api/integrations/campaigns/dispatch',{method:'POST'})).status,403);
 const uploadUrl=base+'/api/platform/campaigns/lists/import?filename=test.csv&name=API&source_note=Prueba%20HTTP&permission_confirmed=true';
 assert.equal((await fetch(uploadUrl,{method:'POST',headers:{...headers(ownerToken),'Content-Type':'application/octet-stream'},body:'email,empresa\nraw@example.com,HTTP'})).status,403);
 assert.equal((await fetch(uploadUrl,{method:'POST',headers:{Cookie:`${config.platformCookieName}=${ownerToken}; ${config.csrfCookieName}=test-csrf`,'X-CSRF-Token':'test-csrf','Content-Type':'application/octet-stream'},body:'email,empresa\nraw@example.com,HTTP'})).status,202);
 const unsub=(await query("SELECT * FROM saas.campaign_deliveries WHERE id<>$1 LIMIT 1",[d.id])).rows[0];
 assert.equal((await fetch(base+'/api/campaign-public/open/'+unsub.tracking_token+'.gif')).status,200);
 assert.equal((await query('SELECT status FROM saas.campaign_deliveries WHERE id=$1',[unsub.id])).rows[0].status,'accepted');
 assert.equal((await fetch(base+'/api/campaign-public/unsubscribe/'+unsub.tracking_token)).status,200);
 assert.equal((await query('SELECT suppression FROM saas.campaign_contacts WHERE id=$1',[unsub.contact_id])).rows[0].suppression,null);
 assert.equal((await fetch(base+'/api/campaign-public/unsubscribe/'+unsub.tracking_token,{method:'POST'})).status,200);
 await importCampaignList({name:'Reimportación',source_note:'Mismos contactos de prueba',permission_confirmed:true,contacts,adminId:admin});
 assert.equal((await query('SELECT suppression FROM saas.campaign_contacts WHERE id=$1',[unsub.contact_id])).rows[0].suppression,'unsubscribe');
 // A midnight rollover cannot bypass the rolling 24-hour provider budget.
 await query("UPDATE saas.campaign_deliveries SET attempted_at=NOW()-INTERVAL '3 hours'");assert.equal((await dispatchCampaigns({transportFactory})).reason,'limit');
 await query("UPDATE saas.campaign_deliveries SET attempted_at=NOW()-INTERVAL '3 days'");await query("UPDATE saas.campaign_contacts SET last_attempt_at=NOW()-INTERVAL '3 days' WHERE last_attempt_at IS NOT NULL");
 const next=await dispatchCampaigns({transportFactory,maxBatch:2});assert.equal(next.accepted,2);assert.equal(new Set(sends).size,4);assert.ok(!sends.slice(2).includes(unsub.email));
 // A crash after reservation must not be automatically resent by n8n.
 await query("UPDATE saas.campaign_deliveries SET status='sending',attempted_at=NOW()-INTERVAL '10 minutes' WHERE id=(SELECT id FROM saas.campaign_deliveries ORDER BY attempted_at DESC LIMIT 1)");
 await dispatchCampaigns({transportFactory});assert.equal((await query("SELECT COUNT(*)::int AS n FROM saas.campaign_contacts WHERE suppression='uncertain'")).rows[0].n,1);
 }finally{if(server)await new Promise(r=>server.close(r));await pool.end();}
});
