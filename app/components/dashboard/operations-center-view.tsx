"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, BellRing, Bot, CreditCard, Database, HardDrive, Loader2, RefreshCw, RotateCcw, ServerCog, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, OperationsSummary } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { StatusBadge } from "./shared";

export function OperationsCenterView() {
  const [data, setData] = useState<OperationsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch<OperationsSummary>("/operations/summary")); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible consultar la operación."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  async function retry(id: string) {
    setRetrying(id);
    try { await apiFetch(`/operations/dead-letters/${id}/retry`, { method: "POST", body: "{}" }); toast.success("La incidencia quedó en cola para reintento."); await load(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible reintentar."); }
    finally { setRetrying(""); }
  }
  if (loading && !data) return <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-40 rounded-2xl" />)}</div>;
  const serviceCards = [
    ["Base de datos", data?.services.database, Database],
    ["Redis / cuota IA", data?.services.redis, ServerCog],
    ["Motor de inteligencia", data?.services.n8n, Bot],
    ["Archivos privados", data?.services.storage, HardDrive],
    ["Antivirus", data?.services.antivirus, ShieldCheck],
    ["Pasarela Bold", data?.services.bold, CreditCard],
  ] as const;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Salud operativa</h2><p className="mt-1 text-sm text-slate-500">Servicios, cuota de IA, entregas y trabajos que requieren intervención.</p></div><Button variant="outline" onClick={load} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Verificar ahora</Button></div>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{serviceCards.map(([label, service, Icon]) => <Card key={label} className="border-slate-200 bg-white shadow-sm"><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><Icon className="size-5" /></span><StatusBadge status={service?.status ?? "unknown"} /></div><p className="mt-4 font-semibold">{label}</p><p className="mt-1 text-xs text-slate-500">Estado comprobado {formatDate(data?.checked_at ?? null, true)}</p></CardContent></Card>)}</section>
    <div className="grid gap-5 xl:grid-cols-3"><MetricCard title="Ejecuciones (24 h)" icon={Activity} rows={data?.workflows ?? []} /><MetricCard title="Cuota Gemini (24 h)" icon={Bot} rows={data?.quota.map((item) => ({ status: item.outcome, total: item.total })) ?? []} /><MetricCard title="Notificaciones (7 días)" icon={BellRing} rows={data?.notifications ?? []} /></div>
    <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><h3 className="font-semibold">Bandeja de incidencias</h3><p className="mt-1 text-xs text-slate-500">Trabajos agotados después de sus reintentos automáticos.</p></div>{data?.dead_letters.length ? <div className="divide-y">{data.dead_letters.map((job) => <div key={job.id} className="flex flex-wrap items-center gap-4 p-4"><span className="flex size-9 items-center justify-center rounded-xl bg-rose-50 text-rose-700"><ServerCog className="size-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{job.job_type}</p><p className="mt-1 line-clamp-2 text-xs text-slate-500">{job.last_error}</p></div><div className="text-right text-xs text-slate-500"><p>{job.attempt_count} intentos</p><p>{formatDate(job.created_at, true)}</p></div><Button variant="outline" size="sm" onClick={() => void retry(job.id)} disabled={retrying === job.id}>{retrying === job.id ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reintentar</Button></div>)}</div> : <div className="p-10 text-center"><Activity className="mx-auto size-9 text-emerald-500" /><p className="mt-3 font-semibold">No hay trabajos bloqueados</p><p className="mt-1 text-sm text-slate-500">Los reintentos y la cola están al día.</p></div>}</Card>
  </div>;
}

function MetricCard({ title, icon: Icon, rows }: { title: string; icon: typeof Activity; rows: Array<{ status: string; total: number }> }) {
  const total = rows.reduce((sum, item) => sum + Number(item.total), 0);
  return <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="flex items-center gap-2"><Icon className="size-4 text-teal-700" /><CardTitle>{title}</CardTitle></div><CardDescription>{total.toLocaleString("es-CO")} eventos registrados</CardDescription></CardHeader><CardContent className="space-y-2">{rows.length ? rows.map((item) => <div key={item.status} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><StatusBadge status={item.status} /><span className="font-semibold tabular-nums">{Number(item.total).toLocaleString("es-CO")}</span></div>) : <p className="text-sm text-slate-500">Sin eventos en el periodo.</p>}</CardContent></Card>;
}
