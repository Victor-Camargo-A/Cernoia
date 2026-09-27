"use client";

import { FormEvent, useState } from "react";
import { CheckCircle2, Loader2, Save, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Account, apiFetch } from "@/lib/api";

export function RepresentativeEditor({ account, canManage, onRefresh }: { account: Account; canManage: boolean; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState(account.organization.representative_name ?? "");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try { await apiFetch("/account/organization", { method: "PATCH", body: JSON.stringify({ name: account.organization.name, legal_name: account.organization.legal_name, tax_id: account.organization.tax_id, city: account.organization.city, department: account.organization.department, website: account.organization.website, organization_type: account.organization.organization_type, representative_name: name }) }); toast.success("El representante legal quedó guardado."); await onRefresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar el representante legal."); }
    finally { setSaving(false); }
  }
  return <Card className="border-amber-200 bg-amber-50/50 shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-white text-amber-800"><UserRound className="size-5" /></div><CardTitle>Representante legal</CardTitle><CardDescription>Confirma el nombre exactamente como aparece en Cámara de Comercio. CernoIA solo lo usará para diligenciar campos con evidencia.</CardDescription></CardHeader><CardContent><form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end"><div className="flex-1 space-y-2"><Label htmlFor="representative-name">Nombre completo</Label><Input id="representative-name" value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage} placeholder="Nombre del representante legal" required /></div>{canManage && <Button type="submit" disabled={saving || !name.trim()} className="bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar</Button>}{name.trim() && <CheckCircle2 className="hidden size-5 text-emerald-600 sm:block" />}</form></CardContent></Card>;
}
