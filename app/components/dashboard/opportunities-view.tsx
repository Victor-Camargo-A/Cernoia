"use client";
import {ProcessPreparationPanel} from "./process-preparation-panel";
import {recordDemoConsulted} from "@/lib/marketing";
import {DocumentViewer,type DocumentViewerTarget} from "./document-viewer";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Bot, Building2, CalendarDays, CheckCircle2, ClipboardCheck,
  ExternalLink, FileSearch, FileText, Heart, Loader2, MapPin, Search, SlidersHorizontal,
  Sparkles, Star, Target,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  apiFetch, Opportunity, OpportunitySourceDocument, OpportunityStage, Requirement, User,
} from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import { EmptyState, ErrorState, LoadingList, ScoreBadge, stageLabels, StatusBadge } from "./shared";
import { DocumentEvidencePanel, DocumentReadiness } from "./document-evidence-panel";
import {type AnnexCatalog} from '@/lib/bids';
import { BidLifecycle } from "./bid-workspace";
import { ProposalWorkspace } from "./proposal-workspace";
import { ProcessDeadline, ProcessSchedulePanel } from "./process-schedule";

import { AnalysisMatrixEvidence, type AnalysisMatrixMetadata, type AnalysisMatrixFact } from "./analysis-matrix-evidence";

type OpportunityDetail = {
  document_readiness: DocumentReadiness;
  opportunity: Opportunity;
  analysis: {
    id: string;
    queued_at: string;
    analysis_status: string;
    compatibility_score: string | number | null;
    confidence_score: string | number | null;
    decision: string | null;
    executive_summary: string | null;
    analysis_result: Record<string, unknown> | null;
    company_matrix?: AnalysisMatrixMetadata;
    company_matrix_facts?: AnalysisMatrixFact[];
  } | null;
  has_successful_analysis?: boolean;
  counts: { requirements: number; source_documents: number };
};

const stages = Object.entries(stageLabels) as Array<[OpportunityStage, string]>;

export function OpportunitiesView({ user }: { user: User }) {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [department, setDepartment] = useState("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [minimumInput, setMinimumInput] = useState("60");
  const [savingMinimum, setSavingMinimum] = useState(false);
  const [includeBelow, setIncludeBelow] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ source_updated_through?: string; last_sync_at?: string; total_processes?: number; running?: boolean } | null>(null);
  const [catalog,setCatalog]=useState<AnnexCatalog|null>(null),[catalogLoading,setCatalogLoading]=useState(false),[catalogRevision,setCatalogRevision]=useState(0);
  const [detailTab,setDetailTab]=useState("requirements");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [sourceViewer,setSourceViewer]=useState<DocumentViewerTarget|null>(null);
  const [sourceDocuments, setSourceDocuments] = useState<OpportunitySourceDocument[]>([]);
  useEffect(()=>{if(!selectedId)return;let alive=true;setCatalog(null);setCatalogLoading(true);void apiFetch<AnnexCatalog>(`/opportunities/${selectedId}/annex-catalog`,{method:'POST',body:'{}'}).then(r=>{if(alive)setCatalog(r);}).catch(()=>{if(alive)setCatalog({entries:[],warnings:[{document_id:'catalog',filename:'Formatos',message:'No se pudo consultar la lista. Actualiza los formatos para reintentar.'}]});}).finally(()=>{if(alive)setCatalogLoading(false);});return()=>{alive=false;};},[selectedId,catalogRevision]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingState, setSavingState] = useState(false);
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [activeAnalysis,setActiveAnalysis]=useState<{id:string;processId:string;started:number}|null>(null);
  const [analysisMessage,setAnalysisMessage]=useState("");
  const [elapsed,setElapsed]=useState(0);

  const [draftStage, setDraftStage] = useState<OpportunityStage>("watching");
  const [draftNotes, setDraftNotes] = useState("");
  const canEdit = user.role !== "viewer";
  const canRun = user.role === "owner" || user.role === "admin";

  const analysisResultRef=useRef<HTMLParagraphElement|null>(null);
  useEffect(()=>{
    if(!selectedId||detail?.opportunity.process_id!==selectedId||detail?.analysis?.analysis_status!=="success"||!detail.analysis.executive_summary)return;
    const analysisId=detail.analysis.id,element=analysisResultRef.current;if(!element)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)&&document.visibilityState==='visible')void recordDemoConsulted(analysisId);},{threshold:0.25});
    const observe=()=>{observer.disconnect();observer.observe(element);};observe();document.addEventListener('visibilitychange',observe);
    return()=>{observer.disconnect();document.removeEventListener('visibilitychange',observe);};
  },[selectedId,detail?.analysis?.id,detail?.analysis?.analysis_status,detail?.analysis?.executive_summary,detailLoading]);
  const [lookupMessage,setLookupMessage]=useState("");
  const loadRequest = useRef(0);
  const load = useCallback(async (background = false) => {
    const requestId = ++loadRequest.current;
    if (!background) setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ page: String(page), limit: "15" });
      if (submittedQuery) parameters.set("q", submittedQuery);
      if (stage !== "all") parameters.set("stage", stage);
      if (department !== "all") parameters.set("department", department);
      if (favoriteOnly) parameters.set("favorite", "true");
      if (includeBelow) parameters.set("minScore", "0");
      if (includeClosed) parameters.set("includeClosed", "true");
      const exactReference=/^[\p{L}\p{N}._/]+(?:[- ][\p{L}\p{N}._/]+){2,}$/u.test(submittedQuery)&&/\d{4}/.test(submittedQuery);
      const data = await apiFetch<{ items: Opportunity[]; pagination: { total: number; pages: number }; minimum_match_score: number;lookup_message?:string }>(exactReference?'/opportunities/lookup':`/opportunities?${parameters}`,exactReference?{method:'POST',body:JSON.stringify({reference:submittedQuery})}:undefined);
      if (requestId !== loadRequest.current) return;
      setItems(data.items);setLookupMessage(data.lookup_message??"");
      if (!background) setMinimumInput(String(data.minimum_match_score ?? 60));
      setTotal(data.pagination.total);
      setPages(data.pagination.pages);
    } catch (requestError) {
      if (requestId === loadRequest.current) setError(requestError instanceof Error ? requestError.message : "No fue posible consultar las oportunidades.");
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [department, favoriteOnly, page, stage, submittedQuery, includeBelow, includeClosed]);

  useEffect(() => {
    apiFetch<{ departments: string[] }>("/filters").then((data) => setDepartments(data.departments)).catch(() => {});
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("cernoia:refresh", refresh);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 60_000);
    return () => { window.removeEventListener("cernoia:refresh", refresh); window.clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    const refresh = () => apiFetch<{ source_updated_through?: string; last_sync_at?: string; total_processes?: number; running?: boolean }>("/market/sync-status").then(setSyncStatus).catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function saveMinimum() {
    if (!minimumInput.trim() || !Number.isFinite(Number(minimumInput)) || Number(minimumInput) < 0 || Number(minimumInput) > 100) {
      toast.error("Escribe un porcentaje entre 0 y 100."); return;
    }
    setSavingMinimum(true);
    try {
      await apiFetch("/account/match-threshold", { method: "PATCH", body: JSON.stringify({ minimum_match_score: Number(minimumInput) }) });
      if (page !== 1) setPage(1); else await load();
      toast.success("Afinidad mínima guardada para tu empresa. También se aplica a los próximos análisis de IA.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar el porcentaje."); }
    finally { setSavingMinimum(false); }
  }

  async function openDetail(processId: string) {
    setSelectedId(processId);
    setDetailTab("requirements");
    setDetailLoading(true);
    setDetail(null);
    setRequirements([]);
    setSourceDocuments([]);
    try {
      const [detailData, requirementData, documentData] = await Promise.all([
        apiFetch<OpportunityDetail>(`/opportunities/${processId}`),
        apiFetch<{ items: Requirement[] }>(`/opportunities/${processId}/requirements`),
        apiFetch<{ items: OpportunitySourceDocument[] }>(`/opportunities/${processId}/documents`),
      ]);
      setDetail(detailData);
      if(detailData.analysis && ['queued','running'].includes(detailData.analysis.analysis_status)) {
        setActiveAnalysis({id:detailData.analysis.id,processId,started:new Date(detailData.analysis.queued_at).getTime()});setRunningAnalysis(true);
      }
      setRequirements(requirementData.items);
      setSourceDocuments(documentData.items);
      setDraftStage(detailData.opportunity.stage);
      setDraftNotes(detailData.opportunity.notes ?? "");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible abrir la oportunidad.");
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveState(overrides: Partial<{ stage: OpportunityStage; is_favorite: boolean; notes: string }> = {}) {
    if (!detail) return;
    const payload = {
      stage: overrides.stage ?? draftStage,
      is_favorite: overrides.is_favorite ?? detail.opportunity.is_favorite,
      notes: overrides.notes ?? draftNotes,
    };
    setSavingState(true);
    try {
      const data = await apiFetch<{ state: { stage: OpportunityStage; is_favorite: boolean; notes: string | null } }>(
        `/opportunities/${detail.opportunity.process_id}/state`,
        { method: "PATCH", body: JSON.stringify(payload) },
      );
      setDetail((current) => current ? { ...current, opportunity: { ...current.opportunity, ...data.state } } : current);
      setItems((current) => current.map((item) => item.process_id === detail.opportunity.process_id ? { ...item, ...data.state } : item));
      setDraftStage(data.state.stage);
      setDraftNotes(data.state.notes ?? "");
      toast.success("La oportunidad quedó actualizada.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible guardar los cambios.");
    } finally {
      setSavingState(false);
    }
  }

  async function refreshDetail(processId:string) {
    const [next,reqs,docs]=await Promise.all([apiFetch<OpportunityDetail>(`/opportunities/${processId}`),apiFetch<{items:Requirement[]}>(`/opportunities/${processId}/requirements`),apiFetch<{items:OpportunitySourceDocument[]}>(`/opportunities/${processId}/documents`)]);
    setDetail(current=>current?.opportunity.process_id===processId?next:current);
    setRequirements(reqs.items);setSourceDocuments(docs.items);
  }

  async function runAnalysis() {
    if (!detail) return;
    setRunningAnalysis(true);setAnalysisMessage("Enviando solicitud…");
    try {
      const result=await apiFetch<{analysis:{id:string}}>(`/workflows/analyses/${detail.opportunity.process_id}`, {method:"POST",body:"{}"});
      setActiveAnalysis({id:result.analysis.id,processId:detail.opportunity.process_id,started:Date.now()});
      setAnalysisMessage("Solicitud registrada. En espera del motor de análisis.");
    } catch(error) {
      setAnalysisMessage(error instanceof Error?error.message:"No fue posible iniciar el análisis.");
      toast.error(error instanceof Error?error.message:"No fue posible iniciar el análisis.");setRunningAnalysis(false);
    }
  }
  useEffect(()=>{
    if(!activeAnalysis) return;
    let cancelled=false; let polling=false;
    const tick=()=>setElapsed(Math.max(0,Math.floor((Date.now()-activeAnalysis.started)/1000)));
    const poll=async()=>{
      if(polling)return;polling=true;
      try {
        const {analysis}=await apiFetch<{analysis:{analysis_status:string;quota_deferred_at:string|null;company_matrix?:AnalysisMatrixMetadata}}>(`/workflows/analyses/${activeAnalysis.id}`);
        if(cancelled)return;
        const status=analysis.analysis_status;
        if(status==='success') {
          setAnalysisMessage('Análisis IA completado. Los requisitos documentales se actualizan al terminar su extracción.');setRunningAnalysis(false);setActiveAnalysis(null);
          await refreshDetail(activeAnalysis.processId);void load();toast.success('Análisis actualizado con la evidencia disponible.');
        }else if(['failed','review_required'].includes(status)) {
          setAnalysisMessage(status==='failed'?'El análisis falló. Puedes volver a intentarlo.':'Completa y valida el perfil antes de analizar.');setRunningAnalysis(false);setActiveAnalysis(null);
        }else setAnalysisMessage(analysis.company_matrix?.waiting?'Esperando la matriz actualizada. El análisis continuará automáticamente cuando termine la lectura documental.':analysis.quota_deferred_at?'Análisis aplazado por la cuota de IA. La solicitud sigue registrada.':status==='running'?'La IA está comparando el proceso y las evidencias de tu empresa.':'Solicitud en cola. Esperando el turno del motor de análisis.');
      }catch{if(!cancelled)setAnalysisMessage('No se pudo consultar el avance. Volveremos a comprobarlo; esto no significa que el análisis haya terminado.');}
      finally{polling=false;}
    };
    tick();void poll();const clock=window.setInterval(tick,1000);const timer=window.setInterval(()=>void poll(),5000);
    return()=>{cancelled=true;window.clearInterval(clock);window.clearInterval(timer);};
  },[activeAnalysis,load]);
  useEffect(()=>{
    if(!selectedId)return;
    let busy=false;
    const timer=window.setInterval(async()=>{if(busy)return;busy=true;try{await refreshDetail(selectedId);}catch{}finally{busy=false;}},15000);
    return()=>window.clearInterval(timer);
  },[selectedId]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  }

  const matchedRequirements = useMemo(
    () => requirements.filter((item) => item.document_match_status === "matched").length,
    [requirements],
  );

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-teal-200 bg-teal-50 px-5 py-4 text-sm text-teal-950"><p className="font-semibold">{Number(syncStatus?.total_processes??0).toLocaleString("es-CO")} procesos SECOP II en CernoIA · vigentes e históricos</p><p className="mt-1">Última sincronización: {formatDate(syncStatus?.last_sync_at, true)} · Datos procesados hasta: {formatDate(syncStatus?.source_updated_through)}{syncStatus?.running ? " · Actualización en curso" : ""}</p><p className="mt-1 text-xs">Actualización automática cada 5 minutos. El listado se refresca cada minuto. SECOP puede publicar sus datos abiertos después de mostrarlos en su portal.</p></div>
      {lookupMessage&&<p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{lookupMessage}</p>}
      <Card className="border-slate-200 bg-white py-4 shadow-sm">
        <CardContent className="px-4 sm:px-5">
          <form onSubmit={submitSearch} className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_190px_210px_auto_auto]">
            <div className="relative min-w-0"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Proceso, entidad o referencia" placeholder="Proceso, entidad o referencia" className="h-10 pl-9" /></div>
            <Select value={stage} onValueChange={(value) => { setStage(value ?? "all"); setPage(1); }}>
              <SelectTrigger className="h-10 w-full"><SlidersHorizontal /><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Todas las etapas</SelectItem>{stages.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={department} onValueChange={(value) => { setDepartment(value ?? "all"); setPage(1); }}>
              <SelectTrigger className="h-10 w-full"><MapPin /><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Todo el país</SelectItem>{departments.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" variant={favoriteOnly ? "default" : "outline"} className={favoriteOnly ? "bg-[#0b5963]" : ""} onClick={() => { setFavoriteOnly((value) => !value); setPage(1); }}><Heart className={favoriteOnly ? "fill-current" : ""} /> Guardadas</Button>
            <Button type="submit" className="bg-[#0b5963] text-white hover:bg-[#084852]">Buscar</Button>
          </form>
          <p className="mt-3 text-xs text-slate-600">Escribe una referencia completa, por ejemplo SA-SA-MC-014-2026, para buscarla también en la fuente oficial aunque no coincida con tus filtros.</p>
          <div className="mt-5 flex flex-wrap items-end gap-3 border-t pt-4"><div className="space-y-2"><Label htmlFor="opportunity-minimum">Afinidad mínima de tu empresa (%)</Label><Input id="opportunity-minimum" type="number" min="0" max="100" step="1" value={minimumInput} onChange={e => setMinimumInput(e.target.value)} disabled={!canRun || savingMinimum || loading} className="w-32" /></div>{canRun && <Button type="button" variant="outline" onClick={saveMinimum} disabled={savingMinimum || loading}>{savingMinimum ? <Loader2 className="animate-spin" /> : null} Guardar mínimo</Button>}<Button type="button" variant={includeBelow ? "default" : "outline"} onClick={() => { setIncludeBelow(v => !v); setPage(1); }}>Incluir por debajo del mínimo</Button><Button type="button" variant={includeClosed ? "default" : "outline"} onClick={() => { setIncludeClosed(v => !v); setPage(1); }}>Historial y cerradas</Button></div><p className="mt-3 text-xs leading-5 text-slate-500">La afinidad compara los criterios registrados; no representa una probabilidad de ganar. Un mínimo mayor reduce las oportunidades priorizadas y los próximos análisis de IA.</p>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
          <div><h2 className="font-semibold text-slate-950">{total.toLocaleString("es-CO")} oportunidades</h2><p className="mt-0.5 text-xs text-slate-500">Ordenadas por relevancia y fecha de cierre.</p></div>
          <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800"><Sparkles /> Priorización inteligente</Badge>
        </div>
        {loading ? <LoadingList rows={7} /> : error ? <div className="p-5"><ErrorState message={error} retry={load} /></div> : items.length === 0 ? (
          <div className="p-5"><EmptyState title="No encontramos oportunidades" description="Ajusta los filtros o solicita una nueva actualización del mercado." /></div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader><TableRow><TableHead className="pl-5">Oportunidad</TableHead><TableHead>Ubicación</TableHead><TableHead>Presupuesto</TableHead><TableHead>Plazo y estado SECOP</TableHead><TableHead>Mi seguimiento</TableHead><TableHead className="pr-5 text-right">Afinidad</TableHead></TableRow></TableHeader>
                <TableBody>{items.map((item) => <TableRow key={item.id} onClick={() => openDetail(item.process_id)} className="cursor-pointer"><TableCell className="max-w-[390px] pl-5"><div className="flex items-start gap-2"><Star className={`mt-0.5 size-3.5 shrink-0 ${item.is_favorite ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} /><div className="min-w-0"><p className="truncate font-medium">{item.process_name || "Proceso sin nombre"}</p><p className="mt-1 truncate text-xs text-slate-500">{item.entity_name || "Entidad no informada"} · {item.reference || item.secop_process_id}</p></div></div></TableCell><TableCell><p>{item.city || "—"}</p><p className="text-xs text-slate-500">{item.department || "Sin departamento"}</p></TableCell><TableCell>{formatCurrency(item.base_price)}</TableCell><TableCell><ProcessDeadline item={item} /></TableCell><TableCell><StatusBadge status={stageLabels[item.stage]} /></TableCell><TableCell className="pr-5 text-right"><div className="inline-flex flex-col items-end gap-1"><ScoreBadge value={item.match_score} compact /><span className="text-[10px] text-slate-500">Afinidad</span>{item.ai_compatibility_score != null && <span className="text-xs text-teal-700">IA: {Number(item.ai_compatibility_score).toFixed(0)}%</span>}</div></TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
            <div className="divide-y md:hidden">
              {items.map((item) => (
                <button key={item.id} onClick={() => openDetail(item.process_id)} className="w-full p-4 text-left hover:bg-slate-50">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-2 font-semibold leading-5">{item.process_name || "Proceso sin nombre"}</p><p className="mt-1 truncate text-xs text-slate-500">{item.entity_name || "Entidad no informada"}</p></div><div className="inline-flex flex-col items-end gap-1"><ScoreBadge value={item.match_score} compact /><span className="text-[10px] text-slate-500">Afinidad</span>{item.ai_compatibility_score != null && <span className="text-xs text-teal-700">IA: {Number(item.ai_compatibility_score).toFixed(0)}%</span>}</div></div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500"><StatusBadge status={stageLabels[item.stage]} /><span>{formatCurrency(item.base_price)}</span></div><div className="mt-3 border-t pt-3"><ProcessDeadline item={item} /></div>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex items-center justify-between border-t px-4 py-4 text-sm sm:px-5"><span className="text-slate-500">Página {page} de {pages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ArrowLeft /> Anterior</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Siguiente <ArrowRight /></Button></div></div>
      </Card>

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-3xl">
          {detailLoading ? <div className="space-y-4 p-6"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-12" /><Skeleton className="h-80" /></div> : detail && (
            <>
              <SheetHeader className="opportunity-header border-b p-6 pr-14 text-white sm:p-7 sm:pr-14">
                <div className="mb-3 flex flex-wrap items-center gap-2"><ScoreBadge value={detail.opportunity.match_score} /><Badge className="border-white/10 bg-white/10 text-white">{stageLabels[detail.opportunity.stage]}</Badge></div>
                <SheetTitle className="text-xl leading-7 text-white sm:text-2xl">{detail.opportunity.process_name || "Proceso sin nombre"}</SheetTitle>
                <SheetDescription className="text-sm text-slate-300">{detail.opportunity.entity_name || "Entidad no informada"} · {detail.opportunity.reference || detail.opportunity.secop_process_id}</SheetDescription>
              </SheetHeader>

              <div className="space-y-5 p-5 sm:p-7">
                <section className="rounded-xl border bg-white p-4"><h3 className="font-semibold">Descripción publicada en SECOP II</h3><p className="mt-2 whitespace-pre-line text-sm leading-6">{detail.opportunity.description || "La fuente no informa descripción."}</p><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-500">Código SECOP II</dt><dd className="font-semibold">{detail.opportunity.secop_process_id}</dd></div><div><dt className="text-xs text-slate-500">Referencia de la entidad</dt><dd>{detail.opportunity.reference || "No informada"}</dd></div></dl></section>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border bg-slate-50 p-4"><CircleValue icon={CalendarDays} label="Fecha de publicación" value={formatDate(detail.opportunity.publication_date,true)} /></div>
                  <div className="rounded-xl border bg-slate-50 p-4"><CircleValue icon={Target} label="Presupuesto" value={formatCurrency(detail.opportunity.base_price)} /></div>
                  <div className="rounded-xl border bg-slate-50 p-4"><CircleValue icon={MapPin} label="Ubicación" value={[detail.opportunity.city, detail.opportunity.department].filter(Boolean).join(", ") || "Sin ubicación"} /></div>
                </div>

                <ProcessSchedulePanel item={detail.opportunity} />
                <ProcessPreparationPanel processId={detail.opportunity.process_id} canRun={canRun} onUpdated={()=>{void refreshDetail(detail.opportunity.process_id);setCatalogRevision(v=>v+1);}}/>
                {detail.document_readiness && <DocumentEvidencePanel onPrepare={()=>setDetailTab("proposal")} catalog={catalog} key={detail.opportunity.process_id} readiness={detail.document_readiness} requirements={requirements} canEdit={canEdit} onUploaded={()=>refreshDetail(detail.opportunity.process_id)} />}
                <section className="rounded-xl border bg-slate-50 p-4" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Análisis con IA y reanálisis</h3>{canRun&&<Button variant="outline" onClick={runAnalysis} disabled={runningAnalysis}>{runningAnalysis?<Loader2 className="animate-spin"/>:<Sparkles/>}{detail.analysis?'Reanalizar con documentos actuales':'Analizar oportunidad'}</Button>}</div><p className="mt-2 text-sm">{analysisMessage||'Cada análisis utiliza la última matriz empresarial disponible. Si tus documentos están en procesamiento, la solicitud espera y continúa automáticamente.'}</p>{runningAnalysis&&<p className="mt-3 text-sm font-medium tabular-nums">Tiempo transcurrido: {Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')} · {elapsed<240?`Estimación restante: ${Math.floor((240-elapsed)/60)}:${String((240-elapsed)%60).padStart(2,'0')}`:'Está tardando más de la estimación. Seguimos consultando el estado real.'}</p>}<p className="mt-2 text-xs text-slate-500">La estimación de 4 minutos puede variar según la cola y los documentos. La cuenta no confirma la finalización.</p></section>
                {detail.analysis&&<AnalysisMatrixEvidence metadata={detail.analysis.company_matrix} facts={detail.analysis.company_matrix_facts} result={detail.analysis.analysis_result} status={detail.analysis.analysis_status}/>}
                {detail.opportunity.compatibility && <section className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-5"><h3 className="flex items-center gap-2 font-semibold"><Target className="size-5" /> Resumen de coincidencia · {Number(detail.opportunity.match_score).toFixed(0)}%</h3><p className="mt-3 text-sm leading-6">{detail.opportunity.compatibility.summary}</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h4 className="text-sm font-semibold text-teal-900">A favor</h4><ul className="mt-2 space-y-2 text-sm">{detail.opportunity.compatibility.strengths.map(reason => <li key={reason}>✓ {reason}</li>)}</ul></div><div><h4 className="text-sm font-semibold text-amber-900">Por revisar</h4><ul className="mt-2 space-y-2 text-sm">{detail.opportunity.compatibility.gaps.map(reason => <li key={reason}>• {reason}</li>)}</ul></div></div><p className="mt-4 text-xs leading-5 text-slate-500">{detail.opportunity.compatibility.disclaimer}</p></section>}

                {detail.analysis?.executive_summary ? (
                  <div className="rounded-2xl border border-teal-200 bg-teal-50/70 p-5">
                    <div className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-teal-950"><Bot className="size-5" /> Lectura de inteligencia{detail.analysis.compatibility_score != null && <Badge variant="outline">Compatibilidad IA: {Number(detail.analysis.compatibility_score).toFixed(0)}%</Badge>}</div>
                    <p ref={analysisResultRef} className="text-sm leading-6 text-teal-950/80">{detail.analysis.executive_summary}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-2xl border border-dashed p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">Análisis pendiente</p><p className="mt-1 text-sm text-slate-500">El motor aún no ha generado una lectura ejecutiva para esta oportunidad.</p></div>{canRun && <Button variant="outline" onClick={runAnalysis} disabled={runningAnalysis}>{runningAnalysis ? <Loader2 className="animate-spin" /> : <Sparkles />} Analizar ahora</Button>}</div>
                )}

                {canEdit&&<Button className="w-full bg-[#0b5963] hover:bg-[#084852]" onClick={()=>setDetailTab("proposal")}><FileText/>Preparar documentos para la propuesta</Button>}
                <Tabs value={detailTab} onValueChange={setDetailTab}>
                  <TabsList className="h-auto w-full justify-start overflow-x-auto bg-slate-100 p-1">
                    <TabsTrigger value="requirements">Requisitos ({requirements.length})</TabsTrigger>
                    <TabsTrigger value="proposal"><FileText /> Preparar documentos</TabsTrigger>
                    <TabsTrigger value="source">Documentos fuente ({sourceDocuments.length})</TabsTrigger>
                    <TabsTrigger value="management">Gestión</TabsTrigger>
                    <TabsTrigger value="details">Ficha</TabsTrigger>
                  </TabsList>

                  <TabsContent value="requirements" className="mt-4 space-y-3">
                    {requirements.length > 0 && <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-600">Cobertura documental detectada</span><span className="font-semibold">{matchedRequirements} de {requirements.length}</span></div>}
                    {requirements.length === 0 ? <EmptyState title="Requisitos aún no extraídos" description="Los documentos fuente deben descargarse y analizarse antes de mostrar la lista." /> : requirements.map((requirement) => (
                      <div key={requirement.id} className="rounded-xl border p-4">
                        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold leading-5">{requirement.requirement_name}</p><p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{requirement.requirement_category}</p></div><Badge variant={requirement.mandatory ? "default" : "secondary"} className={requirement.mandatory ? "bg-[#0b5963]" : ""}>{requirement.mandatory ? "Obligatorio" : "Opcional"}</Badge></div>
                        {(requirement.condition_text || requirement.requirement_description) && <p className="mt-3 text-sm leading-6 text-slate-600">{requirement.condition_text || requirement.requirement_description}</p>}
                        <div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={requirement.document_match_status || "missing"} />{requirement.organization_document_name && <span className="inline-flex items-center gap-1 text-xs text-slate-600"><CheckCircle2 className="size-3.5 text-emerald-600" /> {requirement.organization_document_name}</span>}</div>
                        {catalog?.entries.filter(e=>e.requirement_ids.includes(requirement.id)).map(e=><div key={e.id} className="mt-3 space-y-2 rounded-lg bg-teal-50 p-3 text-sm"><p>Formato oficial disponible: {e.filename}</p><p className="text-xs">El formato en blanco no acredita el requisito. Debes diligenciarlo{requirement.requires_signature?' y firmarlo':''}.</p><Button size="sm" variant="outline" onClick={()=>setSourceViewer({title:e.filename,beforeEndpoint:e.preview_endpoint})}>Ver formato</Button>{canEdit&&<Button size="sm" className="ml-2" onClick={()=>setDetailTab('proposal')}>Preparar formato</Button>}</div>)}
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">{requirement.source_page && <span>Página {requirement.source_page}</span>}{requirement.document_name && <span>Fuente: {requirement.document_name}</span>}{requirement.maximum_age_days && <span>Antigüedad máxima: {requirement.maximum_age_days} días</span>}</div>
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="proposal" className="mt-4 space-y-5">
                    <ProcessPreparationPanel processId={detail.opportunity.process_id} canRun={canRun} onUpdated={()=>{void refreshDetail(detail.opportunity.process_id);setCatalogRevision(v=>v+1);}}/>
                    <BidLifecycle catalog={catalog} catalogLoading={catalogLoading} onRefreshCatalog={()=>setCatalogRevision(r=>r+1)} key={detail.opportunity.process_id} processId={detail.opportunity.process_id} canEdit={canEdit} sourceDocuments={sourceDocuments} hasAnalysis={detail.has_successful_analysis??detail.analysis?.analysis_status==='success'} onContinued={()=>void refreshDetail(detail.opportunity.process_id)} />
                    <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-semibold">Borrador complementario de propuesta</summary><div className="mt-4"><ProposalWorkspace
                      processId={detail.opportunity.process_id}
                      opportunityName={detail.opportunity.process_name || detail.opportunity.reference || "esta oportunidad"}
                      requirements={requirements.length}
                      matchedRequirements={matchedRequirements}
                      user={user}
                    /></div></details>
                  </TabsContent>

                  <TabsContent value="source" className="mt-4 space-y-3">
                    {sourceDocuments.length === 0 ? <EmptyState title="Sin documentos fuente" description="La fuente pública todavía no ha entregado documentos para esta oportunidad." /> : sourceDocuments.map((document) => (
                      <div key={document.id} className="flex items-center gap-3 rounded-xl border p-4"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><FileText className="size-5" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{document.document_name}</p><p className="mt-1 text-xs text-slate-500">{document.primary_category || "Documento del proceso"} · {document.ai_requirement_count ?? 0} requisitos detectados</p></div><StatusBadge status={document.extraction_status || document.download_status} /><Button variant="outline" size="sm" onClick={()=>setSourceViewer({title:document.document_name,beforeEndpoint:`/opportunities/${detail.opportunity.process_id}/documents/${document.id}/preview`})}>Ver documento</Button>{document.source_download_url && <Button asChild variant="ghost" size="icon-sm"><a href={document.source_download_url} target="_blank" rel="noreferrer" aria-label="Abrir documento fuente"><ExternalLink /></a></Button>}</div>
                    ))}
                  </TabsContent>

                  <TabsContent value="management" className="mt-4 space-y-5">
                    <div className="space-y-2"><Label>Etapa comercial</Label><Select value={draftStage} disabled={!canEdit} onValueChange={(value) => setDraftStage((value ?? "watching") as OpportunityStage)}><SelectTrigger className="w-full"><ClipboardCheck /><SelectValue /></SelectTrigger><SelectContent>{stages.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
                    <div className="space-y-2"><Label htmlFor="opportunity-notes">Notas privadas del equipo</Label><Textarea id="opportunity-notes" value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} disabled={!canEdit} maxLength={4000} rows={6} placeholder="Decisiones, responsables, dudas y próximos pasos…" /><p className="text-right text-xs text-slate-400">{draftNotes.length}/4000</p></div>
                    {canEdit && <div className="flex flex-col gap-2 sm:flex-row"><Button onClick={() => saveState()} disabled={savingState} className="bg-[#0b5963] hover:bg-[#084852]">{savingState && <Loader2 className="animate-spin" />} Guardar seguimiento</Button><Button variant="outline" disabled={savingState} onClick={() => saveState({ is_favorite: !detail.opportunity.is_favorite })}><Heart className={detail.opportunity.is_favorite ? "fill-rose-500 text-rose-500" : ""} /> {detail.opportunity.is_favorite ? "Quitar de guardadas" : "Guardar oportunidad"}</Button></div>}
                  </TabsContent>

                  <TabsContent value="details" className="mt-4 space-y-5">
                    <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Descripción</p><p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{detail.opportunity.description || "No hay una descripción disponible."}</p></div>
                    <Separator />
                    <div className="grid gap-4 sm:grid-cols-2"><DetailRow icon={Building2} label="Entidad" value={detail.opportunity.entity_name || "No informada"} /><DetailRow icon={FileSearch} label="Modalidad" value={detail.opportunity.procurement_method || "No informada"} /><DetailRow icon={Target} label="Tipo de contrato" value={detail.opportunity.contract_type || "No informado"} /><DetailRow icon={CalendarDays} label="Publicación" value={formatDate(detail.opportunity.publication_date)} /></div>
                  </TabsContent>
                </Tabs>

                {detail.opportunity.process_url && <Button asChild variant="outline" className="w-full"><a href={detail.opportunity.process_url} target="_blank" rel="noreferrer">Consultar la fuente oficial <ExternalLink /></a></Button>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <DocumentViewer target={sourceViewer} onClose={()=>setSourceViewer(null)}/>
    </div>
  );
}

function CircleValue({ icon: Icon, label, value }: { icon: typeof Target; label: string; value: string }) {
  return <div><div className="flex items-center gap-1.5 text-xs text-slate-500"><Icon className="size-3.5" /> {label}</div><p className="mt-1.5 truncate text-sm font-semibold">{value}</p></div>;
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof Target; label: string; value: string }) {
  return <div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Icon className="size-4" /></span><div><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div></div>;
}
