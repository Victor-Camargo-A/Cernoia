const normalize=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const english=['january','february','march','april','may','june','july','august','september','october','november','december'];
const days=['','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince','dieciseis','diecisiete','dieciocho','diecinueve','veinte','veintiuno','veintidos','veintitres','veinticuatro','veinticinco','veintiseis','veintisiete','veintiocho','veintinueve','treinta','treinta y uno'];
export function validMetadataDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value??''))return null;const d=new Date(`${value}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value?value:null;}
function containsDate(quote,value){
 const [y,m,d]=value.split('-').map(Number);const q=normalize(quote).replace(/\s*([/.-])\s*/g,'$1');
 const n=(v)=>`0?${v}`;
 if(new RegExp(`\\b(?:${y}[-/.]${n(m)}[-/.]${n(d)}|${n(d)}[-/.]${n(m)}[-/.]${y})\\b`).test(q))return true;
 const month=`(?:${months[m-1]}|${months[m-1].slice(0,3)}|${english[m-1]}|${english[m-1].slice(0,3)})`;
 if(new RegExp(`\\b(?:${n(d)}|${days[d]})(?:\\s*\\(0?${d}\\))?[\\s,().-]*(?:dias?\\s+del?\\s+mes\\s+)?(?:de\\s+)?${month}[\\s,().-]*(?:de[l]?\\s+)?(?:ano\\s+)?${y}\\b`).test(q))return true;
 return new RegExp(`\\b${month}\\s+${n(d)}(?:st|nd|rd|th)?[,]?\\s+${y}\\b`).test(q);
}
export function validateSemanticMetadata(raw,text){
 const source=normalize(text),issues=[];
 const quoteOK=q=>normalize(q).length>=5&&normalize(q).length<=1000&&source.includes(normalize(q));
 let type=null,label=null;
 if(/^[a-z][a-z0-9_]{1,79}$/.test(raw.document_type??'')&&String(raw.document_type_label??'').trim().length>0&&String(raw.document_type_label??'').trim().length<=140&&raw.type_confidence==='high'&&quoteOK(raw.type_quote)){type=raw.document_type;label=String(raw.document_type_label).trim();}
 else issues.push('No se pudo confirmar el tipo documental con una cita clara.');
 function date(field,quote,confidence){
  if(!raw[field])return null;
  const value=validMetadataDate(raw[field]);
  const q=normalize(raw[quote]);
  if(field==='issue_date'&&/fecha de (?:registro|inscripcion|nacimiento|matricula|apertura)/.test(q)&&!/(?:exped|emisi|emitid|generad|suscri|firmad)/.test(q)){issues.push('La fecha encontrada corresponde a un registro, no a la expedición del documento.');return null;}
  if(value&&raw[confidence]==='high'&&quoteOK(raw[quote])&&containsDate(raw[quote],value))return value;
  issues.push(`La fecha ${field==='issue_date'?'de expedición':'de vencimiento'} requiere revisión.`);return null;
 }
 const issue=date('issue_date','issue_quote','issue_confidence');
 let expiry=raw.expiration_kind==='explicit'?date('expiration_date','expiration_quote','expiration_confidence'):null;
 let days=null;
 if(raw.expiration_kind==='duration'){
  if(raw.expiration_confidence==='high'&&Number.isInteger(raw.validity_days)&&raw.validity_days>0&&raw.validity_days<=36500&&quoteOK(raw.validity_quote)&&new RegExp(`\\b${raw.validity_days}\\b`).test(raw.validity_quote)&&/d[ií]as/i.test(raw.validity_quote))days=raw.validity_days;
  else issues.push('La duración de validez requiere revisión.');
 }
 if(issue&&expiry&&expiry<issue){expiry=null;issues.push('El vencimiento precede a la expedición.');}
 if(!issue)issues.push('El texto no permite confirmar la fecha de expedición.');
 return {document_type:type,document_type_label:label,issue_date:issue,expiration_date:expiry,validity_days:days,expiration_kind:raw.expiration_kind,issues,evidence:{type_quote:raw.type_quote??'',issue_quote:raw.issue_quote??'',expiration_quote:raw.expiration_quote??'',validity_quote:raw.validity_quote??'',notes:raw.notes??''}};
}
export function addMetadataDays(date,days){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+Number(days));return d.toISOString().slice(0,10);}
export function mergeSemanticMetadata(document,analysis,policy={}){
 const iso=v=>v instanceof Date?v.toISOString().slice(0,10):v?String(v).slice(0,10):null;
 const corrected=['corrected','rejected'].includes(document.review_status);
 const locks=document.metadata?.manual_metadata_fields??[];
 const keepType=locks.includes('document_type')||(corrected&&document.document_type&&!['other_document','auto_detect'].includes(document.document_type));
 const type=keepType?document.document_type:analysis.document_type||document.document_type;
 const issue=locks.includes('issue_date')?iso(document.issue_date):(corrected&&document.issue_date?iso(document.issue_date):analysis.issue_date||iso(document.issue_date));
 let expiry=locks.includes('expiration_date')?iso(document.expiration_date):(corrected&&document.expiration_date?iso(document.expiration_date):analysis.expiration_date);
 let expirySource=corrected&&document.expiration_date||locks.includes('expiration_date')?'manual':expiry?'document':'not_stated';
 if(!expiry&&!locks.includes('expiration_date')&&issue&&analysis.validity_days){expiry=addMetadataDays(issue,analysis.validity_days);expirySource='document_duration';}
 if(!expiry&&!locks.includes('expiration_date')&&issue&&analysis.expiration_kind!=='not_applicable'&&policy.validity_days){expiry=addMetadataDays(issue,policy.validity_days);expirySource='policy';}
 if(!expiry&&analysis.expiration_kind==='not_applicable')expirySource='not_applicable';
 const label=type===analysis.document_type?analysis.document_type_label:document.ai_classification?.document_type_label||null;
 const original=String(document.original_filename??'').replace(/\.[^.]+$/,'');
 const keepName=locks.includes('document_name')||(corrected&&document.document_name!==original);
 return {document_type:type==='auto_detect'?'other_document':type,document_type_label:label,document_name:keepName?document.document_name:label?`${label}${issue?` — ${issue}`:''}`.slice(0,180):document.document_name,issue_date:issue,expiration_date:expiry,expiration_source:expirySource,policy_validity_days:policy.validity_days??null,alert_days_before:policy.alert_days_before??5,requires_review:analysis.issues.length>0||!analysis.document_type};
}
