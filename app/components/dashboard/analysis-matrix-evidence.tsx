"use client";
export type AnalysisMatrixMetadata={integrated:boolean;revision:number|null;version_id:string|null;generated_at:string|null;as_of_date:string|null;facts_count:number;current_revision:number;waiting:boolean;stale:boolean};
export type AnalysisMatrixFact={id:string;document_id:string;document_name:string;evidence_quote:string;evidence_status:string;label:string;value:string};
export function AnalysisMatrixEvidence({metadata,facts,result,status}:{metadata:AnalysisMatrixMetadata|undefined;facts:AnalysisMatrixFact[]|undefined;result:Record<string,unknown>|null;status:string}){
 const requirements=Array.isArray(result?.possible_requirements)?result.possible_requirements as {requirement:string;assessment:string;evidence:string;matrix_fact_ids?:string[]}[]:[];
 const labels:Record<string,string>={cumple:"Con soporte para revisión",no_cumple:"Diferencia identificada",por_verificar:"Por verificar",no_aplica:"No aplica"};
 const evidenceLabels:Record<string,string>={expired:"Vigencia registrada vencida",declared:"Declaración empresarial",needs_review:"Requiere revisión",not_yet_valid:"Vigencia futura",document_supported:"Con soporte documental"};
 return <section className="space-y-3 rounded-xl border border-teal-100 bg-white p-4 text-sm">
  <h3 className="font-semibold">Matriz empresarial utilizada</h3>
  {status==='queued'&&metadata?.waiting?<p className="text-amber-800">Esperando que termine la actualización de tus documentos. El análisis continuará automáticamente con la matriz actualizada.</p>:!metadata?.integrated?<p className="text-amber-800">Este análisis se generó antes de integrar la matriz documental. Usa «Reanalizar con documentos actuales» para incorporarla.</p>:<>
   <p>Versión {metadata.revision} · {metadata.facts_count} datos citados · Evaluación de vigencias: {metadata.as_of_date}</p>
   {metadata.stale&&<p className="rounded-lg bg-amber-50 p-3 text-amber-900">La matriz o sus vigencias cambiaron después de esta lectura. Reanaliza para actualizar la compatibilidad. Este resultado conserva la evidencia utilizada en su momento.</p>}
  </>}
  {!!requirements.length&&<details><summary className="cursor-pointer font-medium">Comparación con la evidencia empresarial</summary><div className="mt-3 space-y-3">{requirements.map((r,index)=><article key={index} className="space-y-2 rounded-lg bg-slate-50 p-3"><div className="flex flex-wrap justify-between gap-2"><strong>{r.requirement}</strong><span className="text-teal-800">{labels[r.assessment]??r.assessment}</span></div><p className="text-slate-600">{r.evidence}</p>{(r.matrix_fact_ids??[]).map(id=>{const fact=facts?.find(f=>f.id===id);return fact?<div key={id} className="space-y-1 border-l-2 border-teal-300 pl-3"><p className="text-xs text-slate-500">{evidenceLabels[fact.evidence_status]??fact.evidence_status}</p><blockquote className="text-slate-600">“{fact.evidence_quote}”</blockquote><a href={`/api/documents/${encodeURIComponent(fact.document_id)}/file`} className="text-xs text-teal-800 underline" target="_blank" rel="noreferrer">{fact.document_name}</a></div>:null;})}</article>)}</div></details>}
  <p className="text-xs text-slate-500">La afinidad comercial y la acreditación documental son evaluaciones distintas. Esta lectura conserva los faltantes y requiere revisión de los pliegos.</p>
 </section>;
}
