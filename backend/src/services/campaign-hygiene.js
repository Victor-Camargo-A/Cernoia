import {Resolver} from 'node:dns/promises';
const resolver=new Resolver({timeout:2000,tries:1});
const suggestions=new Map(Object.entries({
 'gamil.com':'gmail.com','gmial.com':'gmail.com','gmai.com':'gmail.com','gmail.co':'gmail.com','gmail.con':'gmail.com','gmail.com.co':'gmail.com','gmail.es':'gmail.com','gmail.comm':'gmail.com','gmal.com':'gmail.com','gmaill.com':'gmail.com','gnail.com':'gmail.com','gimail.com':'gmail.com','gemail.com':'gmail.com','gmaio.com':'gmail.com','gmaik.com':'gmail.com','gmail.om':'gmail.com','gmail.coom':'gmail.com','hotmai.com':'hotmail.com','hotmial.com':'hotmail.com','hotmal.com':'hotmail.com','hotamil.com':'hotmail.com','hotmail.con':'hotmail.com','hotmail.co':'hotmail.com','hotmail.com.co':'hotmail.com','hotmaill.com':'hotmail.com','hotmil.com':'hotmail.com','homail.com':'hotmail.com','hotnail.com':'hotmail.com','outlok.com':'outlook.com','outllook.com':'outlook.com','outlook.con':'outlook.com','yaho.com':'yahoo.com','yahoo.con':'yahoo.com','yahooo.com':'yahoo.com'
}));
export function inspectAddress(raw){
 const email=String(raw??'').trim().toLowerCase(),parts=email.split('@'),[local,domain]=parts;
 if(parts.length!==2||email.length>254||!local||local.length>64||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain||domain.length>253||!domain.includes('.')||domain.split('.').some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||!/^[a-z]{2,63}$/.test(domain.split('.').at(-1)))return {status:'invalid',reason:'invalid_syntax',suggestion:null};
 if(['yopmail.com','yopmail.fr','mailinator.com','guerrillamail.com','10minutemail.com','temp-mail.org','trashmail.com'].includes(domain))return {status:'review',reason:'temporary_mailbox_domain',suggestion:null};
 if(suggestions.has(domain))return {status:'review',reason:'possible_domain_typo',suggestion:local+'@'+suggestions.get(domain)};
 if(['example.com','example.org','example.net','test.com','correo.com','noemail.com','sincorreo.com'].includes(domain))return {status:'review',reason:'possible_placeholder',suggestion:null};
 return {status:'unchecked',reason:null,suggestion:null};
}
const missing=e=>['ENODATA','ENOTFOUND'].includes(e.code);
export async function inspectDomain(domain,dns=resolver){
 try{
  let mx=[];
  try{mx=await dns.resolveMx(domain);}catch(e){if(e.code==='ENOTFOUND')return {status:'invalid',reason:'domain_not_found'};if(!missing(e))return {status:'pending',reason:'dns_temporary_error'};}
  if(mx.length){if(mx.every(r=>!r.exchange||r.exchange==='.'))return {status:'invalid',reason:'null_mx'};return {status:'valid',reason:'mx_available'};}
  const addresses=await Promise.allSettled([dns.resolve4(domain),dns.resolve6(domain)]);
  if(addresses.some(r=>r.status==='fulfilled'&&r.value.length))return {status:'valid',reason:'implicit_mx'};
  if(addresses.some(r=>r.status==='rejected'&&!missing(r.reason)))return {status:'pending',reason:'dns_temporary_error'};
  return {status:'invalid',reason:'no_mail_route'};
 }catch{return {status:'pending',reason:'dns_temporary_error'};}
}
const domainCache=new Map();
export async function validateCampaignAddress(email){
 const syntax=inspectAddress(email);if(syntax.status!=='unchecked')return syntax;
 const domain=email.trim().toLowerCase().split('@')[1],cached=domainCache.get(domain);
 if(cached&&cached.until>Date.now())return {...await cached.result,suggestion:null};
 const result=inspectDomain(domain);domainCache.set(domain,{result,until:Date.now()+300000});if(domainCache.size>20000)domainCache.delete(domainCache.keys().next().value);
 return {...await result,suggestion:null};
}
