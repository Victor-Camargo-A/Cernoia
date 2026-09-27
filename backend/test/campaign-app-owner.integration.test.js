import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
test('Campañas en la cuenta existente: identidad exacta, sesión vigente y exclusividad',{skip:process.env.CAMPAIGN_TEST_DATABASE!=='isolated'},async()=>{
 const {pool,query}=await import('../src/db.js');const {config}=await import('../src/config.js');assert.match(new URL(config.databaseUrl).pathname,/^\/cernoia_campaign_test_/);
 const {campaignOwnerRouter}=await import('../src/routes/campaigns.js');const {default:express}=await import('express');const {default:cookieParser}=await import('cookie-parser');const {default:jwt}=await import('jsonwebtoken');const {validateCsrf}=await import('../src/middleware/csrf.js');
 let server;
 try{
 const owner=randomUUID(),other=randomUUID(),org=randomUUID(),otherOrg=randomUUID();
 for(const [id,oid,email] of [[owner,org,'director@energeticanika.com'],[other,otherOrg,'other@example.com']])await query("INSERT INTO saas.app_users(id,organization_id,email,full_name,password_hash,role,status) VALUES($1,$2,$3,'Fixture','unused','owner','active')",[id,oid,email]);
 await query('UPDATE saas.campaign_settings SET owner_user_id=$1 WHERE id=TRUE',[owner]);
 const sessionIds=[];const cookies=[];
 for(const [id,oid] of [[owner,org],[other,otherOrg]]){const sid=randomUUID();sessionIds.push(sid);await query("INSERT INTO saas.app_sessions(id,user_id,organization_id,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')",[sid,id,oid]);cookies.push(`${config.cookieName}=${jwt.sign({sub:id,sid,oid},config.jwtSecret,{algorithm:'HS256',issuer:config.jwtIssuer,audience:config.jwtAudience,expiresIn:3600})}; ${config.csrfCookieName}=test`);}
 const app=express();app.use(express.json(),cookieParser(),validateCsrf);app.use('/api',campaignOwnerRouter);app.use((e,req,res,next)=>res.status(e.statusCode??500).json({error:e.message}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 const call=(path,index=0,method='GET',body)=>fetch(base+path,{method,headers:{Cookie:cookies[index],'X-CSRF-Token':'test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.deepEqual(await (await call('/owner-campaigns/access')).json(),{allowed:true});assert.deepEqual(await (await call('/owner-campaigns/access',1)).json(),{allowed:false});
 assert.equal((await call('/platform/campaigns')).status,200);assert.equal((await call('/platform/campaigns',1)).status,403);
 assert.equal((await call('/platform/campaigns/settings',1,'PATCH',{sender_name:'Unauthorized'})).status,403);
 assert.equal((await call('/platform/campaigns/settings',0,'PATCH',{sender_name:'CernoIA'})).status,200);
 const upload=await fetch(base+'/platform/campaigns/lists/import?filename=test.csv&name=Fixture&source_note=Prueba%20privada&permission_confirmed=true',{method:'POST',headers:{Cookie:cookies[0],'X-CSRF-Token':'test','Content-Type':'application/octet-stream'},body:'email,empresa\nfixture@example.com,Fixture'});assert.equal(upload.status,202);const {job}=await upload.json();let imported;for(let n=0;n<200;n++){imported=(await query('SELECT * FROM saas.campaign_import_jobs WHERE id=$1',[job.id])).rows[0];if(['completed','failed'].includes(imported.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(imported.status,'completed',imported.error);const list={id:imported.list_id};
 const draft=await call('/platform/campaigns/drafts',0,'POST',{list_id:list.id,name:'Prueba',subject:'Asunto',body_text:'Mensaje de prueba sin envío real.',cta_url:'https://example.com'});assert.equal(draft.status,201);assert.equal((await draft.json()).campaign.created_by,null);
 const audit=(await query("SELECT metadata FROM saas.app_audit_log WHERE action='campaign.created'")).rows[0];assert.equal(audit.metadata.actor_type,'app_user');
 await query('UPDATE saas.app_sessions SET revoked_at=NOW() WHERE id=$1',[sessionIds[0]]);assert.equal((await call('/platform/campaigns')).status,401);
 assert.equal((await query('SELECT sending_enabled FROM saas.campaign_settings')).rows[0].sending_enabled,false);
 assert.equal((await query('SELECT COUNT(*)::int n FROM saas.platform_admin_users')).rows[0].n,0);
 }finally{if(server)await new Promise(r=>server.close(r));await pool.end();}
});
