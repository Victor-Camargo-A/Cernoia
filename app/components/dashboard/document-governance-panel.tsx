"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, FileSearch, Loader2, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DOCUMENT_TYPES } from "@/lib/document-types";
import { formatDate } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "./shared";

type Review = {
  document_type_label?: string | null; metadata_status?: string | null; expiration_source?: string | null;
  id: string; organization_document_id: string; status: string; proposed_values: Record<string, string | null>;
  confidence: string | number | null; evidence: { method?: string; character_count?: number; issues?: string[]; issue_quote?: string; expiration_quote?: string; validity_quote?: string; notes?: string }; document_name: string;
  document_type: string; issue_date: string | null; expiration_date: string | null; ocr_status: string;
};
type Policy = { id: string; document_type: string; policy_name: string; validity_days: number | null; alert_schedule_days: number[]; require_human_review: boolean; organization_id: string | null };

const organizationTypes = [
  ["legal_entity", "Persona jurídica"], ["natural_person", "Persona natural"], ["consortium", "Consorcio"],
  ["temporary_union", "Unión temporal"], ["nonprofit", "Entidad sin ánimo de lucro"], ["other", "Otro"],
] as const;

export function DocumentGovernancePanel({ canEdit, canManage, onUpdated }: { canEdit: boolean; canManage: boolean; onUpdated: () => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [documentType, setDocumentType] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [organizationType, setOrganizationType] = useState("");
  const [validityDays, setValidityDays] = useState("");
  const [schedule, setSchedule] = useState("30, 15, 5, 2, 1");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [reviewData, policyData] = await Promise.all([
        apiFetch<{ items: Review[] }>("/documents/reviews"),
        apiFetch<{ items: Policy[] }>("/document-policies"),
      ]);
      setReviews(reviewData.items); setPolicies(policyData.items);
    } catch { /* El repositorio principal conserva su propio estado de error. */ }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); const timer = window.setInterval(() => void load(), 10000); return () => window.clearInterval(timer); }, [load]);

  function openReview(item: Review) {
    setReview(item);
    setDocumentType(item.document_type || item.proposed_values?.document_type || "other_document");
    setIssueDate((item.issue_date || item.proposed_values?.issue_date || "").slice(0,10));
    setExpirationDate((item.expiration_date || item.proposed_values?.expiration_date || "").slice(0,10));
    setOrganizationType(item.proposed_values?.organization_type || "");
  }
  async function saveReview(event: FormEvent) {
    event.preventDefault(); if (!review) return; setSaving(true);
    try {
      await apiFetch(`/documents/${review.organization_document_id}/review`, { method: "PATCH", body: JSON.stringify({ status: "corrected", document_type: documentType, issue_date: issueDate, expiration_date: expirationDate, organization_type: organizationType }) });
      toast.success("Datos confirmados y vigencia actualizada."); setReview(null); await load(); onUpdated();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible confirmar los datos."); }
    finally { setSaving(false); }
  }
  function openPolicy(item: Policy) {
    setPolicy(item); setValidityDays(item.validity_days == null ? "" : String(item.validity_days)); setSchedule((item.alert_schedule_days || [30, 15, 5, 2, 1]).join(", "));
  }
  async function savePolicy(event: FormEvent) {
    event.preventDefault(); if (!policy) return; setSaving(true);
    try {
      await apiFetch(`/document-policies/${policy.document_type}`, { method: "PUT", body: JSON.stringify({ policy_name: policy.policy_name, validity_days: validityDays ? Number(validityDays) : null, alert_schedule_days: schedule.split(",").map((item) => Number(item.trim())), require_human_review: true, apply_existing: true }) });
      toast.success("Política de vigencia y alertas actualizada."); setPolicy(null); await load(); onUpdated();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar la política."); }
    finally { setSaving(false); }
  }

  const pending = reviews.filter((item) => item.status === "pending" || ["queued","processing","retry"].includes(item.metadata_status || ""));
  return <><Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><Tabs defaultValue="reviews"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:px-5"><div><h2 className="font-semibold">Control documental</h2><p className="mt-0.5 text-xs text-slate-500">Datos por completar, vigencias y calendario de avisos.</p></div><TabsList><TabsTrigger value="reviews"><FileSearch /> Revisiones {pending.length > 0 && <Badge className="ml-1 bg-amber-100 text-amber-800">{pending.length}</Badge>}</TabsTrigger><TabsTrigger value="policies"><CalendarClock /> Políticas</TabsTrigger></TabsList></div><TabsContent value="reviews" className="m-0"><div className="divide-y">{pending.length ? pending.slice(0, 8).map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 p-4 sm:px-5"><span className="flex size-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><FileSearch className="size-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{item.document_name}</p><p className="mt-1 text-xs text-slate-500">{item.document_type_label || DOCUMENT_TYPES.find(([code])=>code===item.document_type)?.[1] || item.proposed_values?.document_type_label || "Identificando tipo documental"} · Expedición: {formatDate(item.issue_date)}</p></div><StatusBadge status={["queued","processing","retry"].includes(item.metadata_status || "")?"metadata_processing":"review_required"} />{canEdit && !["queued","processing","retry"].includes(item.metadata_status || "") && <Button size="sm" onClick={() => openReview(item)}><CheckCircle2 /> Revisar</Button>}</div>) : <div className="p-8 text-center"><ShieldCheck className="mx-auto size-8 text-emerald-600" /><p className="mt-3 text-sm font-semibold">No hay extracciones pendientes</p><p className="mt-1 text-xs text-slate-500">Los datos confirmados pueden alimentar alertas y plantillas.</p></div>}</div></TabsContent><TabsContent value="policies" className="m-0"><div className="divide-y">{policies.map((item) => <div key={item.document_type} className="flex flex-wrap items-center gap-3 p-4 sm:px-5"><span className="flex size-9 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><CalendarClock className="size-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{item.policy_name}</p><p className="mt-1 text-xs text-slate-500">{item.validity_days ? `${item.validity_days} días de vigencia` : "Vigencia definida en el documento"} · avisos {item.alert_schedule_days?.join(", ")} días antes</p></div>{item.organization_id && <Badge variant="outline">Personalizada</Badge>}{canManage && <Button variant="outline" size="sm" onClick={() => openPolicy(item)}><Settings2 /> Editar</Button>}</div>)}</div></TabsContent></Tabs></Card>

  <Dialog open={Boolean(review)} onOpenChange={(open) => !open && !saving && setReview(null)}><DialogContent><DialogHeader><DialogTitle>Confirmar datos extraídos</DialogTitle><DialogDescription>Completa o corrige los datos que no pudieron identificarse con claridad.</DialogDescription></DialogHeader><form onSubmit={saveReview} className="space-y-4"><div className="space-y-2"><Label htmlFor="review-type">Tipo documental</Label><Select value={documentType} onValueChange={value=>{if(value)setDocumentType(value);}}><SelectTrigger id="review-type" className="w-full"><SelectValue/></SelectTrigger><SelectContent>{!DOCUMENT_TYPES.some(([code])=>code===documentType)&&<SelectItem value={documentType}>{review?.document_type_label || review?.proposed_values?.document_type_label || documentType}</SelectItem>}{DOCUMENT_TYPES.map(([code,label])=><SelectItem key={code} value={code}>{label}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="review-issue">Expedición</Label><Input id="review-issue" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="review-expiry">Vencimiento</Label><Input id="review-expiry" type="date" value={expirationDate} onChange={(event) => setExpirationDate(event.target.value)} /></div></div><div className="space-y-2"><Label>Tipo de empresa sugerido</Label><Select value={organizationType || "none"} onValueChange={(value) => setOrganizationType(value === "none" || !value ? "" : value)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No cambiar</SelectItem>{organizationTypes.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>{review?.evidence?.issues?.length ? <p className="text-sm text-amber-800">{review.evidence.issues.join(" ")}</p> : null}{review?.expiration_source === "policy" && <p className="text-xs text-slate-500">El vencimiento se calculó desde la expedición según la política configurada.</p>}{review?.evidence?.issue_quote && <p className="text-xs text-slate-500">Expedición en el documento: “{review.evidence.issue_quote}”</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setReview(null)}>Cancelar</Button><Button disabled={saving}>{saving && <Loader2 className="animate-spin" />} Confirmar datos</Button></DialogFooter></form></DialogContent></Dialog>
  <Dialog open={Boolean(policy)} onOpenChange={(open) => !open && !saving && setPolicy(null)}><DialogContent><DialogHeader><DialogTitle>Política de {policy?.policy_name}</DialogTitle><DialogDescription>Se aplicará a documentos existentes y nuevas cargas de este tipo.</DialogDescription></DialogHeader><form onSubmit={savePolicy} className="space-y-4"><div className="space-y-2"><Label htmlFor="validity-days">Días de vigencia</Label><Input id="validity-days" type="number" min={1} max={3650} value={validityDays} onChange={(event) => setValidityDays(event.target.value)} placeholder="Dejar vacío si el documento trae su fecha" /></div><div className="space-y-2"><Label htmlFor="alert-days">Avisar días antes</Label><Input id="alert-days" value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="30, 15, 5, 2, 1" /><p className="text-xs text-slate-500">Separa cada momento con comas.</p></div><DialogFooter><Button type="button" variant="outline" onClick={() => setPolicy(null)}>Cancelar</Button><Button disabled={saving}>{saving && <Loader2 className="animate-spin" />} Guardar política</Button></DialogFooter></form></DialogContent></Dialog></>;
}
