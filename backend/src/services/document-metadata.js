// Metadata is derived only from explicit document text, never from the upload date.
const types = [
 ['rup', 'Registro Único de Proponentes', /registro unico de proponentes/],
 ['chamber_of_commerce', 'Certificado de Cámara de Comercio', /certificado de existencia y representacion legal|certificado de matricula mercantil/],
 ['rut', 'Registro Único Tributario', /registro unico tributario/],
 ['fiscal_background', 'Antecedentes fiscales', /certificado de antecedentes fiscales|boletin de responsables fiscales/],
 ['disciplinary_background', 'Antecedentes disciplinarios', /certificado de antecedentes disciplinarios/],
 ['police_background', 'Antecedentes de Policía', /antecedentes penales y requerimientos judiciales/],
 ['judicial_measures', 'Medidas correctivas', /registro nacional de medidas correctivas/],
 ['identity_document', 'Documento de identidad', /^(?:republica de colombia\s+)?(?:identificacion personal\s+)?cedula de ciudadania/],
 ['financial_statement', 'Estado financiero', /estado de situacion financiera|balance general/],
 ['experience_certificate', 'Certificado de experiencia', /certificado de experiencia|certificacion de experiencia/],
];
const normalize = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function dateValue(raw) {
 const value=normalize(raw).trim();
 let year,month,day;
 let m=value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
 if(m) [,year,month,day]=m;
 else if((m=value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [,day,month,year]=m;
 else if((m=value.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/))) {day=m[1];month=months.indexOf(m[2])+1;year=m[3];}
 else return null;
 const iso=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 const parsed=new Date(`${iso}T00:00:00Z`);
 return Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==iso?null:iso;
}
function labeledDate(text,label) {
 const pattern=new RegExp(`(?:${label})[\\s:：-]{0,20}(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|\\d{1,2}\\s+de\\s+[a-z]+\\s+de\\s+\\d{4})`,'g');
 const values=[...text.matchAll(pattern)].map(m=>dateValue(m[1]));
 const unique=[...new Set(values.filter(Boolean))];
 return {value:unique.length===1?unique[0]:null,ambiguous:unique.length>1||values.some(v=>!v)};
}
export function inferDocumentMetadata(text, document={}) {
 const normalized=normalize(text);
 // Prefer titles in the first 1800 characters; incidental references do not classify a file.
 const matches=types.filter(([, ,pattern])=>pattern.test(normalized.slice(0,1800)));
 const type=matches.length===1?matches[0]:null;
 const issue=labeledDate(normalized,'fecha (?:y hora )?(?:de )?expedicion|fecha (?:de )?emision|expedido el|emitido el|generado el|fecha (?:de )?generacion(?: (?:del )?documento(?: pdf)?)?');
 const expiry=labeledDate(normalized,'fecha (?:de )?vencimiento|vigencia hasta|valido hasta|validez hasta|vence el');
 const storedDate=value=>value instanceof Date?value.toISOString().slice(0,10):value;
 const issueDate=storedDate(document.issue_date) || issue.value;
 const expirationDate=storedDate(document.expiration_date) || expiry.value;
 const conflict=Boolean(issueDate&&expirationDate&&String(expirationDate).slice(0,10)<String(issueDate).slice(0,10));
 const documentType=document.document_type==='auto_detect'?(type?.[0]??'other_document'):document.document_type;
 return {
  document_type:documentType || 'other_document',
  document_name:document.document_type==='auto_detect'&&type?`${type[1]}${issueDate?` — ${String(issueDate).slice(0,10)}`:''}`:document.document_name,
  issue_date:issueDate || null, expiration_date:conflict?null:expirationDate || null,
  organization_type:null,
  requires_review: !type || !issueDate || issue.ambiguous || expiry.ambiguous || conflict,
 };
}
