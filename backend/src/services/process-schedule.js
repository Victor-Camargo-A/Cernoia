// Open-data midnight timestamps carry a calendar date, not a verified closing hour.
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function sourceDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)) return null;
  const day = text.slice(0, 10);
  const parsed = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?)?$/.test(text)) return { value: day, precision: 'date' };
  const instant = new Date(/[Z]|[+-]\d{2}:\d{2}$/.test(text) ? text : text + '-05:00');
  return Number.isFinite(instant.getTime()) ? { value: instant.toISOString(), precision: 'datetime' } : null;
}
export function officialProcessUrl(value, rawUrl) {
  for (const candidate of [rawUrl?.url, typeof rawUrl === 'string' ? rawUrl : null, value]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'community.secop.gov.co' && !url.port && !url.username && !url.password && url.pathname.startsWith('/Public/')) return url.href;
    } catch { /* Ignore incomplete or previously stringified URL objects. */ }
  }
  return null;
}
export function processSchedule(process, now = new Date()) {
  const raw = process.schedule_source ?? process.raw_json ?? {};
  const deadline = sourceDate(raw.fecha_de_recepcion_de) ?? (process.response_deadline ? sourceDate(new Date(process.response_deadline).toISOString()) : null);
  const phase = normalize(process.phase ?? raw.fase);
  const status = normalize(process.process_status ?? raw.estado_del_procedimiento);
  const summary = normalize(process.summary_status ?? raw.estado_resumen);
  const combined = status + ' ' + summary;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
  const expired = deadline && (deadline.precision === 'date' ? deadline.value < today : new Date(deadline.value) <= now);
  const award = sourceDate(raw.fecha_adjudicacion);
  const actualOpening = sourceDate(raw.fecha_de_apertura_efectiva);
  const openingHasPassed = actualOpening && (actualOpening.precision === 'date' ? actualOpening.value < today : new Date(actualOpening.value) <= now);
  let code = 'unconfirmed', label = 'Plazo por verificar', tone = 'amber', later = false;
  if (/cancelad|revocad|desiert/.test(combined)) { code='cancelled';label=/desiert/.test(combined)?'Declarado desierto':'Cancelado';tone='rose';later=true; }
  else if (process.awarded === true || /adjudicad/.test(combined)) {code='awarded';label='Adjudicado';tone='slate';later=true;}
  else if (/terminad|finalizad|celebrad|liquidad/.test(combined)) {code='finished';label='Finalizado';tone='slate';later=true;}
  else if (/seleccionad/.test(combined)) {code='selected';label='Selección realizada';tone='violet';later=true;}
  else if (/evaluaci|evaluation|apertura de ofertas/.test(combined)) {code='evaluation';label='En evaluación';tone='violet';later=true;}
  else if (/cerrad/.test(combined)) {code='closed';label='Cerrado';tone='slate';later=true;}
  else if (expired) {code='expired';label='Plazo de respuestas vencido';tone='slate';later=true;}
  else if (openingHasPassed) {code='opened';label='Ofertas abiertas';tone='violet';later=true;}
  else if (/manifestacion|expression of interest/.test(phase)) {code='interest';label='Manifestación de interés';tone='sky';}
  else if (/observacion|clarification|borrador|precalific/.test(phase)) {code='preparation';label='Etapa previa a ofertas';tone='sky';}
  else if (deadline) {code='submission';label=deadline.value.slice(0,10)===today?'Vence hoy · confirmar hora':'Recepción de ofertas';tone=deadline.value.slice(0,10)===today?'amber':'teal';}
  const deadlineLabel = later ? 'Plazo de respuestas publicado' : code==='interest' || code==='preparation' ? 'Recepción de respuestas publicada' : 'Presentar oferta y documentos';
  const milestones = [
    deadline && {kind:'submission',label:deadlineLabel,...deadline},
    sourceDate(raw.fecha_de_apertura_de_respuesta) && {kind:'planned_opening',label:'Apertura de respuestas prevista',...sourceDate(raw.fecha_de_apertura_de_respuesta)},
    actualOpening && {kind:'actual_opening',label:'Apertura de respuestas realizada',...actualOpening},
    award && {kind:'award',label:'Adjudicación publicada',...award},
  ].filter(Boolean);
  const directUrl=officialProcessUrl(process.process_url,raw.urlproceso);
  return { code, label, tone, later_stage:later, deadline, deadline_label:deadlineLabel,
    interest_deadline:null, milestones, source:'Datos abiertos de SECOP II',
    source_url:directUrl??'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO',
    source_link_kind:directUrl?'process':'search',
    message:later?'El proceso está en una etapa posterior o su plazo publicado ya venció. Consulta en SECOP las actuaciones habilitadas.':!deadline?'El conjunto de datos no incluye el plazo. Revisa el cronograma y sus adendas en SECOP.':deadline.precision==='date'?'La fuente publica el día, pero no una hora verificable. Confirma la hora límite en el cronograma.':'Hora de Colombia. Confirma posibles adendas antes de enviar la oferta.',
  };
}
export function withProcessSchedule(row) {
  const schedule=processSchedule(row);
  const result={...row,process_url:schedule.source_url,schedule};
  delete result.schedule_source;
  return result;
}
