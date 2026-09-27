import { CalendarClock, ExternalLink } from "lucide-react";
import type { Opportunity } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { opportunityDays } from "@/lib/opportunity-schedule";

const tones={teal:"border-teal-200 bg-teal-50 text-teal-800",amber:"border-amber-200 bg-amber-50 text-amber-900",sky:"border-sky-200 bg-sky-50 text-sky-800",violet:"border-violet-200 bg-violet-50 text-violet-800",slate:"border-slate-200 bg-slate-100 text-slate-700",rose:"border-rose-200 bg-rose-50 text-rose-800"};
export function ProcessDeadline({item}:{item:Opportunity}) {
  const s=item.schedule;
  if(!s) return <span className="text-xs text-slate-600">Consultar cronograma</span>;
  const days=opportunityDays(item);
  const laterMilestone=s.later_stage?s.milestones.find(m=>m.kind==="award")??s.milestones.find(m=>m.kind==="actual_opening"):null;
  const date=laterMilestone??s.deadline;
  return <div className="space-y-1.5 whitespace-normal text-left"><span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold leading-4 ${tones[s.tone]}`}>{s.label}</span>{date&&<><p className="text-xs text-slate-500">{laterMilestone?.label??s.deadline_label}</p><p className="text-sm font-semibold tabular-nums text-slate-900">{formatDate(date.value,date.precision==="datetime")}</p></>}<p className="max-w-56 text-xs leading-4 text-slate-500">{!date?"Revisar cronograma en SECOP":s.later_stage?"Etapa posterior · revisar actuaciones":date.precision==="date"?`${days===0?"Hoy · ":days===1?"Mañana · ":""}Hora por confirmar en SECOP`:"Hora de Colombia"}</p></div>;
}
export function ProcessSchedulePanel({item}:{item:Opportunity}) {
  const s=item.schedule;
  if(!s)return null;
  return <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><CalendarClock className="size-5 text-teal-700"/>Cronograma para participar</h3><span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tones[s.tone]}`}>{s.label}</span></div>
    <p className="text-sm leading-6 text-slate-600">{s.message}</p>
    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-teal-100 bg-teal-50/50 p-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-teal-800">{s.deadline_label}</h4><p className="mt-2 font-semibold">{s.deadline?formatDate(s.deadline.value,s.deadline.precision==="datetime"):"Consultar en el cronograma"}</p><p className="mt-1 text-xs leading-5 text-slate-600">{s.deadline?.precision==="datetime"?"Fecha y hora de Colombia":s.deadline?"Día publicado · hora pendiente de confirmar":"El dato abierto no incluye esta fecha."}</p></div><div className="rounded-xl border bg-slate-50 p-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Manifestación de interés</h4><p className="mt-2 font-semibold">Consultar si aplica</p><p className="mt-1 text-xs leading-5 text-slate-600">Puede vencer antes del envío de la oferta. Suscribirse al proceso no reemplaza este trámite.</p></div></div>
    {s.milestones.some(m=>m.kind!=="submission")&&<div><h4 className="text-sm font-semibold">Otros hitos publicados</h4><dl className="mt-2 divide-y text-sm">{s.milestones.filter(m=>m.kind!=="submission").map(m=><div key={m.kind} className="flex flex-wrap justify-between gap-2 py-2"><dt className="text-slate-600">{m.label}</dt><dd>{formatDate(m.value,m.precision==="datetime")}{m.precision==="date"&&<span className="ml-1 text-xs text-slate-500">· sin hora</span>}</dd></div>)}</dl></div>}
    <p className="text-xs leading-5 text-slate-500">Estado publicado: {item.process_status||"No disponible"}{item.phase?` · Fase: ${item.phase}`:""}. Fuente: {s.source}. Las fechas de apertura y adjudicación no son plazos para enviar una oferta.</p>
    {s.source_link_kind==="search"&&<p className="text-xs leading-5 text-slate-600">La fuente no proporciona un enlace directo al expediente. Busca en SECOP la referencia {item.reference||item.secop_process_id}.</p>}
    {s.source_url&&<a href={s.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-[#0b5963] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#084852] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700">{s.source_link_kind==="search"?"Buscar proceso en SECOP":"Ver cronograma y adendas en SECOP"}<ExternalLink className="size-4"/></a>}
  </section>;
}
