import test from 'node:test';
import assert from 'node:assert/strict';
test('SMTP verification ignores timestamp precision and unrelated changes but rejects changed credentials',{skip:process.env.CAMPAIGN_TEST_DATABASE!=='isolated'},async()=>{
 const {pool,query}=await import('../src/db.js');const {verifyCampaignSmtp}=await import('../src/services/campaigns.js');
 assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/cernoia_campaign_test_/);
 let closed=0;
 try{
 await query(`UPDATE saas.campaign_settings SET password_box='{"fixture":1}',updated_at='2026-09-16 03:00:00.123456+00',smtp_verified_at=NULL`);
 const factory=action=>()=>({verify:async()=>{if(action)await action();},close:()=>closed++});
 assert.deepEqual(await verifyCampaignSmtp({transportFactory:factory()}),{verified:true});
 assert.deepEqual(await verifyCampaignSmtp({transportFactory:factory(()=>query('UPDATE saas.campaign_settings SET updated_at=NOW(),last_run_at=NOW()'))}),{verified:true});
 for(const sql of ["UPDATE saas.campaign_settings SET password_box='{\"fixture\":2}',smtp_verified_at=NULL","UPDATE saas.campaign_settings SET smtp_host='smtp.titan.email',smtp_verified_at=NULL","UPDATE saas.campaign_settings SET smtp_port=587,smtp_verified_at=NULL","UPDATE saas.campaign_settings SET sender_email='changed@example.invalid',smtp_verified_at=NULL"]){
 await assert.rejects(()=>verifyCampaignSmtp({transportFactory:factory(()=>query(sql))}),e=>e.statusCode===409);
 assert.equal((await query('SELECT smtp_verified_at FROM saas.campaign_settings')).rows[0].smtp_verified_at,null);
 }
 assert.equal(closed,6);
 }finally{await pool.end();}
});
