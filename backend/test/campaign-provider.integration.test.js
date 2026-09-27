import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
test('Provider-only import, legacy list block, scheduled dispatch and no repeat',{skip:process.env.CAMPAIGN_TEST_DATABASE!=='isolated'},async()=>{
 const {pool,query}=await import('../src/db.js');
 const {processNextCampaignImport}=await import('../src/services/campaign-imports.js');
 const {saveCampaign,dispatchCampaigns}=await import('../src/services/campaigns.js');
 assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/cernoia_campaign_test_/);
 try{
 await mkdir(process.env.CAMPAIGN_IMPORT_DIR,{recursive:true});
 async function upload(content){const id=randomUUID();await writeFile(join(process.env.CAMPAIGN_IMPORT_DIR,id+'.csv'),content);await query("INSERT INTO saas.campaign_import_jobs(id,filename,file_bytes,name,source_note,permission_confirmed) VALUES($1,'providers.csv',$2,'Providers','Synthetic test',TRUE)",[id,Buffer.byteLength(content)]);await processNextCampaignImport();return (await query('SELECT * FROM saas.campaign_import_jobs WHERE id=$1',[id])).rows[0];}
 const job=await upload('Correo;Empresa;Es proveedor\na@example.invalid;A;Sí\nb@example.invalid;B; SI \nc@example.invalid;C;si\nd@example.invalid;D;No\ne@example.invalid;E;\nf@example.invalid;F;true\ng@example.invalid;G;S.i\na@example.invalid;A;No\na@example.invalid;A;Sí\ninvalid;X;Sí\n');
 assert.equal(job.status,'completed',job.error);assert.equal(job.total_rows,10);assert.equal(job.unique_contacts,3);assert.equal(job.excluded_rows,5);assert.equal(job.duplicate_rows,1);assert.equal(job.invalid_rows,1);
 assert.equal((await query('SELECT provider_only FROM saas.campaign_lists WHERE id=$1',[job.list_id])).rows[0].provider_only,true);
 const missing=await upload('Correo;Empresa\nx@example.invalid;X');assert.equal(missing.status,'failed');assert.match(missing.error,/Es proveedor/);
 const legacy=(await query("INSERT INTO saas.campaign_lists(name,source_note,permission_confirmed) VALUES('Legacy','No source column',TRUE) RETURNING id")).rows[0].id;
 const draft={name:'Test',subject:'Test',body_text:'This is a synthetic campaign test',cta_url:'https://example.com',repeat_days:null};
 await assert.rejects(()=>saveCampaign({...draft,list_id:legacy},null),/Es proveedor/);
 const campaign=await saveCampaign({...draft,list_id:job.list_id},null);
 await query("INSERT INTO saas.app_users(id,organization_id,email,full_name,password_hash,role,status) VALUES($1,gen_random_uuid(),'test@example.invalid','Test','unused','owner','active')",[randomUUID()]);
 await query("UPDATE saas.campaign_settings SET owner_user_id=(SELECT id FROM saas.app_users LIMIT 1),sending_enabled=TRUE,smtp_verified_at=NOW(),password_box='{}',limits_confirmed=TRUE WHERE id=TRUE");
 await query("UPDATE saas.email_campaigns SET status='active' WHERE id=$1",[campaign.id]);
 const recipients=[];const transportFactory=()=>({sendMail:async mail=>{recipients.push(mail.to);return {accepted:[mail.to],response:'synthetic'};},close(){}});
 assert.equal((await dispatchCampaigns({transportFactory,clock:()=>new Date('2026-09-17T00:00:00Z')})).attempted,0);
 const sent=await dispatchCampaigns({transportFactory,clock:()=>new Date('2026-09-16T12:00:00Z'),maxBatch:3});assert.equal(sent.accepted,3);assert.deepEqual(recipients.sort(),['a@example.invalid','b@example.invalid','c@example.invalid']);
 assert.equal((await dispatchCampaigns({transportFactory,clock:()=>new Date('2026-09-16T12:01:00Z')})).attempted,0);
 }finally{await pool.end();}
});
