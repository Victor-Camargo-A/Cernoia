"use client";

import {CampaignsOwner} from "./campaigns-owner";
import {OwnerUsers} from "./owner-users";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Building2, CheckCircle2, ChevronRight, Clock3, LogOut, Plus, RefreshCw, ShieldCheck, Users, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { BrandLockup } from "@/app/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, PlatformAdmin, PlatformOrganization, PlatformOverview } from "@/lib/api";
import { formatDate } from "@/lib/format";

export function PlatformShell(props: { admin: PlatformAdmin; onLogout: () => void }) {
  const [users, setUsers] = useState(false);
  return <><nav aria-label="Administración" className="flex flex-wrap gap-2 bg-[#f4f7f6] p-4"><Button variant={users?"outline":"default"} onClick={()=>setUsers(false)}>Organizaciones y operación</Button><Button variant={users?"default":"outline"} onClick={()=>setUsers(true)}>Usuarios y suscripciones</Button></nav>{users?<main className="mx-auto max-w-[1580px] p-4"><OwnerUsers endpoint="/platform/users" /></main>:<PlatformOverviewShell {...props}/>}</>;
}

function PlatformOverviewShell({ admin, onLogout }: { admin: PlatformAdmin; onLogout: () => void }) {
  const [section,setSection]=useState("overview");
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [organizations, setOrganizations] = useState<PlatformOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewData, organizationData] = await Promise.all([
        apiFetch<PlatformOverview>("/platform/overview"),
        apiFetch<{ items: PlatformOrganization[] }>("/platform/organizations"),
      ]);
      setOverview(overviewData);
      setOrganizations(organizationData.items);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible cargar la consola.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function createOrganization(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const data = await apiFetch<{ organization: PlatformOrganization; invitation: { invite_url: string } }>("/platform/organizations", {
        method: "POST",
        body: JSON.stringify({ name, slug, owner_name: ownerName, owner_email: ownerEmail }),
      });
      setDialogOpen(false);
      setName(""); setSlug(""); setOwnerName(""); setOwnerEmail("");
      await load();
      toast.success("Organización creada. La invitación del propietario quedó en la cola de notificaciones.");
      if (data.invitation?.invite_url) await navigator.clipboard?.writeText(data.invitation.invite_url).catch(() => undefined);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible crear la organización.");
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(organization: PlatformOrganization) {
    const nextStatus = organization.status === "active" ? "suspended" : "active";
    try {
      await apiFetch(`/platform/organizations/${organization.id}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
      await load();
      toast.success(nextStatus === "active" ? "Organización activada." : "Organización suspendida.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible actualizar el estado.");
    }
  }

  async function logout() {
    setLoggingOut(true);
    try { await apiFetch<void>("/platform/logout", { method: "POST" }); } catch { /* El estado local también se cierra. */ }
    onLogout();
  }

  return <div className="min-h-svh bg-[#f4f7f6] text-slate-950"><header className="sticky top-0 z-20 border-b border-[#123944]/10 bg-[#061f28] text-white"><div className="mx-auto flex min-h-16 max-w-[1580px] items-center justify-between gap-4 px-4 md:px-7"><BrandLockup className="text-white [&_.brand-mark]:text-teal-300 [&_p:last-child]:text-teal-100" /><div className="flex items-center gap-3"><div className="hidden text-right sm:block"><p className="text-sm font-semibold">{admin.full_name}</p><p className="text-xs text-slate-400">Administrador global · {admin.email}</p></div><Button variant="ghost" size="icon" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={logout} disabled={loggingOut} aria-label="Cerrar sesión"><LogOut /></Button></div></div></header><main className="mx-auto max-w-[1580px] space-y-6 p-4 md:p-7">{admin.campaigns_owner&&<nav className="flex gap-2"><Button variant={section==="overview"?"default":"outline"} onClick={()=>setSection("overview")}>Organizaciones</Button><Button variant={section==="campaigns"?"default":"outline"} onClick={()=>setSection("campaigns")}>Campañas comerciales</Button></nav>}{section==="campaigns"&&admin.campaigns_owner?<CampaignsOwner/>:<><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Consola de plataforma</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Salud y organizaciones</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Supervisa la operación sin entrar en el contenido privado de las empresas.</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} /> Actualizar</Button><Button onClick={() => setDialogOpen(true)} className="bg-[#0b5963] hover:bg-[#084852]"><Plus /> Nueva organización</Button></div></div>{loading && !overview ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" /></div> : overview && <><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><MetricCard icon={Building2} label="Organizaciones" value={overview.organizations.total} detail={`${overview.organizations.active} activas · ${overview.organizations.suspended} suspendidas`} tone="teal" /><MetricCard icon={Users} label="Usuarios" value={overview.users.total} detail={`${overview.users.active} con acceso activo`} tone="blue" /><MetricCard icon={ShieldCheck} label="Cupo fundador" value={`${overview.founders.assigned}/100`} detail={`${overview.founders.available} cupos disponibles`} tone="amber" /><MetricCard icon={ActivityIcon} label="Onboarding pendiente" value={overview.organizations.onboarding_pending} detail="Empresas que necesitan completar su perfil" tone="rose" /></div><div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]"><Card className="overflow-hidden border-slate-200 bg-white shadow-sm"><CardHeader className="flex flex-row items-start justify-between gap-3"><div><CardTitle>Organizaciones</CardTitle><CardDescription>Estado de acceso, configuración y plan.</CardDescription></div><Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800"><ShieldCheck /> Aislamiento activo</Badge></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-6">Empresa</TableHead><TableHead>Usuarios</TableHead><TableHead>Plan</TableHead><TableHead>Onboarding</TableHead><TableHead>Estado</TableHead><TableHead className="pr-6 text-right">Acción</TableHead></TableRow></TableHeader><TableBody>{organizations.map((organization) => <TableRow key={organization.id}><TableCell className="max-w-[280px] pl-6"><p className="truncate font-semibold">{organization.name}</p><p className="truncate text-xs text-slate-500">{organization.owner_email || organization.slug}</p></TableCell><TableCell><span className="font-medium">{organization.active_user_count}</span><span className="text-xs text-slate-500"> / {organization.user_count}</span></TableCell><TableCell><Badge variant="secondary">{organization.plan_code || "Sin plan"}</Badge>{organization.founder_number && <p className="mt-1 text-[11px] text-amber-700">Fundador #{organization.founder_number}</p>}</TableCell><TableCell><OnboardingBadge status={organization.onboarding_status} /></TableCell><TableCell><StatusBadge status={organization.status} /></TableCell><TableCell className="pr-6 text-right"><Button variant="ghost" size="sm" onClick={() => void changeStatus(organization)}>{organization.status === "active" ? "Suspender" : "Activar"}<ChevronRight /></Button></TableCell></TableRow>)}{organizations.length === 0 && <TableRow><TableCell colSpan={6} className="h-28 text-center text-sm text-slate-500">Aún no hay organizaciones.</TableCell></TableRow>}</TableBody></Table></CardContent></Card><div className="space-y-5"><Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Servicios</CardTitle><CardDescription>Última señal registrada por los workers.</CardDescription></CardHeader><CardContent className="space-y-3">{overview.services.slice(0, 8).map((service) => <div key={`${service.service_name}-${service.status}`} className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className={`size-2 rounded-full ${service.status === "healthy" || service.status === "ok" ? "bg-emerald-500" : "bg-amber-500"}`} /><p className="truncate text-sm font-medium">{service.service_name}</p></div><p className="shrink-0 text-xs text-slate-500">{formatDate(service.checked_at, true)}</p></div>)}{overview.services.length === 0 && <p className="text-sm text-slate-500">Aún no hay comprobaciones registradas.</p>}</CardContent></Card><Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Actividad reciente</CardTitle><CardDescription>Acciones administrativas y eventos de plataforma.</CardDescription></CardHeader><CardContent className="space-y-3">{overview.audit.slice(0, 6).map((event) => <div key={event.id} className="border-b pb-3 last:border-0 last:pb-0"><p className="text-sm font-medium">{event.action}</p><p className="mt-1 text-xs text-slate-500">{formatDate(event.created_at, true)}</p></div>)}</CardContent></Card></div></div></>}</>}</main><Dialog open={dialogOpen} onOpenChange={(open) => !creating && setDialogOpen(open)}><DialogContent><DialogHeader><DialogTitle>Crear organización</DialogTitle><DialogDescription>Se creará el espacio y se enviará una invitación de propietario válida durante 72 horas.</DialogDescription></DialogHeader><form onSubmit={createOrganization} className="space-y-4"><div className="space-y-2"><Label htmlFor="platform-org-name">Nombre de la empresa</Label><Input id="platform-org-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></div><div className="space-y-2"><Label htmlFor="platform-org-slug">Identificador</Label><Input id="platform-org-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="empresa-ejemplo" /><p className="text-xs text-slate-500">Si lo dejas vacío, se genera desde el nombre.</p></div><Separator /><div className="space-y-2"><Label htmlFor="platform-owner-name">Nombre del propietario</Label><Input id="platform-owner-name" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} required minLength={3} /></div><div className="space-y-2"><Label htmlFor="platform-owner-email">Correo del propietario</Label><Input id="platform-owner-email" type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} required /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button><Button type="submit" disabled={creating} className="bg-[#0b5963] hover:bg-[#084852]">{creating ? "Creando…" : "Crear y enviar invitación"}</Button></DialogFooter></form></DialogContent></Dialog></div>;
}

function MetricCard({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string | number; detail: string; tone: "teal" | "blue" | "amber" | "rose" }) {
  const tones = { teal: "bg-teal-50 text-teal-800", blue: "bg-blue-50 text-blue-800", amber: "bg-amber-50 text-amber-800", rose: "bg-rose-50 text-rose-800" };
  return <Card className="border-slate-200 bg-white shadow-sm"><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{value}</p></div><span className={`flex size-10 items-center justify-center rounded-xl ${tones[tone]}`}><Icon className="size-5" /></span></div><p className="mt-3 text-xs leading-5 text-slate-500">{detail}</p></CardContent></Card>;
}

function OnboardingBadge({ status }: { status: string }) {
  const ready = status === "ready";
  return <Badge variant="outline" className={ready ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{ready ? <CheckCircle2 /> : <Clock3 />}{ready ? "Listo" : status === "blocked" ? "Bloqueado" : "Pendiente"}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const active = status === "active";
  return <Badge variant="outline" className={active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>{active ? <CheckCircle2 /> : <XCircle />}{active ? "Activo" : "Suspendido"}</Badge>;
}

const ActivityIcon = Clock3;
