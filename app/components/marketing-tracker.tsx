"use client";
import {useEffect} from 'react';
import {attribution,marketingEvent,trackDemoStart} from '@/lib/marketing';
export function MarketingTracker(){
 useEffect(()=>{
  const a=attribution(),params=new URLSearchParams(location.search);
  if(['/', '/demo','/membresia'].includes(location.pathname)||(location.pathname==='/acceso'&&params.get('demo')==='1')||a.cid)void marketingEvent('landing_visited');
  const click=(event:MouseEvent)=>{if(!event.isTrusted)return;const anchor=(event.target as Element)?.closest?.('a[href]');if(!anchor)return;const url=new URL(anchor.getAttribute('href')||'',location.href);if(url.origin===location.origin&&url.pathname==='/acceso'&&url.searchParams.get('demo')==='1')void trackDemoStart(event);};
  document.addEventListener('click',click,true);return()=>document.removeEventListener('click',click,true);
 },[]);return null;
}
