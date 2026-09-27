"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2, Download, FileSignature, FileText, Loader2, PenLine, RefreshCw, ShieldCheck,
  Sparkles, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, ProposalPackage, SignatureProfile, User } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatFileSize, StatusBadge } from "./shared";
import { SignatureProfileDialog } from "./signature-profile-dialog";

const PROCESSING_STATES = new Set(["queued", "drafting", "rendering"]);

export function ProposalWorkspace({
  processId,
  opportunityName,
  requirements,
  matchedRequirements,
  user,
}: {
  processId: string;
  opportunityName: string;
  requirements: number;
  matchedRequirements: number;
  user: User;
}) {
  const [signature, setSignature] = useState<SignatureProfile | null>(null);
  const [proposals, setProposals] = useState<ProposalPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [includeSignature, setIncludeSignature] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [generating, setGenerating] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const canEdit = user.role !== "viewer";

  const load = useCallback(async (withLoader = true) => {
    if (withLoader) setLoading(true);
    setError("");
    try {
      const [signatureData, proposalData] = await Promise.all([
        apiFetch<{ signature: SignatureProfile | null }>("/signature-profile"),
        apiFetch<{ items: ProposalPackage[] }>(`/opportunities/${processId}/proposals`),
      ]);
      setSignature(signatureData.signature);
      setProposals(proposalData.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible abrir la preparación de la propuesta.");
    } finally {
      if (withLoader) setLoading(false);
    }
  }, [processId]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const hasProcessingPackage = useMemo(
    () => proposals.some((proposal) => PROCESSING_STATES.has(proposal.status)),
    [proposals],
  );

  useEffect(() => {
    if (!hasProcessingPackage) return;
    const interval = window.setInterval(() => void load(false), 3500);
    return () => window.clearInterval(interval);
  }, [hasProcessingPackage, load]);

  async function generateProposal() {
    if (includeSignature && !signature) {
      setSignatureOpen(true);
      return toast.error("Primero configura la firma que deseas utilizar.");
    }
    if (includeSignature && !confirmation) {
      return toast.error("Confirma que revisarás el paquete antes de presentarlo.");
    }
    setGenerating(true);
    try {
      const data = await apiFetch<{ proposal: ProposalPackage; automation_queued: boolean }>(
        `/opportunities/${processId}/proposals`,
        {
          method: "POST",
          body: JSON.stringify({
            include_electronic_signature: includeSignature,
            confirm_review_and_signature: includeSignature ? confirmation : false,
            instructions: instructions.trim(),
          }),
        },
      );
      setProposals((current) => [data.proposal, ...current.filter((item) => item.id !== data.proposal.id)]);
      toast.success(data.automation_queued ? "El paquete quedó en preparación." : "El paquete está listo para descargar.");
      setInstructions("");
      setConfirmation(false);
      await load(false);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible generar el paquete.");
    } finally {
      setGenerating(false);
    }
  }

  async function revokeSignature() {
    setRevoking(true);
    try {
      await apiFetch<void>("/signature-profile", { method: "DELETE" });
      setSignature(null);
      window.dispatchEvent(new Event('cernoia-signature-updated'));
      setIncludeSignature(false);
      setConfirmation(false);
      setRevokeOpen(false);
      toast.success("La firma quedó retirada y no podrá usarse en paquetes nuevos.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible retirar la firma.");
    } finally {
      setRevoking(false);
    }
  }

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center rounded-2xl border bg-slate-50"><Loader2 className="size-6 animate-spin text-teal-700" /></div>;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>No pudimos abrir este espacio</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span><Button size="sm" variant="outline" onClick={() => load()}><RefreshCw /> Reintentar</Button></AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-0 bg-gradient-to-br from-[#082f38] via-[#0b5963] to-[#117480] text-white shadow-lg">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-white/10 text-[#8de4cf]"><FileSignature className="size-5" /></div>
          <CardTitle className="text-white">Preparar paquete de propuesta</CardTitle>
          <CardDescription className="text-slate-200">
            CernoIA arma un PDF preliminar con carta, matriz de requisitos y trazabilidad para “{opportunityName}”.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Metric label="Requisitos identificados" value={requirements} />
          <Metric label="Con respaldo documental" value={matchedRequirements} />
          <Metric label="Pendientes de revisar" value={Math.max(0, requirements - matchedRequirements)} />
        </CardContent>
      </Card>

      <Alert className="border-amber-200 bg-amber-50/70">
        <TriangleAlert className="text-amber-700" />
        <AlertTitle>Borrador para revisión humana</AlertTitle>
        <AlertDescription>
          El paquete no presenta la oferta ni reemplaza los formatos oficiales, las adendas o la validación jurídica y financiera del proceso.
        </AlertDescription>
      </Alert>

      {canEdit && (
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Opciones del paquete</CardTitle>
            <CardDescription>La firma nunca se aplica de forma automática ni a paquetes futuros.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-col gap-4 rounded-2xl border bg-slate-50 p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-teal-800 shadow-sm"><PenLine className="size-5" /></span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">Firma electrónica simple</p>{signature && <Badge className="bg-emerald-50 text-emerald-700">Configurada</Badge>}</div>
                  <p className="mt-1 truncate text-xs text-slate-500">{signature ? `${signature.signer_name} · ${signature.signer_role || "Firmante autorizado"}` : "Dibuja o carga una imagen de firma privada."}</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2"><Button type="button" variant="outline" onClick={() => setSignatureOpen(true)}>{signature ? "Reemplazar" : "Configurar firma"}</Button>{signature && <Button type="button" variant="ghost" className="text-slate-500" onClick={() => setRevokeOpen(true)}>Retirar</Button>}</div>
            </div>

            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox checked={includeSignature} onCheckedChange={(value) => { setIncludeSignature(value === true); if (value !== true) setConfirmation(false); }} className="mt-0.5" />
              <span><span className="block text-sm font-medium">Aplicar mi firma a este paquete</span><span className="mt-1 block text-xs leading-5 text-slate-500">Solo se habilita para esta solicitud y queda registrada mediante huellas SHA-256 y auditoría.</span></span>
            </label>

            {includeSignature && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
                <Checkbox checked={confirmation} onCheckedChange={(value) => setConfirmation(value === true)} className="mt-0.5" />
                <span className="text-sm leading-6 text-teal-950/80">Confirmo que soy la persona autorizada para usar este perfil de firma y que revisaré todo el paquete antes de presentarlo.</span>
              </label>
            )}

            <div className="space-y-2">
              <Label htmlFor="proposal-instructions">Instrucciones adicionales para el borrador</Label>
              <Textarea id="proposal-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={3000} rows={4} placeholder="Ej. enfatizar el servicio regional, sin agregar información que no esté registrada…" />
              <p className="text-right text-xs text-slate-400">{instructions.length}/3000</p>
            </div>

            <Button type="button" onClick={generateProposal} disabled={generating || hasProcessingPackage} className="w-full bg-[#0b5963] hover:bg-[#084852] sm:w-auto">
              {generating || hasProcessingPackage ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {hasProcessingPackage ? "Preparando paquete…" : "Generar paquete de propuesta"}
            </Button>
          </CardContent>
        </Card>
      )}

      {proposals.length > 0 && (
        <Card className="gap-0 overflow-hidden border-slate-200 py-0 shadow-sm">
          <div className="border-b px-5 py-4"><h3 className="font-semibold">Paquetes generados</h3><p className="mt-1 text-xs text-slate-500">Conserva cada versión para revisión y trazabilidad.</p></div>
          <div className="divide-y">
            {proposals.map((proposal) => (
              <div key={proposal.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><FileText className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-semibold">{proposal.title}</p><StatusBadge status={proposal.status} /></div>
                  <p className="mt-1 text-xs text-slate-500">Creado {formatDate(proposal.created_at, true)}{proposal.file_size_bytes ? ` · ${formatFileSize(proposal.file_size_bytes)}` : ""}{proposal.include_electronic_signature ? " · con firma electrónica" : ""}</p>
                  {proposal.error_message && <p className="mt-2 text-xs text-rose-700">{proposal.error_message}</p>}
                </div>
                {proposal.status === "ready" ? (
                  <Button asChild className="bg-[#0b5963] hover:bg-[#084852]"><a href={proposal.storage_url || `/api/proposals/${proposal.id}/file`}><Download /> Descargar PDF</a></Button>
                ) : PROCESSING_STATES.has(proposal.status) ? (
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-amber-700"><Loader2 className="size-4 animate-spin" /> En preparación</span>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      )}

      {proposals.length === 0 && !canEdit && (
        <div className="rounded-2xl border border-dashed bg-slate-50 p-6 text-center"><ShieldCheck className="mx-auto size-7 text-slate-400" /><p className="mt-3 font-semibold">Todavía no hay paquetes</p><p className="mt-1 text-sm text-slate-500">Una persona con rol de analista o administrador puede prepararlos.</p></div>
      )}

      <SignatureProfileDialog
        open={signatureOpen}
        onOpenChange={setSignatureOpen}
        defaultName={user.full_name}
        onSaved={(next) => { setSignature(next); setIncludeSignature(true); }}
      />

      <AlertDialog open={revokeOpen} onOpenChange={(next) => !revoking && setRevokeOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Retirar tu perfil de firma?</AlertDialogTitle>
            <AlertDialogDescription>La firma dejará de estar disponible para paquetes nuevos. Los PDF ya generados y su trazabilidad no se modifican.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revoking} onClick={(event) => { event.preventDefault(); void revokeSignature(); }}>{revoking && <Loader2 className="animate-spin" />} Retirar firma</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-white/10 bg-white/10 p-4"><p className="text-xs text-slate-200">{label}</p><p className="mt-2 flex items-center gap-2 text-2xl font-semibold"><CheckCircle2 className="size-4 text-[#8de4cf]" /> {value}</p></div>;
}
