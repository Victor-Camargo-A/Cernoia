import {createHash} from 'node:crypto';
import {MODELS,PREFIX,reserve,compatible,providerCooldown,block,snapshot,quotaDay} from './quota-core.mjs';
const ORIGIN='https://generativelanguage.googleapis.com';
const hash=v=>createHash('sha256').update(v).digest('hex');
export function createGateway({redis,allowedKeys,fetchImpl=fetch,prefix=PREFIX,isReady=()=>true,recordReservation=async()=>{},recordEvent=async()=>{}}){
 const modelsCache=new Map();
 const allowed=new Set(allowedKeys.map(hash));
 async function log(event){const complete={...event,at:new Date().toISOString()};await recordEvent(complete);const safe=JSON.stringify(complete);await redis.lpush(`${prefix}:events`,safe);await redis.ltrim(`${prefix}:events`,0,499);console.log('[GeminiQuota]',safe);}
 async function metadata(key){
  const h=hash(key),cached=modelsCache.get(h);if(cached&&cached.until>Date.now())return cached.models;
  const models=new Map();let page='';
  do {const url=new URL(ORIGIN+'/v1beta/models');url.searchParams.set('pageSize','1000');if(page)url.searchParams.set('pageToken',page);
   const r=await fetchImpl(url,{headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(20000)});
   if(!r.ok)throw Object.assign(Error('No se pudo comprobar la disponibilidad de modelos.'),{status:r.status});
   const j=await r.json();for(const m of j.models??[])models.set(m.name.replace(/^models\//,''),m);page=j.nextPageToken??'';
  }while(page);
  modelsCache.set(h,{models,until:Date.now()+3600000});return models;
 }
 const send=(res,status,obj,retry=0)=>{res.writeHead(status,{'content-type':'application/json',...(retry?{'retry-after':String(retry)}:{})});res.end(JSON.stringify(obj));};
 return async function handler(req,res){
  try{
   const url=new URL(req.url,'http://localhost');
   const key=String(req.headers['x-goog-api-key']??url.searchParams.get('key')??'');
   if(!allowed.has(hash(key)))return send(res,401,{error:{code:401,status:'UNAUTHENTICATED',message:'Credencial no autorizada.'}});
   if(req.method==='GET'&&url.pathname==='/quota/status')return send(res,200,{...await snapshot(redis,prefix),events:(await redis.lrange(`${prefix}:events`,0,49)).map(x=>JSON.parse(x))});
   const match=url.pathname.match(/^\/v1(?:beta)?\/models(?:\/([a-zA-Z0-9._-]+)(?::(generateContent|streamGenerateContent|countTokens))?)?$/);
   if(!match||!['GET','POST'].includes(req.method))return send(res,404,{error:{code:404,message:'Operación no admitida por el controlador de texto.'}});
   if(req.method==='GET'){
    const models=await metadata(key);return match[1]?send(res,models.has(match[1])?200:404,models.get(match[1])??{error:{code:404,message:'Modelo no disponible.'}}):send(res,200,{models:[...models.values()]});
   }
   if(!match[2])return send(res,400,{error:{code:400,message:'Falta la operación.'}});
   let raw='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>25*1024*1024)return send(res,413,{error:{code:413,message:'Solicitud demasiado grande.'}});raw+=chunk.toString();}
   let body;try{body=JSON.parse(raw);}catch{return send(res,400,{error:{code:400,message:'JSON no válido.'}});}
   if(!isReady()||!await redis.exists(`${prefix}:initialized`))return send(res,503,{error:{code:503,status:'UNAVAILABLE',message:'Control de cuota pendiente de inicialización.'}},65);
   const models=await metadata(key);const candidates=MODELS.filter(m=>compatible(m,body,models.get(m.id)));
   if(!candidates.length)return send(res,400,{error:{code:400,status:'FAILED_PRECONDITION',message:'No hay un modelo compatible con las funciones y cuotas configuradas.'}});
   if(match[2]==='countTokens'){
    const selected=candidates[0];const r=await fetchImpl(`${ORIGIN}/v1beta/models/${selected.id}:countTokens`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    return send(res,r.status,await r.json());
   }
   let reasons=[],retryAfter=86400,tooLarge=false;
   for(const model of candidates){
    const cooldown=Math.max(await redis.ttl(`${prefix}:${model.id}:blocked`),await redis.ttl(`${prefix}:blocked`));
    if(cooldown>0){reasons.push({model:model.id,reason:'cooldown'});retryAfter=Math.min(retryAfter,cooldown);continue;}
    const admission=await reserve(redis,model,0,body,{prefix,preview:true});
    if(!admission.granted){reasons.push({model:model.id,reason:admission.reason});retryAfter=Math.min(retryAfter,admission.retryAfter);continue;}
    // Count the actual request including images, files, system prompt and tools before admission.
    const countResponse=await fetchImpl(`${ORIGIN}/v1beta/models/${model.id}:countTokens`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify({generateContentRequest:{...body,model:`models/${model.id}`}}),signal:AbortSignal.timeout(30000)});
    const count=await countResponse.json();
    if(!countResponse.ok){
     if(countResponse.status===404){await block(redis,model.id,3600,false,prefix);reasons.push({model:model.id,reason:'unavailable'});continue;}
     if(countResponse.status===429){await block(redis,model.id,65,true,prefix);await log({type:'count_tokens_wait',model:model.id});return send(res,429,{error:{code:429,status:'RESOURCE_EXHAUSTED',message:'El contador de tokens requiere una pausa.'}},65);}
     return send(res,countResponse.status,{error:{code:countResponse.status,message:'No fue posible contar los tokens de esta solicitud.'}});
    }
    const tokens=Number(count.totalTokens);
    if(tokens>Math.min(models.get(model.id).inputTokenLimit,Math.floor(model.tpm*0.9))){tooLarge=true;reasons.push({model:model.id,reason:'context_limit'});continue;}
    const reservation=await reserve(redis,model,tokens,body,{prefix});
    if(!reservation.granted){reasons.push({model:model.id,reason:reservation.reason});retryAfter=Math.min(retryAfter,reservation.retryAfter);continue;}
    await recordReservation({id:reservation.requestId,createdAt:reservation.createdAt,model:model.id,tokens,body,service:String(req.headers['x-cernoia-service']??'n8n').slice(0,80),requested:match[1]});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150000);
    const abort=()=>{if(!res.writableEnded)controller.abort();};res.once('close',abort);
    let upstream;
    try{
     const target=new URL(`${ORIGIN}/v1beta/models/${model.id}:${match[2]}`);if(match[2]==='streamGenerateContent')target.searchParams.set('alt','sse');
     upstream=await fetchImpl(target,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:controller.signal});
     if([429,503,404].includes(upstream.status)){
      const result=await upstream.json().catch(()=>({}));const cd=providerCooldown(upstream.status,result,Object.fromEntries(upstream.headers));
      if(upstream.status===404)cd.seconds=3600;
      await block(redis,model.id,cd.seconds,cd.global,prefix);reasons.push({model:model.id,reason:`provider_${upstream.status}`});retryAfter=Math.min(retryAfter,cd.seconds);
      await log({type:'provider_wait',model:model.id,status:upstream.status,retry_after:cd.seconds,global:cd.global});
      if(cd.global)break;continue;
     }
     await log({type:upstream.ok?'call':'provider_error',model:model.id,requested_model:match[1],service:String(req.headers['x-cernoia-service']??'n8n').slice(0,80),status:upstream.status,input_tokens:tokens,usage:reservation,fallback:reasons});
     res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','x-cernoia-ai-model':model.id,'x-cernoia-quota-day':quotaDay(),'cache-control':'no-store'});
     for await(const chunk of upstream.body){if(res.destroyed)break;if(!res.write(chunk))await new Promise(resolve=>{res.once('drain',resolve);res.once('close',resolve);});}res.end();return;
    }finally{clearTimeout(timer);res.off('close',abort);}
   }
   if(tooLarge&&reasons.every(r=>r.reason==='context_limit'))return send(res,413,{error:{code:413,message:'El documento supera el presupuesto de tokens por minuto. Divídelo en fragmentos más pequeños.'}});
   await log({type:'waiting',reasons,retry_after:retryAfter});
   return send(res,429,{error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Los modelos compatibles están cerca de su límite. Reintentar cuando haya cuota.',details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:`${Math.max(1,retryAfter)}s`}] }},Math.max(1,retryAfter));
  }catch(error){console.error('[GeminiQuota]',error.name,error.code??'request_failed');if(!res.headersSent)send(res,503,{error:{code:503,status:'UNAVAILABLE',message:'El controlador de cuota no está disponible; la solicitud no se envía sin control.'}},65);else res.destroy();}
 };
}
