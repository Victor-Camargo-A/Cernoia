import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {stat,readdir} from 'node:fs/promises';
test('Excel de más de 142 MB: carga por streaming, progreso, deduplicación y lista íntegra',{skip:process.env.CAMPAIGN_TEST_DATABASE!=='isolated',timeout:240000},async()=>{
 const {pool,query}=await import('../src/db.js');const {config}=await import('../src/config.js');assert.match(new URL(config.databaseUrl).pathname,/^\/cernoia_campaign_test_/);
 const {campaignOwnerRouter}=await import('../src/routes/campaigns.js');const {default:express}=await import('express');const {default:cookieParser}=await import('cookie-parser');const {default:jwt}=await import('jsonwebtoken');const {validateCsrf}=await import('../src/middleware/csrf.js');const {saveCampaign}=await import('../src/services/campaigns.js');
 let server;
 try{
 const owner=randomUUID(),org=randomUUID(),sid=randomUUID();await query("INSERT INTO saas.app_users(id,organization_id,email,full_name,password_hash,role,status) VALUES($1,$2,'owner@example.invalid','Fixture','unused','owner','active')",[owner,org]);await query('UPDATE saas.campaign_settings SET owner_user_id=$1 WHERE id=TRUE',[owner]);await query("INSERT INTO saas.app_sessions(id,user_id,organization_id,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')",[sid,owner,org]);
 const cookie=`${config.cookieName}=${jwt.sign({sub:owner,sid,oid:org},config.jwtSecret,{algorithm:'HS256',issuer:config.jwtIssuer,audience:config.jwtAudience,expiresIn:3600})}; ${config.csrfCookieName}=test`;
 const app=express();app.use(express.json(),cookieParser(),validateCsrf);app.use('/api',campaignOwnerRouter);app.use((e,req,res,next)=>res.status(e.statusCode??500).json({error:e.message}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/platform/campaigns`;
 const file='/tmp/cernoia-campaign-large-fixture.xlsx',size=(await stat(file)).size;assert.ok(size>142360059);
 const before=process.memoryUsage().rss;let peak=before;const memory=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},20);
 try{
 // The uploader runs in a separate process so RAM measurements cover the API,
 // not an in-process HTTP client buffering its own request.
 const upload=spawn('curl',['--silent','--show-error','--request','POST','--upload-file',file,'--config','-'],{stdio:['pipe','pipe','pipe']});let output='',error='';upload.stdout.on('data',c=>output+=c);upload.stderr.on('data',c=>error+=c);
 const uploaded=new Promise((resolve,reject)=>{upload.once('error',reject);upload.once('close',resolve);});
 upload.stdin.end(`url = "${base}/lists/import?filename=SECOP-prueba.xlsx&name=Prueba-grande&source_note=Datos%20simulados&permission_confirmed=true"\nheader = "Cookie: ${cookie}"\nheader = "X-CSRF-Token: test"\nheader = "Content-Type: application/octet-stream"\nwrite-out = "\\n%{http_code}"\n`);
 assert.equal(await uploaded,0,error);assert.equal(output.slice(-3),'202');const {job}=JSON.parse(output.slice(0,output.lastIndexOf('\n')));let current;

 for(let i=0;i<1200;i++){
  current=(await query('SELECT * FROM saas.campaign_import_jobs WHERE id=$1',[job.id])).rows[0];
  if(current.list_id&&current.status==='processing'){
   const state=(await query('SELECT permission_confirmed,import_status FROM saas.campaign_lists WHERE id=$1',[current.list_id])).rows[0];assert.equal(state.permission_confirmed,false);assert.equal(state.import_status,'processing');
  }
  if(['completed','failed'].includes(current.status))break;
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(current.status,'completed',current.error);assert.equal(current.total_rows,22000);assert.equal(current.unique_contacts,21000);assert.equal(current.duplicate_rows,500);assert.equal(current.invalid_rows,500);
 assert.equal((await query('SELECT COUNT(*)::int n FROM saas.campaign_list_contacts WHERE list_id=$1',[current.list_id])).rows[0].n,21000);
 assert.equal((await query('SELECT import_status FROM saas.campaign_lists WHERE id=$1',[current.list_id])).rows[0].import_status,'ready');
 const statuses=await fetch(base+'/imports',{headers:{Cookie:cookie}});assert.equal(statuses.status,200);assert.equal((await statuses.json()).items[0].status,'completed');
 await new Promise(r=>setTimeout(r,100));assert.deepEqual(await readdir(process.env.CAMPAIGN_IMPORT_DIR),[]);
 assert.ok(peak-before<100*1024*1024,`El incremento de RAM Node fue ${Math.round((peak-before)/1024/1024)} MB`);
 console.log(JSON.stringify({file_bytes:size,rows:current.total_rows,contacts:current.unique_contacts,duplicates:current.duplicate_rows,invalid:current.invalid_rows,node_rss_increase_mb:Math.round((peak-before)/1024/1024)}));
 // A corrupt workbook produces a visible failure, never a sendable partial list.
 const bad=await fetch(base+'/lists/import?filename=bad.xlsx&name=Malformed&source_note=Prueba',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':'test','Content-Type':'application/octet-stream'},body:'not a zip'});assert.equal(bad.status,202);const badJob=(await bad.json()).job;let failed;
 for(let i=0;i<100;i++){failed=(await query('SELECT * FROM saas.campaign_import_jobs WHERE id=$1',[badJob.id])).rows[0];if(failed.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(failed.status,'failed');await assert.rejects(()=>saveCampaign({list_id:failed.list_id,name:'Unsafe',subject:'Subject',body_text:'A message that must never be scheduled',cta_url:'https://example.com'},null));
 assert.equal((await query('SELECT sending_enabled FROM saas.campaign_settings')).rows[0].sending_enabled,false);
 }finally{clearInterval(memory);}
 }finally{if(server)await new Promise(r=>server.close(r));await pool.end();}
});
