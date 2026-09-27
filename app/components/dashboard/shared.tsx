import { AlertCircle, FileSearch, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { OpportunityStage, UserRole } from "@/lib/api";
import { cn } from "@/lib/utils";

export type DashboardSection = "matrix" | "owner-users" | "youtube" | "campaigns" | "overview" | "opportunities" | "market" | "chat" | "documents" | "templates" | "alerts" | "billing" | "operations" | "automation" | "settings";

export const roleLabels: Record<UserRole, string> = {
  owner: "Propietario",
  admin: "Administrador",
  analyst: "Analista",
  viewer: "Consulta",
};

export const stageLabels: Record<OpportunityStage, string> = {
  watching: "Por revisar",
  reviewing: "En evaluación",
  preparing: "Preparando oferta",
  submitted: "Oferta presentada",
  dismissed: "Descartada",
};

export function statusLabel(status: string | null | undefined) {
  const labels: Record<string, string> = {
    active: "Activo",
    invited: "Invitado",
    suspended: "Suspendido",
    valid: "Vigente",
    expiring: "Por vencer",
    expired: "Vencido",
    unknown: "Sin vigencia",
    uploaded: "Cargado",
    extracted: "Datos extraídos",
    metadata_processing: "IA identificando datos",
    pending: "Pendiente",
    processing: "Procesando",
    queued: "En cola",
    drafting: "Preparando contenido",
    rendering: "Generando archivo",
    ready: "Listo para descargar",
    needs_review: "Requiere revisión",
  review_required: "Requiere revisión",
  legal_entity: "Persona jurídica",
  natural_person: "Persona natural",
  consortium: "Consorcio",
  temporary_union: "Unión temporal",
  nonprofit: "Entidad sin ánimo de lucro",
  unconfirmed: "Sin confirmar",
    dismissed: "Descartada",
    fallback: "Resumen básico",
    read: "Leída",
    open: "Abierta",
    running: "Procesando",
    completed: "Completado",
    complete: "Completado",
    success: "Completado",
    failed: "Con error",
    error: "Con error",
    verified: "Verificado",
    not_requested: "Pendiente",
    matched: "Cubierto",
    partial: "Cobertura parcial",
    missing: "Falta documento",
    new: "Nueva",
    viewed: "Vista",
  };
  const normalized = String(status ?? "").toLowerCase();
  return labels[normalized] ?? (status || "Sin estado");
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const normalized = String(status ?? "").toLowerCase();
  const style = normalized.includes("fail") || normalized.includes("error") || normalized === "expired" || normalized === "missing"
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : normalized.includes("run") || normalized.includes("process") || normalized === "expiring" || normalized === "partial"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : normalized.includes("success") || normalized.includes("complete") || ["valid", "active", "verified", "matched"].includes(normalized)
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-slate-200 bg-slate-50 text-slate-600";
  return <Badge variant="outline" className={cn("font-medium", style, className)}>{statusLabel(status)}</Badge>;
}

export function ScoreBadge({ value, compact = false }: { value: string | number; compact?: boolean }) {
  const score = Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
  const style = score >= 80
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : score >= 60
      ? "border-cyan-200 bg-cyan-50 text-cyan-800"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border font-semibold tabular-nums", style, compact ? "min-w-11 px-2 py-1 text-xs" : "min-w-14 px-2.5 py-1.5 text-sm")}>
      {score}%
    </span>
  );
}

export function LoadingGrid({ rows = 6 }: { rows?: number }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: rows }).map((_, index) => <Skeleton key={index} className="h-36 rounded-2xl" />)}</div>;
}

export function LoadingList({ rows = 6 }: { rows?: number }) {
  return <div className="space-y-3 p-5">{Array.from({ length: rows }).map((_, index) => <Skeleton key={index} className="h-16 rounded-xl" />)}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert variant="destructive" className="max-w-2xl bg-white">
      <AlertCircle />
      <AlertTitle>No pudimos cargar esta información</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={retry}><RefreshCw /> Reintentar</Button>
      </AlertDescription>
    </Alert>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <Empty className="min-h-64 border border-dashed bg-white/60">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileSearch /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {action}
      </EmptyHeader>
    </Empty>
  );
}

export function formatFileSize(value: string | number | null | undefined) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Tamaño no informado";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
