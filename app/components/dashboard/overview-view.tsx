"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, CircleDollarSign, FileCheck2, Gauge, Heart, MapPinned, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { apiFetch, Opportunity } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import { DashboardSection, EmptyState, ErrorState, LoadingGrid, ScoreBadge } from "./shared";

import { ProcessDeadline } from "./process-schedule";

type DashboardData = {
  summary: {
    total_processes: number;
    source_updated_through: string | null;
    total_matches: number;
    new_matches: number;
    open_matches: number;
    average_score: string | number;
    open_value: string | number;
    closing_soon: number;
    favorites: number;
  };
  recent: Opportunity[];
  departments: { department: string; total: number }[];
  documents: { total: number; expired: number; expiring: number };
};

export function OverviewView({ navigate }: { navigate: (section: DashboardSection) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await apiFetch<DashboardData>("/dashboard/summary"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible consultar el panorama.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("cernoia:refresh", refresh);
    return () => window.removeEventListener("cernoia:refresh", refresh);
  }, [load]);

  const maximumDepartment = useMemo(
    () => Math.max(...(data?.departments.map((item) => Number(item.total)) ?? []), 1),
    [data],
  );

  if (loading) return <LoadingGrid />;
  if (error) return <ErrorState message={error} retry={load} />;
  if (!data) return null;

  const cards = [
    { label: "Oportunidades abiertas", value: data.summary.open_matches, detail: `${data.summary.new_matches} nuevas coincidencias`, icon: Target },
    { label: "Valor potencial", value: formatCurrency(data.summary.open_value), detail: "suma de procesos vigentes", icon: CircleDollarSign },
    { label: "Afinidad promedio", value: `${Math.round(Number(data.summary.average_score))}%`, detail: `${data.summary.total_matches} oportunidades`, icon: Gauge },
    { label: "Próximas a cerrar", value: data.summary.closing_soon, detail: "en los próximos 7 días", icon: CalendarClock },
  ];

  return (
    <div className="space-y-6">
      <section className="intelligence-banner overflow-hidden rounded-[1.4rem] border border-[#164957] bg-[#082d38] p-6 text-white shadow-[0_28px_80px_-52px_rgba(3,45,56,.95)] md:p-8">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge className="border-white/10 bg-white/8 text-teal-100">Panorama empresarial</Badge>
              {data.summary.favorites > 0 && <span className="flex items-center gap-1.5 text-xs text-teal-100/70"><Heart className="size-3.5" /> {data.summary.favorites} guardadas</span>}
            </div>
            <h2 className="max-w-xl text-2xl font-semibold leading-tight tracking-[-0.035em] md:text-3xl">Decide dónde competir con una lectura clara del mercado público.</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">Prioriza oportunidades, valida requisitos y mantén la documentación empresarial lista antes del cierre.</p>
          </div>
          <Button onClick={() => navigate("opportunities")} className="w-fit bg-teal-300 text-[#06242d] hover:bg-teal-200">Revisar oportunidades <ArrowRight /></Button>
        </div>
      </section>

      <section className="rounded-2xl border border-teal-200 bg-teal-50 p-5"><p className="text-2xl font-semibold text-teal-950">{Number(data.summary.total_processes).toLocaleString("es-CO")} procesos SECOP II en CernoIA</p><p className="mt-2 text-sm text-teal-900">Incluye procesos vigentes e históricos. {Number(data.summary.total_matches).toLocaleString("es-CO")} tienen coincidencias registradas con tu empresa. Los filtros y el mínimo de afinidad determinan los que ves en Oportunidades.</p><p className="mt-2 text-xs text-slate-600">Datos de la fuente hasta: {formatDate(data.summary.source_updated_through)}</p></section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label} className="metric-card gap-3 border-slate-200/90 bg-white py-5 shadow-sm">
            <CardContent className="px-5">
              <div className="mb-5 flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-600">{card.label}</p>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><card.icon className="size-[1.1rem]" /></span>
              </div>
              <p className="text-[1.75rem] font-semibold tracking-[-0.045em] text-slate-950">{card.value}</p>
              <p className="mt-1.5 text-xs text-slate-500">{card.detail}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_.75fr]">
        <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
          <CardHeader className="flex-row items-start justify-between border-b px-5 py-5 sm:px-6">
            <div><CardTitle>Prioridad reciente</CardTitle><CardDescription className="mt-1">Coincidencias con mayor afinidad para tu empresa.</CardDescription></div>
            <Button variant="ghost" size="sm" onClick={() => navigate("opportunities")}>Ver todas <ArrowRight /></Button>
          </CardHeader>
          <CardContent className="p-0">
            {data.recent.length === 0 ? (
              <div className="p-5"><EmptyState title="Aún no hay oportunidades" description="Ejecuta una actualización desde Automatización cuando los perfiles estén configurados." /></div>
            ) : (
              <div className="divide-y">
                {data.recent.map((item) => {
                  return (
                    <button key={item.id} onClick={() => navigate("opportunities")} className="group grid w-full gap-3 px-5 py-4 text-left transition hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-teal-800">{item.process_name || "Proceso sin nombre"}</p>
                        <p className="mt-1 truncate text-xs text-slate-500">{item.entity_name || "Entidad no informada"} · {item.reference || item.secop_process_id}</p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          <span>{formatCurrency(item.base_price)}</span>
                          <ProcessDeadline item={item} />
                        </div>
                      </div>
                      <ScoreBadge value={item.match_score} compact />
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <Card className="border-slate-200 bg-white shadow-sm">
            <CardHeader><div className="flex items-center gap-2"><MapPinned className="size-4 text-teal-700" /><CardTitle>Lectura territorial</CardTitle></div><CardDescription>Departamentos con más oportunidades.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {data.departments.slice(0, 5).map((item) => (
                <div key={item.department} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-xs"><span className="truncate text-slate-600">{item.department}</span><span className="font-semibold tabular-nums">{item.total}</span></div>
                  <Progress value={(Number(item.total) / maximumDepartment) * 100} className="h-1.5 bg-slate-100 [&_[data-slot=progress-indicator]]:bg-teal-600" />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <CardContent className="flex items-center gap-4 p-5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><FileCheck2 className="size-5" /></span>
              <div className="min-w-0 flex-1"><p className="text-sm font-semibold">Salud documental</p><p className="mt-1 text-xs leading-5 text-slate-500">{data.documents.total} documentos · {data.documents.expiring} por vencer · {data.documents.expired} vencidos</p></div>
              <Button variant="outline" size="icon-sm" onClick={() => navigate("documents")} aria-label="Abrir documentos"><ArrowRight /></Button>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
