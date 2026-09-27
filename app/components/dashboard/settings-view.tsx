"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Bell, Building2, CheckCircle2, KeyRound, Laptop2, Loader2, LockKeyhole,
  Mail, Network, Plus, Save, ShieldCheck, SlidersHorizontal, Sparkles, UserCog, Users, Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Account, apiFetch, OrganizationPreferences, Session, TeamUser, User, UserRole } from "@/lib/api";
import { formatDate, initials } from "@/lib/format";
import { ErrorState, roleLabels, StatusBadge } from "./shared";
import { BusinessProfileSettings } from "./business-profile-settings";
import { MfaSettings } from "./mfa-settings";
import { NotificationSettings } from "./notification-settings";

export function SettingsView({ user, online, onLogout }: { user: User; online: boolean | null; onLogout: () => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canManage = user.role === "owner" || user.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const requests: [Promise<Account>, Promise<{ items: Session[] }>, Promise<{ items: TeamUser[] }> | null] = [
        apiFetch<Account>("/account"),
        apiFetch<{ items: Session[] }>("/auth/sessions"),
        canManage ? apiFetch<{ items: TeamUser[] }>("/users") : null,
      ];
      const [accountData, sessionData, teamData] = await Promise.all([
        requests[0], requests[1], requests[2] ?? Promise.resolve({ items: [] }),
      ]);
      setAccount(accountData);
      setSessions(sessionData.items);
      setTeam(teamData.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible consultar la configuración.");
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  if (loading) return <div className="grid gap-5 xl:grid-cols-2"><Skeleton className="h-80 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></div>;
  if (error || !account) return <ErrorState message={error || "No hay información de cuenta."} retry={load} />;

  return (
    <Tabs defaultValue="organization" className="space-y-5">
      <TabsList className="h-auto max-w-full justify-start overflow-x-auto bg-white p-1 shadow-sm">
        <TabsTrigger value="organization"><Building2 /> Empresa</TabsTrigger>
        <TabsTrigger value="matching"><Sparkles /> Perfil IA</TabsTrigger>
        {canManage && <TabsTrigger value="team"><Users /> Equipo</TabsTrigger>}
        {canManage && <TabsTrigger value="channels"><Bell /> Canales</TabsTrigger>}
        <TabsTrigger value="security"><ShieldCheck /> Seguridad</TabsTrigger>
        <TabsTrigger value="integrations"><Network /> Integraciones</TabsTrigger>
      </TabsList>
      <TabsContent value="organization"><OrganizationSettings account={account} canManage={canManage} onSaved={(preferences) => setAccount((current) => current ? { ...current, preferences } : current)} /></TabsContent>
      <TabsContent value="matching"><BusinessProfileSettings account={account} canManage={canManage} onRefresh={load} /></TabsContent>
      {canManage && <TabsContent value="team"><TeamSettings currentUser={user} team={team} setTeam={setTeam} /></TabsContent>}
      {canManage && <TabsContent value="channels"><NotificationSettings /></TabsContent>}
      <TabsContent value="security"><SecuritySettings user={user} sessions={sessions} onLogout={onLogout} /></TabsContent>
      <TabsContent value="integrations"><IntegrationsSettings online={online} /></TabsContent>
    </Tabs>
  );
}

function OrganizationSettings({ account, canManage, onSaved }: { account: Account; canManage: boolean; onSaved: (preferences: OrganizationPreferences) => void }) {
  const [email, setEmail] = useState(account.preferences.notification_email ?? "");
  const [minimumScore, setMinimumScore] = useState(String(account.preferences.minimum_match_score ?? 60));
  const [departments, setDepartments] = useState((account.preferences.default_departments ?? []).join(", "));
  const [newMatches, setNewMatches] = useState(account.preferences.notify_new_matches);
  const [deadlines, setDeadlines] = useState(account.preferences.notify_deadlines);
  const [dailyDigest, setDailyDigest] = useState(account.preferences.daily_digest);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await apiFetch<{ preferences: OrganizationPreferences }>("/account/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          notification_email: email,
          minimum_match_score: Number(minimumScore),
          default_departments: departments.split(",").map((item) => item.trim()).filter(Boolean),
          notify_new_matches: newMatches,
          notify_deadlines: deadlines,
          daily_digest: dailyDigest,
        }),
      });
      onSaved(data.preferences);
      toast.success("Las preferencias de la empresa quedaron guardadas.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible guardar las preferencias.");
    } finally {
      setSaving(false);
    }
  }

  const sectors = Array.isArray(account.capability_profile?.sectors) ? account.capability_profile.sectors : [];
  return <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
    <div className="space-y-5">
      <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-teal-50 text-teal-800"><Building2 className="size-5" /></div><CardTitle>{account.organization.legal_name || account.organization.name}</CardTitle><CardDescription>Identidad empresarial vinculada a la plataforma.</CardDescription></CardHeader><CardContent className="space-y-4 text-sm"><InfoRow label="NIT" value={account.organization.tax_id || "No informado"} /><InfoRow label="Ubicación" value={[account.organization.city, account.organization.department].filter(Boolean).join(", ") || "No informada"} /><InfoRow label="Estado" value={<StatusBadge status={account.organization.status} />} /></CardContent></Card>
      <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Perfil de capacidades</CardTitle><CardDescription>Base usada para evaluar la afinidad empresarial.</CardDescription></CardHeader><CardContent>{account.capability_profile ? <div className="space-y-3"><div className="flex items-center justify-between gap-3"><p className="font-semibold">{account.capability_profile.name}</p><StatusBadge status={account.capability_profile.is_active ? "active" : "suspended"} /></div>{account.capability_profile.experience_summary && <p className="text-sm leading-6 text-slate-600">{account.capability_profile.experience_summary}</p>}{sectors.length > 0 && <div className="flex flex-wrap gap-2">{sectors.slice(0, 8).map((sector) => <Badge key={String(sector)} variant="secondary">{String(sector)}</Badge>)}</div>}</div> : <p className="text-sm text-slate-500">El perfil empresarial todavía no está configurado.</p>}</CardContent></Card>
    </div>

    <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-teal-700" /><CardTitle>Preferencias de inteligencia</CardTitle></div><CardDescription>Define la sensibilidad del panel y cómo recibir alertas.</CardDescription></CardHeader><CardContent><form onSubmit={save} className="space-y-6"><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="notification-email">Correo de notificaciones</Label><Input id="notification-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!canManage} placeholder="alertas@empresa.com" /></div><div className="space-y-2"><Label htmlFor="minimum-score">Afinidad mínima (%)</Label><Input id="minimum-score" type="number" min="0" max="100" value={minimumScore} onChange={(event) => setMinimumScore(event.target.value)} disabled={!canManage} /></div><div className="space-y-2 sm:col-span-2"><Label htmlFor="default-departments">Departamentos prioritarios</Label><Input id="default-departments" value={departments} onChange={(event) => setDepartments(event.target.value)} disabled={!canManage} placeholder="Bogotá D.C., Antioquia, Valle del Cauca" /><p className="text-xs text-slate-500">Sepáralos con comas.</p></div></div><Separator /><div className="space-y-4"><PreferenceSwitch icon={Bell} title="Nuevas coincidencias" description="Notificar cuando aparezcan oportunidades relevantes." checked={newMatches} setChecked={setNewMatches} disabled={!canManage} /><PreferenceSwitch icon={ClockIcon} title="Fechas límite" description="Alertar sobre cierres y vigencias próximas." checked={deadlines} setChecked={setDeadlines} disabled={!canManage} /><PreferenceSwitch icon={Mail} title="Resumen diario" description="Agrupar la actividad en un correo diario." checked={dailyDigest} setChecked={setDailyDigest} disabled={!canManage} /></div>{canManage && <Button disabled={saving} type="submit" className="bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar preferencias</Button>}</form></CardContent></Card>
  </div>;
}

const ClockIcon = Bell;

function TeamSettings({ currentUser, team, setTeam }: { currentUser: User; team: TeamUser[]; setTeam: (team: TeamUser[]) => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("analyst");
  const [updatingId, setUpdatingId] = useState("");

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await apiFetch<{ invitation: { expires_at: string } }>("/users/invitations", { method: "POST", body: JSON.stringify({ full_name: name, email, role }) });
      setDialogOpen(false);
      setName(""); setEmail(""); setRole("analyst");
      toast.success("Invitación enviada. La persona elegirá su contraseña desde un enlace temporal.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible crear la cuenta.");
    } finally {
      setCreating(false);
    }
  }

  async function updateUser(target: TeamUser, values: { role?: UserRole; status?: string }) {
    setUpdatingId(target.id);
    try {
      const data = await apiFetch<{ user: TeamUser }>(`/users/${target.id}`, { method: "PATCH", body: JSON.stringify({ role: values.role ?? target.role, status: values.status ?? target.status }) });
      setTeam(team.map((item) => item.id === target.id ? data.user : item));
      toast.success("Los permisos quedaron actualizados.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible actualizar la cuenta.");
    } finally {
      setUpdatingId("");
    }
  }

  const roles = currentUser.role === "owner" ? Object.keys(roleLabels) as UserRole[] : ["analyst", "viewer"] as UserRole[];
  return <div className="space-y-5"><Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"><div><h2 className="font-semibold">Equipo y permisos</h2><p className="mt-0.5 text-xs text-slate-500">El registro es privado: solo un administrador puede crear cuentas.</p></div><Button onClick={() => setDialogOpen(true)} className="bg-[#0b5963] hover:bg-[#084852]"><Plus /> Crear cuenta</Button></div><div className="divide-y">{team.map((member) => <div key={member.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(220px,1fr)_180px_150px_120px] lg:items-center"><div className="flex min-w-0 items-center gap-3"><Avatar className="size-10"><AvatarFallback className="bg-teal-50 text-sm text-teal-800">{initials(member.full_name)}</AvatarFallback></Avatar><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{member.full_name}</p>{member.id === currentUser.id && <Badge variant="secondary">Tú</Badge>}</div><p className="truncate text-xs text-slate-500">{member.email}</p></div></div><Select value={member.role} disabled={updatingId === member.id || member.id === currentUser.id} onValueChange={(value) => updateUser(member, { role: (value ?? member.role) as UserRole })}><SelectTrigger className="w-full"><UserCog /><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{roleLabels[item]}</SelectItem>)}</SelectContent></Select><Select value={member.status} disabled={updatingId === member.id || member.id === currentUser.id} onValueChange={(value) => updateUser(member, { status: value ?? member.status })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Activo</SelectItem><SelectItem value="suspended">Suspendido</SelectItem></SelectContent></Select><div className="text-xs text-slate-500 lg:text-right">{updatingId === member.id ? <Loader2 className="ml-auto size-4 animate-spin" /> : member.last_login_at ? `Acceso ${formatDate(member.last_login_at, true)}` : "Sin ingreso"}</div></div>)}</div></Card>

    <Dialog open={dialogOpen} onOpenChange={(open) => !creating && setDialogOpen(open)}><DialogContent><DialogHeader><DialogTitle>Invitar a una persona</DialogTitle><DialogDescription>Enviaremos un enlace de un solo uso válido durante 72 horas. La persona definirá su propia contraseña.</DialogDescription></DialogHeader><form onSubmit={createUser} className="space-y-4"><div className="space-y-2"><Label htmlFor="team-name">Nombre completo</Label><Input id="team-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={3} /></div><div className="space-y-2"><Label htmlFor="team-email">Correo</Label><Input id="team-email" value={email} onChange={(event) => setEmail(event.target.value)} required type="email" /></div><div className="space-y-2"><Label>Rol inicial</Label><Select value={role} onValueChange={(value) => setRole((value ?? "analyst") as UserRole)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{roleLabels[item]}</SelectItem>)}</SelectContent></Select></div><p className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">La invitación queda vinculada únicamente a esta empresa. CernoIA no permite cambiar de organización después del alta.</p><DialogFooter><Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button><Button type="submit" disabled={creating} className="bg-[#0b5963] hover:bg-[#084852]">{creating && <Loader2 className="animate-spin" />} Enviar invitación</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}

function SecuritySettings({ user, sessions, onLogout }: { user: User; sessions: Session[]; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) return toast.error("La confirmación no coincide con la nueva contraseña.");
    setSaving(true);
    try {
      await apiFetch("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      toast.success("Contraseña actualizada. Las demás sesiones fueron cerradas.");
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible cambiar la contraseña.");
    } finally {
      setSaving(false);
    }
  }

  async function logoutAll() {
    setClosing(true);
    try { await apiFetch("/auth/logout-all", { method: "POST" }); } finally { onLogout(); setClosing(false); }
  }

  return <div className="grid gap-5 xl:grid-cols-2"><Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-teal-50 text-teal-800"><KeyRound className="size-5" /></div><CardTitle>Cambiar contraseña</CardTitle><CardDescription>Al guardarla, se cierran automáticamente las demás sesiones.</CardDescription></CardHeader><CardContent><form onSubmit={changePassword} className="space-y-4"><div className="space-y-2"><Label htmlFor="current-password">Contraseña actual</Label><Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div><div className="space-y-2"><Label htmlFor="new-password">Nueva contraseña</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div><div className="space-y-2"><Label htmlFor="confirm-password">Confirmar contraseña</Label><Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div><Button type="submit" disabled={saving} className="bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <LockKeyhole />} Actualizar contraseña</Button></form></CardContent></Card>
    <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><Laptop2 className="size-5" /></div><CardTitle>Sesiones activas</CardTitle><CardDescription>Dispositivos con acceso vigente para {user.email}.</CardDescription></CardHeader><CardContent className="space-y-3">{sessions.map((session) => <div key={session.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{session.current ? "Este dispositivo" : "Sesión web"}</p><p className="mt-1 line-clamp-1 text-xs text-slate-500">{session.user_agent || "Navegador no identificado"}</p></div>{session.current && <Badge className="bg-emerald-50 text-emerald-700">Actual</Badge>}</div><p className="mt-2 text-xs text-slate-500">Última actividad: {formatDate(session.last_seen_at, true)}{session.ip_address ? ` · ${session.ip_address}` : ""}</p></div>)}<Button variant="outline" className="mt-2 w-full text-rose-700 hover:bg-rose-50 hover:text-rose-800" disabled={closing} onClick={logoutAll}>{closing && <Loader2 className="animate-spin" />} Cerrar todas las sesiones</Button></CardContent></Card><MfaSettings /></div>;
}

function IntegrationsSettings({ online }: { online: boolean | null }) {
  return <div className="space-y-5"><Alert className="border-cyan-200 bg-cyan-50/70"><ShieldCheck /><AlertTitle>Integración protegida desde el servidor</AlertTitle><AlertDescription>El navegador nunca recibe secretos ni credenciales de la base de datos. Todas las llamadas pasan por la API de CernoIA.</AlertDescription></Alert><div className="grid gap-5 lg:grid-cols-3"><IntegrationCard icon={Workflow} title="Motor de automatización" description="Servicio operativo protegido" connected={online === true} /><IntegrationCard icon={Building2} title="Datos empresariales" description="Esquema privado por organización" connected /><IntegrationCard icon={CheckCircle2} title="Fuentes públicas" description="Procesos y documentos normalizados" connected /></div></div>;
}

function PreferenceSwitch({ icon: Icon, title, description, checked, setChecked, disabled }: { icon: typeof Bell; title: string; description: string; checked: boolean; setChecked: (value: boolean) => void; disabled: boolean }) {
  return <div className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-500">{description}</p></div><Switch checked={checked} onCheckedChange={setChecked} disabled={disabled} /></div>;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0"><span className="text-slate-500">{label}</span><span className="text-right font-medium">{value}</span></div>;
}

function IntegrationCard({ icon: Icon, title, description, connected }: { icon: typeof Workflow; title: string; description: string; connected: boolean }) {
  return <Card className="border-slate-200 bg-white shadow-sm"><CardContent className="p-5"><div className="mb-5 flex items-center justify-between"><span className="flex size-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><Icon className="size-5" /></span><span className={`size-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"}`} /></div><p className="font-semibold">{title}</p><p className="mt-1 text-sm text-slate-500">{description}</p><p className={`mt-4 text-xs font-semibold ${connected ? "text-emerald-700" : "text-rose-700"}`}>{connected ? "Conectado" : "Sin conexión"}</p></CardContent></Card>;
}
