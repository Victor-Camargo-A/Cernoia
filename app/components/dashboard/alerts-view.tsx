"use client";
import { opportunityDays } from "@/lib/opportunity-schedule";
import { ProcessDeadline } from "./process-schedule";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BellRing, CalendarClock, Check, ChevronRight, FileWarning, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDigest, apiFetch, MaterializedDocumentAlert, Opportunity, User } from "@/lib/api";
import { daysUntil, formatCurrency, formatDate } from "@/lib/format";
import { DashboardSection, EmptyState, ErrorState, LoadingList, ScoreBadge, StatusBadge } from "./shared";

type LegacyDocumentAlert = {
  id: string;
  document_name: string;
  document_type: string;
  expiry_date: string;
  validity_status: "expiring" | "expired";
};

export function AlertsView({
  navigate,
  user,
}: {
  navigate: (section: DashboardSection) => void;
  user: User;
}) {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [legacyDocuments, setLegacyDocuments] = useState<LegacyDocumentAlert[]>([]);
  const [documentAlerts, setDocumentAlerts] = useState<MaterializedDocumentAlert[]>([]);
  const [digest, setDigest] = useState<AlertDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState("");
  const canManage = user.role !== "viewer";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<{
        opportunities: Opportunity[];
        documents: LegacyDocumentAlert[];
        document_alerts: MaterializedDocumentAlert[];
        digest: AlertDigest | null;
      }>("/alerts");
      setOpportunities(data.opportunities);
      setLegacyDocuments(data.documents);
      setDocumentAlerts(data.document_alerts);
      setDigest(data.digest);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible consultar las alertas.");
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

  const urgent = useMemo(() => {
    const closingSoon = opportunities.filter((item) => {
      const days = opportunityDays(item);
      return days !== null && days <= 3;
    }).length;
    const documentUrgent = documentAlerts.length
      ? documentAlerts.filter((item) => item.severity === "critical").length
      : legacyDocuments.filter((item) => item.validity_status === "expired").length;
    return closingSoon + documentUrgent;
  }, [documentAlerts, legacyDocuments, opportunities]);

  async function updateAlert(alertId: string, action: "read" | "dismiss") {
    setUpdating(`${alertId}:${action}`);
    try {
      await apiFetch(`/alerts/${alertId}/${action}`, { method: "PATCH", body: "{}" });
      setDocumentAlerts((current) => action === "dismiss"
        ? current.filter((item) => item.id !== alertId)
        : current.map((item) => item.id === alertId ? { ...item, status: "read", read_at: item.read_at || new Date().toISOString() } : item));
      toast.success(action === "dismiss" ? "La alerta quedó descartada." : "La alerta quedó marcada como leída.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible actualizar la alerta.");
    } finally {
      setUpdating("");
    }
  }

  if (loading) return <div className="rounded-2xl border bg-white"><LoadingList rows={7} /></div>;
  if (error) return <ErrorState message={error} retry={load} />;

  const hasAnyAlerts = opportunities.length > 0 || documentAlerts.length > 0 || legacyDocuments.length > 0;

  return (
    <div className="space-y-5">
      {digest && (
        <Card className="overflow-hidden border-0 bg-gradient-to-br from-[#082f38] via-[#0b5963] to-[#117480] text-white shadow-lg">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[#8de4cf]"><Sparkles className="size-4" /><span className="text-xs font-semibold uppercase tracking-[0.16em]">Resumen inteligente</span></div>
              <Badge className="border-white/10 bg-white/10 text-white">{formatDate(digest.digest_date)}</Badge>
            </div>
            <CardTitle className="text-xl text-white">{digest.headline}</CardTitle>
            <CardDescription className="max-w-3xl text-sm leading-6 text-slate-200">{digest.summary_text}</CardDescription>
          </CardHeader>
          {Array.isArray(digest.recommended_actions) && digest.recommended_actions.length > 0 && (
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {digest.recommended_actions.slice(0, 4).map((action, index) => (
                <div key={`${action}-${index}`} className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/10 p-3 text-xs leading-5 text-slate-100"><Check className="mt-0.5 size-3.5 shrink-0 text-[#8de4cf]" /> {action}</div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <AlertMetric icon={AlertTriangle} label="Atención inmediata" value={urgent} detail="cierres próximos o alertas críticas" tone="rose" />
        <AlertMetric icon={CalendarClock} label="Cierres en 30 días" value={opportunities.length} detail="oportunidades activas" tone="amber" />
        <AlertMetric icon={FileWarning} label="Alertas documentales" value={documentAlerts.length || legacyDocuments.length} detail="vigencias y revisiones pendientes" tone="cyan" />
      </section>

      {!hasAnyAlerts ? (
        <EmptyState title="Todo está al día" description="No hay cierres próximos ni documentos que requieran atención dentro de las ventanas configuradas." />
      ) : (
        <section className="grid gap-5 xl:grid-cols-2">
          <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
            <CardHeader className="border-b px-5 py-5"><div className="flex items-center gap-2"><TargetIcon /><CardTitle>Fechas de oportunidad</CardTitle></div><CardDescription>Procesos que cierran durante los próximos 30 días.</CardDescription></CardHeader>
            <CardContent className="divide-y p-0">
              {opportunities.length === 0 ? <div className="p-5"><EmptyState title="Sin cierres próximos" description="No hay oportunidades dentro de esta ventana." /></div> : opportunities.map((item) => {
                const days = opportunityDays(item);
                return (
                  <button key={item.id} onClick={() => navigate("opportunities")} className="flex w-full items-start gap-3 px-5 py-4 text-left transition hover:bg-slate-50">
                    <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${days !== null && days <= 3 ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}`}><BellRing className="size-4" /></span>
                    <div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-semibold leading-5">{item.process_name || "Proceso sin nombre"}</p><p className="mt-1 truncate text-xs text-slate-500">{item.entity_name} · {formatCurrency(item.base_price)}</p><div className="mt-2"><ProcessDeadline item={item} /></div></div>
                    <ScoreBadge value={item.match_score} compact />
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
            <CardHeader className="border-b px-5 py-5"><div className="flex items-center gap-2"><FileWarning className="size-4 text-teal-700" /><CardTitle>Gestión documental</CardTitle></div><CardDescription>Vigencias, fechas faltantes y validaciones pendientes.</CardDescription></CardHeader>
            <CardContent className="divide-y p-0">
              {documentAlerts.length > 0 ? documentAlerts.map((alert) => (
                <div key={alert.id} className={`px-5 py-4 ${alert.status === "read" ? "bg-slate-50/60" : ""}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${alert.severity === "critical" ? "bg-rose-50 text-rose-700" : alert.severity === "warning" ? "bg-amber-50 text-amber-700" : "bg-cyan-50 text-cyan-800"}`}>
                      {alert.alert_type === "expired" ? <AlertTriangle className="size-4" /> : <CalendarClock className="size-4" />}
                    </span>
                    <button onClick={() => navigate("documents")} className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">{alert.title}</p><StatusBadge status={alert.alert_type} /></div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{alert.message}</p>
                      {alert.due_date && <p className="mt-2 text-xs font-medium text-slate-600">Fecha: {formatDate(alert.due_date)}</p>}
                    </button>
                  </div>
                  {canManage && (
                    <div className="mt-3 flex justify-end gap-2">
                      {alert.status === "open" && <Button size="sm" variant="ghost" disabled={Boolean(updating)} onClick={() => updateAlert(alert.id, "read")}><Check /> Marcar leída</Button>}
                      <Button size="sm" variant="ghost" className="text-slate-500" disabled={Boolean(updating)} onClick={() => updateAlert(alert.id, "dismiss")}><X /> Descartar</Button>
                    </div>
                  )}
                </div>
              )) : legacyDocuments.length > 0 ? legacyDocuments.map((document) => (
                <button key={document.id} onClick={() => navigate("documents")} className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50">
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${document.validity_status === "expired" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}`}>{document.validity_status === "expired" ? <AlertTriangle className="size-4" /> : <CalendarClock className="size-4" />}</span>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{document.document_name}</p><p className="mt-1 text-xs text-slate-500">Vencimiento: {formatDate(document.expiry_date)}</p></div>
                  <StatusBadge status={document.validity_status} />
                </button>
              )) : <div className="p-5"><EmptyState title="Documentación al día" description="No hay vigencias ni revisiones pendientes." /></div>}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

function TargetIcon() {
  return <span className="flex size-5 items-center justify-center text-teal-700"><ChevronRight className="size-4" /></span>;
}

function AlertMetric({ icon: Icon, label, value, detail, tone }: { icon: typeof BellRing; label: string; value: number; detail: string; tone: "rose" | "amber" | "cyan" }) {
  const tones = { rose: "bg-rose-50 text-rose-700", amber: "bg-amber-50 text-amber-700", cyan: "bg-cyan-50 text-cyan-800" };
  return <Card className="border-slate-200 bg-white py-5 shadow-sm"><CardContent className="flex items-center justify-between gap-4 px-5"><div><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div><span className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${tones[tone]}`}><Icon className="size-5" /></span></CardContent></Card>;
}
