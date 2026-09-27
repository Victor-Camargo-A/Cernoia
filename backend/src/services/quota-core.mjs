import {randomUUID} from 'node:crypto';
export const POLICY_VERSION='2026-09-18-user-limits-v1';
export const MARGIN=0.9;
export const MODELS=[
 ['gemini-3.1-flash-lite',15,250000,500,500,0],
 ['gemini-3.5-flash-lite',15,250000,500,500,0],
 ['gemini-2.5-flash-lite',10,250000,20,500,1500],
 ['gemini-2.5-flash',5,250000,20,500,1500],
 ['gemini-3.5-flash',5,250000,20,0,0],
 ['gemini-3.6-flash',5,250000,20,0,0],
 ['gemini-3.7-flash',5,250000,20,0,0],
 ['gemini-3.8-flash',5,250000,20,0,0],
 ['gemini-3-flash',5,250000,20,0,0],
].map(([id,rpm,tpm,rpd,maps,search])=>({id,rpm,tpm,rpd,maps,search}));
export const PREFIX='cernoia:ai-quota:v2:shared-google-project';
export function quotaDay(time=Date.now()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time)).map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day}`;
}
export function resetAt(time=Date.now()){
 const day=quotaDay(time);let lo=time,hi=time+27*3600000;
 while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(quotaDay(mid)===day)lo=mid;else hi=mid;}
 return hi;
}
export function toolsNeeded(body){
 const names=(body.tools??[]).flatMap(t=>Object.keys(t));
 return {maps:names.some(n=>/google_?maps/i.test(n)),search:names.some(n=>/google_?search/i.test(n))};
}
export function compatible(model,body,metadata){
 if(!metadata?.supportedGenerationMethods?.includes('generateContent'))return false;
 const needed=toolsNeeded(body);
 if(needed.maps&&!model.maps||needed.search&&!model.search)return false;
 if((body.generationConfig?.responseModalities??['TEXT']).some(x=>x!=='TEXT'))return false;
 if(body.generationConfig?.speechConfig)return false;
 if(body.generationConfig?.maxOutputTokens>metadata.outputTokenLimit)return false;
 // Gemini 3-specific features must never silently migrate to an older family.
 if(body.generationConfig?.thinkingConfig?.thinkingLevel&&!model.id.startsWith('gemini-3'))return false;
 if(body.tools?.some(t=>t.computerUse||t.computer_use))return false;
 return true;
}
// Reserve the request, input tokens and grounding together. A rejection consumes nothing.
export const RESERVE_LUA=`
local now=tonumber(ARGV[1]);local tokens=tonumber(ARGV[2]);local rpm=tonumber(ARGV[3]);local tpm=tonumber(ARGV[4]);local rpd=tonumber(ARGV[5]);local ttl=tonumber(ARGV[6]);
local block=math.max(tonumber(redis.call('PTTL',KEYS[5])),tonumber(redis.call('PTTL',KEYS[6])))
if block>0 then return {0,'cooldown',math.ceil(block/1000),0,0,0} end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-60000)
local entries=redis.call('ZRANGE',KEYS[1],0,-1);local used=0
for _,entry in ipairs(entries) do used=used+tonumber(string.match(entry,':(%d+)$')) end
local daily=tonumber(redis.call('GET',KEYS[2]) or '0')
if daily+1>rpd then return {0,'rpd',ttl,#entries,used,daily} end
if #entries+1>rpm then return {0,'rpm',61,#entries,used,daily} end
if used+tokens>tpm then return {0,'tpm',61,#entries,used,daily} end
local maps=tonumber(ARGV[8]);local search=tonumber(ARGV[9])
if maps>0 and tonumber(redis.call('GET',KEYS[3]) or '0')+1>maps then return {0,'maps',ttl,#entries,used,daily} end
if search>0 and tonumber(redis.call('GET',KEYS[4]) or '0')+1>search then return {0,'search',ttl,#entries,used,daily} end
if ARGV[10]=='preview' then return {1,'available',0,#entries,used,daily} end
redis.call('ZADD',KEYS[1],now,ARGV[7]..':'..tokens);redis.call('EXPIRE',KEYS[1],120)
daily=redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],ttl)
if maps>0 then redis.call('INCR',KEYS[3]);redis.call('EXPIRE',KEYS[3],ttl) end
if search>0 then redis.call('INCR',KEYS[4]);redis.call('EXPIRE',KEYS[4],ttl) end
return {1,'granted',0,#entries+1,used+tokens,daily}
`;
export function keys(model,time=Date.now(),prefix=PREFIX){const day=quotaDay(time);return [`${prefix}:${model.id}:minute`,`${prefix}:${model.id}:day:${day}`,`${prefix}:${model.id}:maps:${day}`,`${prefix}:search:gemini-2.5:${day}`,`${prefix}:${model.id}:blocked`,`${prefix}:blocked`];}
export async function reserve(redis,model,tokens,body,{now=Date.now(),prefix=PREFIX,preview=false}={}){
 if(!Number.isSafeInteger(tokens)||tokens<0)throw Error('Invalid token count');
 const needed=toolsNeeded(body),ttl=Math.ceil((resetAt(now)-now)/1000);
 const requestId=randomUUID();
 const r=await redis.eval(RESERVE_LUA,6,...keys(model,now,prefix),now,tokens,Math.floor(model.rpm*MARGIN),Math.floor(model.tpm*MARGIN),Math.floor(model.rpd*MARGIN),ttl,requestId,needed.maps?Math.floor(model.maps*MARGIN):0,needed.search?Math.floor(model.search*MARGIN):0,preview?'preview':'reserve');
 return {requestId,createdAt:new Date(now).toISOString(),granted:Number(r[0])===1,reason:r[1],retryAfter:Number(r[2]),rpm:Number(r[3]),tpm:Number(r[4]),rpd:Number(r[5])};
}
export function providerCooldown(status,body,headers={},now=Date.now()){
 const error=body?.error??{};const details=error.details??[];
 const violation=JSON.stringify(details.filter(d=>String(d['@type']).endsWith('QuotaFailure')));
 const retry=details.find(d=>String(d['@type']).endsWith('RetryInfo'))?.retryDelay;
 const header=headers['retry-after'];const seconds=Number.parseFloat(retry)||Number(header)|| (header?Math.ceil((Date.parse(header)-now)/1000):0)||65;
 const daily=/PerDay|per.day/i.test(violation);
 const global=/spend|billing|project.*quota/i.test(error.message??'')&&!/per.model/i.test(violation);
 return {seconds:daily?Math.ceil((resetAt(now)-now)/1000):Math.max(65,Math.min(86400,seconds)),global,status};
}
export async function block(redis,model,seconds,global=false,prefix=PREFIX){
 const key=global?`${prefix}:blocked`:`${prefix}:${model}:blocked`;
 await redis.eval("local t=tonumber(ARGV[1]); if redis.call('TTL',KEYS[1])<t then redis.call('SET',KEYS[1],'1','EX',t) end;return 1",1,key,Math.ceil(seconds));
}
export async function snapshot(redis,prefix=PREFIX){
 const now=Date.now(),models=[];
 for(const m of MODELS){const k=keys(m,now,prefix);const rows=await redis.zrangebyscore(k[0],now-60000,'+inf');const used={rpm:rows.length,tpm:rows.reduce((s,r)=>s+Number(r.split(':').at(-1)),0),rpd:Number(await redis.get(k[1])??0),maps:Number(await redis.get(k[2])??0),search:Number(await redis.get(k[3])??0)};
 models.push({model:m.id,limits:m,thresholds:{rpm:Math.floor(m.rpm*MARGIN),tpm:Math.floor(m.tpm*MARGIN),rpd:Math.floor(m.rpd*MARGIN)},used,cooldown_seconds:Math.max(0,await redis.ttl(k[4])),near_limit:used.rpm>=Math.floor(m.rpm*MARGIN)||used.tpm>=Math.floor(m.tpm*MARGIN)||used.rpd>=Math.floor(m.rpd*MARGIN)});}
 return {policy:POLICY_VERSION,scope:'shared_google_project',margin_percent:10,quota_day:quotaDay(now),reset_at:new Date(resetAt(now)).toISOString(),global_cooldown_seconds:Math.max(0,await redis.ttl(`${prefix}:blocked`)),models};
}
