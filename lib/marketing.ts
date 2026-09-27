"use client";
import {apiFetch} from './api';
declare global { interface Window { gtag?:(...args:unknown[])=>void; __cernoiaAttribution?:Record<string,string>; } }
let queue:Promise<unknown>=Promise.resolve();
const sent=new Set<string>();
const scheduled=new Set<string>();
export function attribution():Record<string,string>{
 if(typeof window==='undefined')return {};
 let value:Record<string,string>={};try{value=JSON.parse(sessionStorage.getItem('cernoia:campaign')||'{}');}catch{}
 const parameters=new URLSearchParams(window.location.search);
 const incoming=window.__cernoiaAttribution??Object.fromEntries(['cid','cmp','utm_source','utm_medium','utm_campaign'].map(k=>[k,parameters.get(k)||'']));
 if(!Object.keys(value).length&&Object.values(incoming).some(Boolean)){value=incoming;try{sessionStorage.setItem('cernoia:campaign',JSON.stringify(value));}catch{}}
 return {...value,campaign_id:value.cmp};
}
export function analyticsEvent(name:string,params:Record<string,unknown>={}){
 if(typeof window==='undefined')return;
 if(new URLSearchParams(location.search).has('reset_token')||new URLSearchParams(location.search).has('invite_token'))return;
 window.gtag?.('event',name,{...params,page_location:location.origin+location.pathname,page_referrer:document.referrer?new URL(document.referrer).origin+new URL(document.referrer).pathname:'',transport_type:'beacon'});
}
export function marketingEvent(name:'landing_visited'|'demo_started'|'signup_started',interaction=false){
 if(scheduled.has(name))return queue;scheduled.add(name);
 const task=async()=>{try{const result=await apiFetch<{recorded:boolean}>('/marketing/events',{method:'POST',keepalive:true,body:JSON.stringify({event:name,interaction,attribution:attribution()})});if(result.recorded)analyticsEvent(name);}catch{scheduled.delete(name);/* Measurement must not block using CernoIA. */}};
 queue=queue.then(task,task);return queue;
}
export function trackDemoStart(event:{isTrusted:boolean}){return event.isTrusted?marketingEvent('demo_started',true):Promise.resolve();}
export async function recordDemoConsulted(analysisId:string){
 if(sent.has('demo:'+analysisId))return;
 try{const result=await apiFetch<{recorded:boolean;eligible:boolean}>('/marketing/demo-completed',{method:'POST',body:JSON.stringify({analysis_id:analysisId})});if(result.eligible)sent.add('demo:'+analysisId);if(result.recorded)analyticsEvent('demo_completed');}catch{}
}
export function verifiedSignup(){analyticsEvent('signup_completed',{method:'demo'});analyticsEvent('sign_up',{method:'demo'});}
export function verifiedCheckout(order:{id:string;amount_cop:string|number;currency?:string}){const params={currency:order.currency||'COP',value:Number(order.amount_cop),items:[{item_id:'cernoia_membership',item_name:'Membresía CernoIA',price:Number(order.amount_cop),quantity:1}]};analyticsEvent('checkout_started',params);analyticsEvent('begin_checkout',params);}
export function verifiedPurchases(orders:Array<{id:string;amount_cop:string|number;currency?:string;status:string;marketing_is_test?:boolean;approved_at?:string|null}>,trackingStarted?:string){
 if(!trackingStarted)return;
 for(const order of orders){if(order.status!=='approved'||order.marketing_is_test!==false||!order.approved_at||new Date(order.approved_at)<new Date(trackingStarted))continue;
 const key='cernoia:purchase:'+order.id;try{if(localStorage.getItem(key))continue;}catch{}if(sent.has(key))continue;
 analyticsEvent('purchase',{transaction_id:order.id,currency:order.currency||'COP',value:Number(order.amount_cop),items:[{item_id:'cernoia_membership',item_name:'Membresía CernoIA',price:Number(order.amount_cop),quantity:1}]});sent.add(key);try{localStorage.setItem(key,'1');}catch{}
 }
}
