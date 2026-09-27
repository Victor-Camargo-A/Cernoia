"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, CheckCircle2, Clock3, DatabaseZap, FileSearch, Loader2, Play, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, WorkflowReadiness, WorkflowRun } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { EmptyState, ErrorState, LoadingList, StatusBadge } from "./shared";

const operationNames: Record<string, string> = {
  "WF-019": "Actualización integral del mercado",
  "WF-005": "Priorización de oportunidades",
  "WF-011": "Validación documental empresarial",
  "WF-014": "Lectura de documentos de oportunidad",
  "WF-015": "Extracción de requisitos",
};

export function AutomationView({ online, setOnline }: { online: boolean | null; setOnline: (value: boolean) => void }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [readiness, setReadiness] = useState<WorkflowReadiness | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [history, pipeline] = await Promise.all([
        apiFetch<{ items: WorkflowRun[] }>("/workflow-runs"),
        apiFetch<WorkflowReadiness>("/workflows/readiness"),
      ]);
      setRuns(history.items);
      setReadiness(pipeline);
      setOnline(pipeline.online);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible consultar las automatizaciones.");
    } finally {
      setLoading(false);
    }
  }, [setOnline]);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("cernoia:refresh", refresh);
    return () => window.removeEventListener("cernoia:refresh", refresh);
  }, [load]);

  async function runMarketUpdate() {
    setRunning(true);
    try {
      await apiFetch("/workflows/WF-019/run", { method: "POST", body: JSON.stringify({ processing_mode: "all" }) });
      toast.success("La actualización fue aceptada por el motor de inteligencia.");
      window.setTimeout(() => void load(), 1500);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible iniciar la actualización.");
    } finally {
      setRunning(false);
    }
  }

  const pipelineReady = readiness?.pipeline_ready ?? false;
  const baseConnectionReady = readiness?.base_connection_ready ?? online === true;
  const activeStages = readiness?.stages.filter((stage) => stage.status === "active").length ?? 0;

  return (
    <div className="space-y-5">
      <Alert className={pipelineReady ? "border-emerald-200 bg-emerald-50 text-emerald-950" : baseConnectionReady ? "border-amber-200 bg-amber-50 text-amber-950" : "border-rose-200 bg-rose-50 text-rose-950"}>
        {pipelineReady ? <CheckCircle2 /> : <ShieldAlert />}
        <AlertTitle>{pipelineReady ? "Pipeline completo y listo" : baseConnectionReady ? "El motor responde, pero la verificación está incompleta" : "El pipeline requiere configuración"}</AlertTitle>
        <AlertDescription>{pipelineReady ? "Las 12 etapas están publicadas, la base de datos está preparada y los servicios seguros responden." : readiness?.configuration_problems.map((problem) => problem.replace(/n8n/gi, "el motor de automatización").replace(/N8N_API_KEY/gi, "la configuración del sistema")).join(" · ") || "Verifica la configuración del motor y el certificado HTTPS antes de iniciar procesos."}</AlertDescription>
      </Alert>

      <section className="grid gap-5 xl:grid-cols-[1fr_1.15fr]">
        <Card className="automation-card overflow-hidden border-[#174b57] bg-[#082d38] text-white shadow-lg shadow-teal-950/10">
          <CardHeader className="relative z-10"><Badge className="mb-3 w-fit border-white/10 bg-white/10 text-teal-100"><Sparkles /> Operación principal</Badge><CardTitle className="max-w-md text-2xl leading-tight text-white">Actualizar la inteligencia de oportunidades</CardTitle><CardDescription className="max-w-lg leading-6 text-slate-300">Busca novedades, aplica los perfiles empresariales y activa el análisis documental de los procesos relevantes.</CardDescription></CardHeader>
          <CardContent className="relative z-10"><Button onClick={runMarketUpdate} disabled={!pipelineReady || running} className="bg-teal-300 text-[#06242d] hover:bg-teal-200">{running ? <Loader2 className="animate-spin" /> : <Play />} {running ? "Enviando…" : "Iniciar actualización"}</Button><p className="mt-3 text-xs text-slate-400">{pipelineReady ? "Puedes continuar usando la aplicación mientras el proceso trabaja en segundo plano." : "El botón se habilitará cuando todas las etapas y servicios estén verificados."}</p></CardContent>
        </Card>

        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader><CardTitle>Qué ocurre durante la actualización</CardTitle><CardDescription>Un único inicio coordina el flujo completo y conserva la trazabilidad.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              { icon: DatabaseZap, step: "01", title: "Detecta novedades", description: "Sincroniza procesos nuevos o modificados." },
              { icon: FileSearch, step: "02", title: "Evalúa afinidad", description: "Contrasta oportunidades con tus perfiles." },
              { icon: Bot, step: "03", title: "Comprende documentos", description: "Extrae contenido y requisitos relevantes." },
              { icon: Clock3, step: "04", title: "Actualiza alertas", description: "Prioriza cierres y vigencias próximas." },
            ].map((item) => <div key={item.step} className="rounded-xl border bg-slate-50 p-4"><div className="mb-3 flex items-center justify-between"><span className="flex size-9 items-center justify-center rounded-xl bg-white text-teal-700 shadow-sm"><item.icon className="size-4" /></span><span className="text-xs font-semibold text-slate-400">{item.step}</span></div><p className="text-sm font-semibold">{item.title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{item.description}</p></div>)}
          </CardContent>
        </Card>
      </section>

      {readiness && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><CardTitle>Estado de las 12 etapas</CardTitle><CardDescription>{readiness.inventory_verified ? `${activeStages} de 12 etapas operativas.` : "La verificación automática del sistema aún no está disponible."}</CardDescription></div>
              <Badge className={pipelineReady ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>{pipelineReady ? "Listo" : readiness.inventory_verified ? `${activeStages}/12 activas` : "Sin verificar"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 pt-5 sm:grid-cols-2 xl:grid-cols-3">
            {readiness.stages.map((stage, index) => (
              <div key={stage.code} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${stage.status === "active" ? "bg-emerald-100 text-emerald-800" : stage.status === "unverified" ? "bg-slate-200 text-slate-600" : "bg-rose-100 text-rose-700"}`}>{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{stage.name}</p><p className="mt-0.5 text-xs text-slate-500">{stage.code}</p></div>
                <span className={`size-2.5 rounded-full ${stage.status === "active" ? "bg-emerald-500" : stage.status === "unverified" ? "bg-slate-400" : "bg-rose-500"}`} aria-label={stage.status} />
              </div>
            ))}
          </CardContent>
          {!readiness.database_ready && <div className="border-t bg-rose-50 px-5 py-3 text-xs text-rose-800">Faltan objetos de base de datos: {readiness.missing_database_objects.join(", ")}</div>}
          {readiness.inventory_verified && readiness.support_workflows.some((workflow) => workflow.status !== "active") && <div className="border-t bg-amber-50 px-5 py-3 text-xs text-amber-900">También deben publicarse: {readiness.support_workflows.filter((workflow) => workflow.status !== "active").map((workflow) => `${workflow.code} ${workflow.name}`).join(", ")}.</div>}
        </Card>
      )}

      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4"><div><h2 className="font-semibold">Historial operativo</h2><p className="mt-0.5 text-xs text-slate-500">Ejecuciones asociadas exclusivamente a tu organización.</p></div><Button variant="outline" size="sm" onClick={load}><RefreshCw /> Actualizar</Button></div>
        {loading ? <LoadingList /> : error ? <div className="p-5"><ErrorState message={error} retry={load} /></div> : runs.length === 0 ? <div className="p-5"><EmptyState title="Sin ejecuciones registradas" description="El historial aparecerá cuando la orquestación reporte su organización en la trazabilidad." /></div> : (
          <>
            <div className="hidden md:block"><Table><TableHeader><TableRow><TableHead className="pl-5">Operación</TableHead><TableHead>Inicio</TableHead><TableHead>Duración</TableHead><TableHead>Registros</TableHead><TableHead className="pr-5">Estado</TableHead></TableRow></TableHeader><TableBody>{runs.map((run) => { const duration = run.started_at && run.finished_at ? Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)) : null; return <TableRow key={run.id}><TableCell className="pl-5"><p className="font-medium">{operationNames[run.workflow_code] || "Proceso automatizado"}</p><p className="mt-1 text-xs text-slate-500">Ejecución {run.n8n_execution_id || "interna"}</p></TableCell><TableCell>{formatDate(run.started_at, true)}</TableCell><TableCell>{duration === null ? "En curso" : `${duration}s`}</TableCell><TableCell>{Number(run.records_written ?? run.records_read ?? 0).toLocaleString("es-CO")}</TableCell><TableCell className="pr-5"><StatusBadge status={run.status} /></TableCell></TableRow>; })}</TableBody></Table></div>
            <div className="divide-y md:hidden">{runs.map((run) => <div key={run.id} className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{operationNames[run.workflow_code] || "Proceso automatizado"}</p><p className="mt-1 text-xs text-slate-500">{formatDate(run.started_at, true)}</p></div><StatusBadge status={run.status} /></div><p className="mt-3 text-xs text-slate-500">{Number(run.records_written ?? run.records_read ?? 0).toLocaleString("es-CO")} registros procesados</p></div>)}</div>
          </>
        )}
      </Card>
    </div>
  );
}
