import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {boundedQuery as query} from '../db.js';
import {config} from '../config.js';
export const visitorCookie=config.isProduction?'__Host-cernoia_visitor':'cernoia_visitor';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mac=id=>createHmac('sha256',config.jwtSecret).update('marketing-visitor:'+id).digest('base64url');
export function visitorId(req){const [id,signature]=String(req.cookies?.[visitorCookie]??'').split('.');if(!uuid.test(id??'')||!signature)return null;const expected=Buffer.from(mac(id)),received=Buffer.from(signature);return expected.length===received.length&&timingSafeEqual(expected,received)?id:null;}
const tag=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value)?value:null;
export async function ensureVisitor(req,res){
 let id=visitorId(req),visitor=id?(await query('SELECT * FROM saas.marketing_visitors WHERE id=$1',[id])).rows[0]:null;
 if(visitor)return visitor;
 id=randomUUID();const input=req.body?.attribution??{};
 const attribution=uuid.test(input.cid??'')?(await query(`SELECT d.id AS delivery_id,d.campaign_id,c.attribution_cid AS cid FROM saas.campaign_contacts c JOIN saas.campaign_deliveries d ON d.contact_id=c.id WHERE c.attribution_cid=$1 AND d.accepted_at IS NOT NULL AND ($2::uuid IS NULL OR d.campaign_id=$2::uuid) ORDER BY d.accepted_at DESC LIMIT 1`,[input.cid,uuid.test(input.campaign_id??'')?input.campaign_id:null])).rows[0]:null;
 visitor=(await query(`INSERT INTO saas.marketing_visitors(id,campaign_id,cid,delivery_id,utm_source,utm_medium,utm_campaign) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,attribution?.campaign_id??null,attribution?.cid??null,attribution?.delivery_id??null,tag(input.utm_source),tag(input.utm_medium),tag(input.utm_campaign)])).rows[0];
 res.cookie(visitorCookie,id+'.'+mac(id),{httpOnly:true,secure:config.isProduction,sameSite:'lax',path:'/',maxAge:90*86400000});return visitor;
}
export async function recordVisitorEvent(visitor,event){
 return (await query(`INSERT INTO saas.marketing_events(event_key,event_name,visitor_id,campaign_id,cid,delivery_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING RETURNING id`,[event+':'+visitor.id,event,visitor.id,visitor.campaign_id,visitor.cid,visitor.delivery_id])).rowCount>0;
}
// The account and its conversion are committed together. Attribution is optional.
export async function attachMarketingSignup(client,req,organizationId){
 const id=visitorId(req);if(!id)return;
 await client.query('SAVEPOINT marketing_attribution');
 try{
  await client.query(`INSERT INTO saas.marketing_organizations(organization_id,visitor_id) SELECT $1,id FROM saas.marketing_visitors WHERE id=$2 ON CONFLICT DO NOTHING`,[organizationId,id]);
  await client.query(`UPDATE saas.marketing_events e SET visitor_id=v.id,campaign_id=v.campaign_id,cid=v.cid,delivery_id=v.delivery_id FROM saas.marketing_organizations a JOIN saas.marketing_visitors v ON v.id=a.visitor_id WHERE a.organization_id=$1 AND e.organization_id=a.organization_id`,[organizationId]);
 }catch(error){await client.query('ROLLBACK TO SAVEPOINT marketing_attribution');console.error('Marketing attribution unavailable:',error.code??'error');}
 finally{await client.query('RELEASE SAVEPOINT marketing_attribution');}
}
export async function completeDemo(organizationId,analysisId){
 if(!uuid.test(analysisId??''))return {eligible:false,recorded:false};
 const eligible=await query(`SELECT a.id FROM saas.opportunity_ai_analyses a JOIN saas.organizations o ON o.id=a.organization_id WHERE a.id=$1 AND a.organization_id=$2 AND a.analysis_status='success' AND o.demo_enabled=TRUE`,[analysisId,organizationId]);
 if(!eligible.rowCount)return {eligible:false,recorded:false};
 const result=await query(`INSERT INTO saas.marketing_events(event_key,event_name,organization_id,analysis_id,visitor_id,campaign_id,cid,delivery_id) SELECT 'demo_completed:'||$1::text,'demo_completed',$1,$2,v.id,v.campaign_id,v.cid,v.delivery_id FROM (SELECT 1) anchor LEFT JOIN saas.marketing_organizations a ON a.organization_id=$1 LEFT JOIN saas.marketing_visitors v ON v.id=a.visitor_id ON CONFLICT(event_key) DO NOTHING RETURNING id`,[organizationId,analysisId]);
 return {eligible:true,recorded:result.rowCount>0};
}
export function campaignDestination(original,cid,campaignId,baseUrl){
 const url=new URL(original),base=new URL(baseUrl);
 // Never attach a contact identifier to another website.
 if(url.origin!==base.origin)return original;
 if(url.pathname==='/'||(url.pathname==='/acceso'&&url.searchParams.get('demo')==='1')){url.pathname='/demo';url.searchParams.delete('demo');}
 url.searchParams.set('utm_source','email');url.searchParams.set('utm_medium','outbound');if(!url.searchParams.has('utm_campaign'))url.searchParams.set('utm_campaign','cernoia_demo_v2');
 url.searchParams.set('cid',cid);url.searchParams.set('cmp',campaignId);return url.href;
}
export async function commercialMetrics(){
 const counts=await query(`SELECT campaign_id,event_name,COUNT(*)::int AS events,COUNT(DISTINCT organization_id)::int AS organizations,COALESCE(SUM(value),0)::numeric AS value FROM saas.marketing_events WHERE NOT is_test GROUP BY GROUPING SETS ((event_name),(campaign_id,event_name)) HAVING GROUPING(campaign_id)=1 OR campaign_id IS NOT NULL`);
 const totals={},campaigns={};for(const row of counts.rows){const bucket=row.campaign_id?(campaigns[row.campaign_id]??={}):totals;bucket[row.event_name]=row.events;if(row.event_name==='purchase'){bucket.paying_customers=row.organizations;bucket.revenue_cop=Number(row.value);}}
 const start=(await query('SELECT started_at FROM saas.marketing_tracking_settings WHERE id=TRUE')).rows[0]?.started_at;
 return {totals,campaigns,started_at:start,attribution:'first_touch',ga4_purchase:'verified_browser_return'};
}
