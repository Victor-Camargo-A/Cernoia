import {createHash} from 'node:crypto';
export const KNOWLEDGE_VERSION='public-process-v2';
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const normalizeText=value=>String(value??'').replace(/\s+/g,' ').trim();
export function publicEvidenceSegments(text){
 const source=normalizeText(text),segments=[];let start=0;
 while(start<source.length){let end=Math.min(start+600,source.length);if(end<source.length){const space=source.lastIndexOf(' ',end);if(space>start)end=space;}
  segments.push({id:segments.length,text:source.slice(start,end)});start=end;while(source[start]===' ')start++;
 }return segments;
}
export function groundPublicInsight(output,text){
 const segments=publicEvidenceSegments(text);
 if(!Array.isArray(output?.facts))throw Error('Clasificación de IA incompleta.');
 const facts=output.facts.flatMap(fact=>{
  const {evidence_start:start,evidence_end:end}=fact;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=segments.length)throw Error('Referencia documental de IA no válida.');
  // Preserve the entire selected range as bounded literal citations. Models can
  // select a multi-paragraph condition despite the requested two-segment limit.
  const citations=[];
  for(let first=start;first<=end;first+=2){
   const quote=segments.slice(first,Math.min(first+2,end+1)).map(s=>s.text).join(' ');
   citations.push({...fact,category:fact.category,label:fact.label,value:quote,quote});
  }
  return citations;
 });
 if(facts.length>60)throw Error('La lectura devuelve demasiadas referencias; se reintentará el fragmento.');
 return validatePublicInsight({...output,facts},text);
}
export function publicFileUrl(doc){
 for(const value of [doc.download_url_text,doc.download_url?.url,typeof doc.download_url==='string'?doc.download_url:null]){
  try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='community.secop.gov.co'&&!u.port&&!u.username&&!u.password&&u.pathname==='/Public/Archive/RetrieveFile/Index'&&/^\d+$/.test(u.searchParams.get('DocumentId')??''))return u.href;}catch{}
 }return null;
}
export function documentVersion(d){return hash([d.id,publicFileUrl(d),d.file_name,d.file_size_bytes,d.uploaded_at,d.sha256]);}
export function manifestFingerprint(documents){return hash(documents.map(d=>[d.id,documentVersion(d)]).sort((a,b)=>a[0].localeCompare(b[0])));}
export function splitPublicText(text,size=18000){const result=[];for(let offset=0;offset<text.length;offset+=size-400)result.push(text.slice(offset,offset+size));return result;}
export function validatePublicInsight(output,text){
 if(!output||!['informative','fillable','mixed','unknown'].includes(output.document_role)||!Array.isArray(output.facts))throw Error('Clasificación de IA incompleta.');
 const normalized=normalizeText(text);const facts=[];
 for(const fact of output.facts){
  const quote=normalizeText(fact.quote),value=normalizeText(fact.value);
  if(quote.length<12||quote.length>1500||!normalized.includes(quote)||!value||!quote.includes(value))throw Error('La matriz contiene un dato sin cita documental verificable.');
  if(!['legal','technical','financial','experience','schedule','submission','other'].includes(fact.category))throw Error('Categoría de matriz no válida.');
  facts.push({category:fact.category,label:String(fact.label??'Dato del proceso').slice(0,180),value,quote,is_requirement:fact.is_requirement===true,mandatory:fact.mandatory===true,requirement_stage:['bid_submission','eligibility','evaluation','award','contract_signing','contract_execution','payment','other'].includes(fact.requirement_stage)?fact.requirement_stage:'other'});
 }
 return {document_role:output.document_role,summary:String(output.summary??'').slice(0,1800),facts:facts.slice(0,60)};
}
export function mergePublicChunks(chunks,fields=[]){
 const rows=Object.values(chunks);const roles=new Set(rows.map(r=>r.document_role));
 const fill=roles.has('fillable')||roles.has('mixed')||fields.length>0;const info=roles.has('informative')||roles.has('mixed');
 const document_role=fill&&info?'mixed':fill?'fillable':info?'informative':'unknown';
 const unique=new Map();for(const r of rows)for(const f of r.facts??[])unique.set(hash([f.category,f.value,f.quote]),f);
 return {document_role,summary:rows.map(r=>r.summary).filter(Boolean).join('\n').slice(0,6000),facts:[...unique.values()]};
}
export function blockingIssues(issues=[]){return issues.filter(i=>!['review_official_annex','review_overlay_position'].includes(i.code));}
export function zipName(name,fallback='documento'){return String(name??fallback).normalize('NFC').replace(/[\/\\\x00-\x1f:*?"<>|]/g,'_').replace(/^\.+/,'').slice(0,160)||fallback;}
export function artifactIsApproved(generated,review,preview){return !!review&&!!preview&&review.source_hash===generated.file_hash_sha256&&preview.source_hash===generated.file_hash_sha256&&review.preview_hash===preview.pdf_hash&&!blockingIssues(generated.validation_issues).length;}
export function knowledgeFailureState(error,previousAttempts=0){
 const waiting=['AI_QUOTA_WAIT','AI_PROVIDER_WAIT','DOCUMENT_CONVERSION_INTERRUPTED'].includes(error.code)||error.name==='TimeoutError';
 const attempts=previousAttempts+(waiting?0:1);
 return {attempts,status:error.permanent||(!waiting&&attempts>=3)?'error':'queued',retryAfter:error.retryAfter??120};
}
