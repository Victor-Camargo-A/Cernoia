import { createHash } from 'node:crypto';

export const MATRIX_PROMPT_VERSION = 'company-evidence-v1';
export const MATRIX_DIMENSIONS = Object.freeze({
  identity: 'Identidad y representación legal',
  legal: 'Registros y condiciones legales',
  services: 'Productos y servicios',
  experience: 'Experiencia contractual',
  financial: 'Información financiera',
  people: 'Equipo y cualificaciones',
  equipment: 'Equipos e infraestructura',
  certifications: 'Certificaciones y acreditaciones',
  coverage: 'Cobertura y capacidad operativa',
});
export const MATRIX_ATTRIBUTES = [
  'legal_name','tax_id','legal_representative','representation_limits','registration',
  'legal_condition','service','completed_experience','contracted_experience',
  'financial_metric','qualification','employment','equipment','facility',
  'certification','operational_coverage','unspsc','other',
];
export const EVIDENCE_KINDS=['company_declaration','registry','third_party_certificate','execution_record','financial_statement','identity_record','contract','unknown'];
export const normalizedText = value => String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export const fingerprint = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value ? null : value;
}
export function splitDocument(text, size = 28000, overlap = 800) {
  const source=String(text ?? '');const chunks=[];
  if (size <= overlap || overlap < 0) throw Error('Invalid chunk sizes');
  for(let start=0;start<source.length;start+=size-overlap) {
    chunks.push({index:chunks.length,start,text:source.slice(start,start+size)});
    if(start+size>=source.length)break;
  }
  return chunks;
}
export function sourceFingerprint(document) {
  if (document.matrix_source_version !== undefined) return fingerprint({id:document.id,version:String(document.matrix_source_version)});
  return fingerprint({text:document.extracted_text ?? '',hash:document.file_hash_sha256 ?? '',type:document.document_type,
    issue_date:document.issue_date,expiration_date:document.expiration_date,review_status:document.review_status,
    verification_status:document.verification_status,prompt:MATRIX_PROMPT_VERSION});
}

// Both the quotation and the factual value must occur in the supplied text.
// A model interpretation is kept separately and never treated as a verified fact.
export function validateExtractedFacts(payload, text, document) {
  if (!payload || !Array.isArray(payload.facts) || payload.facts.length>100) throw Error('La IA no devolvió una matriz documental válida.');
  const source=normalizedText(text);const accepted=[];let rejected=0;
  for (const row of payload.facts) {
    const quote=String(row?.evidence_quote ?? '').trim();const value=String(row?.value ?? '').trim();
    if (!row || !Object.hasOwn(MATRIX_DIMENSIONS,row.dimension) || !MATRIX_ATTRIBUTES.includes(row.attribute)
      || quote.length<12 || quote.length>1400 || !value || value.length>650
      || !source.includes(normalizedText(quote)) || !normalizedText(quote).includes(normalizedText(value))) {rejected++;continue;}
    const scope=['company','representative','person','third_party','unclear'].includes(row.scope)?row.scope:'unclear';
    const fact={evidence_kind:EVIDENCE_KINDS.includes(row.evidence_kind)?row.evidence_kind:'unknown',dimension:row.dimension,attribute:row.attribute,label:String(row.label??'Dato documental').slice(0,140),
      subject:String(row.subject??'').slice(0,180),scope,value,evidence_quote:quote,
      confidence:['high','medium','low'].includes(row.confidence)?row.confidence:'low',
      period:String(row.period??'').slice(0,80),valid_from:validDate(row.valid_from),valid_until:validDate(row.valid_until),
      interpretation:String(row.interpretation??'').slice(0,500),capability:String(row.capability??'').slice(0,160),
      document_id:document.id,source_fingerprint:sourceFingerprint(document)};
    if(fact.valid_from&&fact.valid_until&&fact.valid_from>fact.valid_until){rejected++;continue;}
    fact.id=fingerprint([document.id,fact.dimension,fact.attribute,normalizedText(fact.subject),fact.period,normalizedText(value)]).slice(0,32);
    accepted.push(fact);
  }
  return {facts:[...new Map(accepted.map(f=>[f.id,f])).values()],rejected};
}

const singletonAttributes = new Set(['legal_name','tax_id','financial_metric']);
export function assembleCompanyMatrix(rawFacts, documents, declared = {}, today = new Date().toISOString().slice(0,10)) {
  const active=new Map(documents.filter(d=>d.document_status!=='deleted').map(d=>[d.id,d]));
  const rows=[];const seen=new Set();
  for(const fact of rawFacts){
    const source=active.get(fact.document_id);
    if(!source || source.review_status==='rejected' || source.verification_status==='rejected'
      || ['infected','blocked','quarantined'].includes(source.malware_scan_status)
      || (source.source_fingerprint && fact.source_fingerprint!==source.source_fingerprint) || seen.has(fact.id))continue;
    seen.add(fact.id);
    const sourceExpiry=source.expiration_date?(source.expiration_date instanceof Date?source.expiration_date.toISOString():String(source.expiration_date)).slice(0,10):null;
    const expiries=[sourceExpiry,fact.valid_until].filter(Boolean).sort();const expires=expiries[0]??null;
    const future=Boolean(fact.valid_from&&fact.valid_from>today);
    rows.push({...fact,document_name:source.document_name,source_review_status:source.review_status,
      source_url:`/api/documents/${source.id}/file`,expires_on:expires,
      evidence_status:expires&&expires<today?'expired':future?'not_yet_valid':fact.evidence_kind==='company_declaration'?'declared':fact.scope==='unclear'||fact.scope==='third_party'||fact.confidence==='low'||fact.evidence_kind==='unknown'?'needs_review':'document_supported',
      source_reviewed:source.review_status==='corrected'||(source.review_status==='approved'&&source.verification_status==='verified'),conflict:false});
  }
  const groups=new Map();
  for(const row of rows){
    if(!singletonAttributes.has(row.attribute)||row.scope!=='company'||!['document_supported','declared'].includes(row.evidence_status))continue;
    const key=[row.attribute,row.attribute==='financial_metric'?normalizedText(row.label):'',row.period].join(':');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
  }
  const conflicts=[];
  for(const [key,group] of groups){
    const values=new Set(group.map(f=>f.attribute==='tax_id'?f.value.replace(/\D/g,''):normalizedText(f.value)));
    if(values.size>1){group.forEach(f=>{f.conflict=true;});conflicts.push({key,label:group[0].label,fact_ids:group.map(f=>f.id),message:'Los documentos contienen valores diferentes. Revisa las fuentes y el período antes de usar este dato.'});}
  }
  const dimensions=Object.entries(MATRIX_DIMENSIONS).map(([id,label])=>{
    const facts=rows.filter(f=>f.dimension===id);const current=facts.filter(f=>f.evidence_status==='document_supported'&&!f.conflict);
    return {id,label,facts,status:!facts.length?'missing':facts.some(f=>f.conflict)?'conflicting':!current.length?'needs_review':'documented'};
  });
  const products=[...new Set(rows.filter(f=>f.scope==='company'&&f.evidence_status==='document_supported'&&!f.conflict
    &&['service','completed_experience'].includes(f.attribute)&&f.capability).map(f=>f.capability))];
  const codes=[...new Set(rows.filter(f=>f.scope==='company'&&f.attribute==='unspsc'&&f.evidence_status==='document_supported'&&!f.conflict)
    .map(f=>f.value.replace(/^V\d+\./i,'').replace(/\D/g,'')).filter(v=>/^\d{8}$/.test(v)))];
  const total=dimensions.length;const documented=dimensions.filter(d=>d.status==='documented').length;
  const pending=documents.filter(d=>d.document_status!=='deleted'&&['not_requested','processing','pending','queued'].includes(d.extraction_status)&&d.has_file).length;
  return {schema_version:1,as_of_date:today,dimensions,conflicts,facts:rows,
    coverage:{documented_dimensions:documented,total_dimensions:total,percentage:Math.round(documented/total*100),
      total_documents:active.size,documents_with_evidence:new Set(rows.map(f=>f.document_id)).size,pending_documents:pending,
      unavailable_documents:documents.filter(d=>!d.has_file&&!d.has_text).length},
    summary:rows.length?`${rows.length} datos con cita documental en ${new Set(rows.map(f=>f.document_id)).size} documentos. ${total-documented} áreas necesitan información o revisión.`:'Todavía no hay información documental suficiente para construir las capacidades de la empresa.',
    documented_capabilities:{products_services:products,unspsc_codes:codes},declared_profile:declared,
    missing_dimensions:dimensions.filter(d=>d.status==='missing').map(d=>({id:d.id,label:d.label})),
    disclaimer:'La IA organiza la evidencia aportada. La cobertura indica áreas documentadas; no certifica habilitación ni cumplimiento de una licitación.'};
}
