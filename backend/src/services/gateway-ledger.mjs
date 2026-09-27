import {query} from '../db.js';
import {PREFIX,MODELS,quotaDay,resetAt,keys,toolsNeeded,block} from './quota-core.mjs';
export async function recordReservation({id,createdAt,model,tokens,body,service,requested}){
 const needed=toolsNeeded(body);
 await query(`INSERT INTO ops.ai_gateway_usage(id,model,tokens,quota_day,requests,maps,search,service,requested_model,created_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`,[id,model,tokens,quotaDay(Date.parse(createdAt)),needed.maps?1:0,needed.search?1:0,service,requested,createdAt]);
}
export async function recordEvent(event){await query('INSERT INTO ops.ai_gateway_events(event) VALUES($1::jsonb)',[JSON.stringify(event)]);}
export async function restoreLedger(redis){
 const now=Date.now(),day=quotaDay(now),ttl=Math.ceil((resetAt(now)-now)/1000);
 const rows=(await query("SELECT id,model,tokens,requests,maps,search,created_at,quota_day::text AS quota_date FROM ops.ai_gateway_usage WHERE quota_day=$1 OR created_at>now()-interval '1 minute'",[day])).rows;
 for(const model of MODELS){const relevant=rows.filter(r=>r.model===model.id),k=keys(model,now);const today=relevant.filter(r=>r.quota_date===day),daily=today.reduce((s,r)=>s+r.requests,0),maps=today.reduce((s,r)=>s+r.maps,0);
  await redis.eval("for i=1,2 do local v=tonumber(ARGV[i]); if tonumber(redis.call('GET',KEYS[i]) or '0')<v then redis.call('SET',KEYS[i],v,'EX',ARGV[3]) end end;return 1",2,k[1],k[2],daily,maps,ttl);
  for(const r of relevant.filter(r=>r.requests===1&&new Date(r.created_at).getTime()>now-60000))await redis.zadd(k[0],new Date(r.created_at).getTime(),r.id+':'+r.tokens);
  await redis.expire(k[0],120);
 }
 const search=rows.filter(r=>r.quota_date===day).reduce((s,r)=>s+r.search,0),sk=keys(MODELS[0],now)[3];await redis.eval("if tonumber(redis.call('GET',KEYS[1]) or '0')<tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) end;return 1",1,sk,search,ttl);
 const events=(await query("SELECT event FROM ops.ai_gateway_events WHERE created_at>now()-interval '27 hours' AND event->>'type'='provider_wait'")).rows;
 for(const {event} of events){const seconds=Math.ceil((Date.parse(event.at)+event.retry_after*1000-now)/1000);if(seconds>0)await block(redis,event.model,seconds,event.global);}
 await redis.set(`${PREFIX}:initialized`,'1');
 await query("DELETE FROM ops.ai_gateway_usage WHERE created_at<now()-interval '14 days'");await query("DELETE FROM ops.ai_gateway_events WHERE created_at<now()-interval '14 days'");
}
