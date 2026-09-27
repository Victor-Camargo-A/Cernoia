export function providerError(response,message){
 const waiting=response.status===429||response.status>=500;
 const seconds=Number(response.headers.get('retry-after'));
 return Object.assign(Error(message),{code:waiting?'AI_QUOTA_WAIT':'AI_RESPONSE_ERROR',retryAfter:waiting&&Number.isFinite(seconds)&&seconds>0?Math.min(86400,Math.max(2,Math.ceil(seconds))):waiting?65:120});
}
export async function quotaFetch(url,options){
 try{return await fetch(url,options);}catch(error){
  if(['TypeError','TimeoutError','AbortError'].includes(error.name))throw Object.assign(Error('La tarea espera la disponibilidad del controlador de IA.'),{code:'AI_QUOTA_WAIT',retryAfter:65});
  throw error;
 }
}
