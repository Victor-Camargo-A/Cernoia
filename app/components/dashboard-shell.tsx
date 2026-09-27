"use client";

import { Component, type ReactNode, lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Activity, Bell, Bot, CreditCard, FileCheck2, FilePenLine, LayoutDashboard, LogOut,
  Mail, MapPinned, MessageCircle, RefreshCw, Settings2, ShieldCheck, Target, Workflow, Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { BrandLockup } from "@/app/components/brand-mark";
import { OverviewView } from "@/app/components/dashboard/overview-view";
import { DashboardSection, roleLabels } from "@/app/components/dashboard/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarRail, SidebarSeparator, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { apiFetch, resetApiSecurityState, User } from "@/lib/api";
import { initials } from "@/lib/format";

const CampaignsOwner = lazy(() => import("@/app/components/campaigns-owner").then((module) => ({ default: module.CampaignsOwner })));
const CompanyMatrixView = lazy(() => import("@/app/components/dashboard/company-matrix-view").then((module) => ({ default: module.CompanyMatrixView })));
const OwnerUsers = lazy(() => import("@/app/components/owner-users").then((module) => ({ default: module.OwnerUsers })));
const DemoOnboardingGuide = lazy(() => import("@/app/components/demo-onboarding-guide").then((module) => ({ default: module.DemoOnboardingGuide })));
const YoutubeOwner = lazy(() => import("@/app/components/youtube-owner").then((module) => ({ default: module.YoutubeOwner })));

const AlertsView = lazy(() => import("@/app/components/dashboard/alerts-view").then((module) => ({ default: module.AlertsView })));
const AutomationView = lazy(() => import("@/app/components/dashboard/automation-view").then((module) => ({ default: module.AutomationView })));
const BillingView = lazy(() => import("@/app/components/dashboard/billing-view").then((module) => ({ default: module.BillingView })));
const ChatView = lazy(() => import("@/app/components/dashboard/chat-view").then((module) => ({ default: module.ChatView })));
const DocumentsView = lazy(() => import("@/app/components/dashboard/documents-view").then((module) => ({ default: module.DocumentsView })));
const MarketHeatmapView = lazy(() => import("@/app/components/dashboard/market-heatmap-view").then((module) => ({ default: module.MarketHeatmapView })));
const OperationsCenterView = lazy(() => import("@/app/components/dashboard/operations-center-view").then((module) => ({ default: module.OperationsCenterView })));
const OpportunitiesView = lazy(() => import("@/app/components/dashboard/opportunities-view").then((module) => ({ default: module.OpportunitiesView })));
const SettingsView = lazy(() => import("@/app/components/dashboard/settings-view").then((module) => ({ default: module.SettingsView })));
const TemplatesView = lazy(() => import("@/app/components/dashboard/templates-view").then((module) => ({ default: module.TemplatesView })));

const sectionCopy: Record<DashboardSection, { title: string; description: string }> = {
  matrix: { title: "Matriz empresarial", description: "Capacidades, evidencias y pendientes de tu empresa." },
  "owner-users": { title: "Usuarios y suscripciones", description: "Usuarios registrados y suscripción de cada empresa." },
  youtube: { title: "Videos y YouTube", description: "Revisa y publica contenido educativo desde tu canal." },
  campaigns: { title: "Campañas comerciales", description: "Módulo exclusivo del propietario de CernoIA." },
  overview: { title: "Centro de inteligencia", description: "Lo que requiere atención hoy, en una sola lectura." },
  opportunities: { title: "Oportunidades", description: "Procesos priorizados por afinidad con tu empresa." },
  market: { title: "Mapa de contratación", description: "Mercado público por departamento, municipio y pagaduría." },
  chat: { title: "Chat CernoIA", description: "Consulta tu contexto empresarial con un agente controlado." },
  documents: { title: "Documentos empresariales", description: "Carga, vigencias y cobertura frente a requisitos." },
  templates: { title: "Autollenado", description: "Plantillas oficiales diligenciadas con datos verificados." },
  alerts: { title: "Alertas", description: "Cierres próximos y documentación que debes gestionar." },
  billing: { title: "Plan y pagos", description: "Suscripción, cupo fundador y pagos seguros con Bold." },
  operations: { title: "Centro operativo", description: "Salud de datos, IA, automatizaciones y entregas." },
  automation: { title: "Automatización", description: "Actualización del mercado y trazabilidad operativa." },
  settings: { title: "Configuración", description: "Empresa, equipo, seguridad e integraciones." },
};

export function DashboardShell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [campaignsOwner, setCampaignsOwner] = useState(false);
  const [section, setSection] = useState<DashboardSection>("overview");
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    void apiFetch<{ allowed: boolean }>("/owner-campaigns/access").then((data) => {
      if (active) {
        setCampaignsOwner(data.allowed);
        const result=new URLSearchParams(window.location.search).get("youtube");
        if(data.allowed&&result){setSection("youtube");if(result==="error")toast.error("No se pudo conectar el canal. Comprueba la configuración y vuelve a autorizar.");if(result==="connected")toast.success("Canal de YouTube conectado.");}
      }
    }).catch(() => { if (active) setCampaignsOwner(false); });
    return () => { active = false; };
  }, [user.id]);

  const navigation = useMemo(() => {
    const base: Array<{ id: DashboardSection; label: string; icon: LucideIcon }> = [
      { id: "overview" as const, label: "Inicio", icon: LayoutDashboard },
      { id: "opportunities" as const, label: "Oportunidades", icon: Target },
      { id: "market" as const, label: "Mapa de mercado", icon: MapPinned },
      { id: "chat" as const, label: "Chat CernoIA", icon: MessageCircle },
      { id: "documents" as const, label: "Documentos", icon: FileCheck2 },
      { id: "matrix" as const, label: "Matriz empresarial", icon: Bot },
      { id: "templates" as const, label: "Autollenado", icon: FilePenLine },
      { id: "alerts" as const, label: "Alertas", icon: Bell },
    ];
    if (user.role === "owner" || user.role === "admin") {
      base.push({ id: "billing" as const, label: "Plan y pagos", icon: CreditCard });
      base.push({ id: "operations" as const, label: "Centro operativo", icon: Activity });
      base.push({ id: "automation" as const, label: "Automatización", icon: Workflow });
    }
    if (campaignsOwner) base.push({ id: "campaigns" as const, label: "Campañas comerciales", icon: Mail });
    if (campaignsOwner) base.push({ id: "owner-users" as const, label: "Usuarios y suscripciones", icon: ShieldCheck });
    if (campaignsOwner) base.push({ id: "youtube" as const, label: "Videos y YouTube", icon: Video });
    return [...base, { id: "settings" as const, label: "Configuración", icon: Settings2 }];
  }, [user.role, campaignsOwner]);

  useEffect(() => {
    apiFetch<{ online: boolean }>("/workflows/health")
      .then((data) => setEngineOnline(data.online))
      .catch(() => setEngineOnline(false));
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const billingAction = parameters.get("billing");
    if (!billingAction) return;
    queueMicrotask(() => {
      setSection("billing");
      toast.info(
        billingAction === "return"
          ? "Estamos verificando la confirmación de Bold. El plan se activa únicamente cuando llega el webhook firmado."
          : "Tu renovación está disponible en Plan y pagos.",
      );
      parameters.delete("billing");
      const search = parameters.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
    });
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const channelId = parameters.get("notification_channel");
    const token = parameters.get("verification");
    if (!channelId || !token) return;
    queueMicrotask(() => {
      setSection("settings");
      apiFetch(`/notifications/channels/${encodeURIComponent(channelId)}/verify`, {
        method: "POST",
        body: JSON.stringify({ token }),
      })
        .then(() => toast.success("Canal de alertas verificado."))
        .catch((error) => toast.error(error instanceof Error ? error.message : "No fue posible verificar el canal."))
        .finally(() => window.history.replaceState({}, "", window.location.pathname));
    });
  }, []);

  async function logout() {
    setLoggingOut(true);
    try { await apiFetch<void>("/auth/logout", { method: "POST" }); } catch { /* La sesión local se cierra igualmente. */ }
    resetApiSecurityState();
    onLogout();
  }

  function navigate(next: DashboardSection) {
    setSection(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-r border-[#123944] bg-[#061f28] text-slate-100">
        <SidebarHeader className="p-3">
          <div className="flex h-14 items-center overflow-hidden rounded-xl px-2 text-teal-300">
            <BrandLockup className="text-white [&_.brand-mark]:text-teal-300 [&_p:last-child]:text-teal-100" />
          </div>
        </SidebarHeader>
        <SidebarSeparator className="bg-white/10" />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="text-slate-500">Espacio de trabajo</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton tooltip={item.label} isActive={section === item.id} onClick={() => navigate(item.id)} className="h-10 text-slate-300 hover:bg-white/8 hover:text-white data-[active=true]:bg-teal-300/12 data-[active=true]:text-teal-200">
                      <item.icon /><span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-auto group-data-[collapsible=icon]:hidden">
            <div className="mx-2 rounded-xl border border-white/8 bg-white/[0.035] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-300"><Bot className="size-3.5 text-teal-300" /> Motor de inteligencia</div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500"><span className={`size-2 rounded-full ${engineOnline === null ? "bg-slate-500" : engineOnline ? "bg-emerald-400" : "bg-rose-400"}`} />{engineOnline === null ? "Verificando" : engineOnline ? "Operativo" : "Sin conexión"}</div>
            </div>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip={user.full_name} onClick={() => navigate("settings")} className="hover:bg-white/8">
                <Avatar className="size-8 rounded-lg"><AvatarFallback className="rounded-lg bg-teal-300/15 text-xs text-teal-100">{initials(user.full_name)}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1 text-left"><p className="truncate text-sm text-white">{user.full_name}</p><p className="truncate text-xs text-slate-500">{roleLabels[user.role]}</p></div>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem><SidebarMenuButton disabled={loggingOut} tooltip="Cerrar sesión" onClick={logout} className="text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"><LogOut /><span>{loggingOut ? "Cerrando…" : "Cerrar sesión"}</span></SidebarMenuButton></SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0 bg-[#f4f7f6]">
        <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 border-b border-slate-200/80 bg-[#f4f7f6]/92 px-4 py-2 backdrop-blur-xl md:px-7">
          <div className="flex min-w-0 items-center gap-3"><SidebarTrigger className="size-9 shrink-0" /><Separator orientation="vertical" className="hidden h-5 sm:block" /><div className="min-w-0"><h1 className="truncate text-sm font-semibold text-slate-950 md:text-base">{sectionCopy[section].title}</h1><p className="hidden truncate text-xs text-slate-500 sm:block">{sectionCopy[section].description}</p></div></div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" className="hidden border-emerald-200 bg-emerald-50 text-emerald-700 lg:flex"><ShieldCheck /> Sesión protegida</Badge>
            <Button variant="outline" size="icon-sm" onClick={() => navigate("alerts")} aria-label="Abrir alertas"><Bell /></Button>
            <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event("cernoia:refresh"))}><RefreshCw /><span className="hidden sm:inline">Actualizar</span></Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1580px] flex-1 overflow-x-hidden p-4 md:p-7">
          <Suspense fallback={null}><DemoOnboardingGuide userId={user.id} navigate={navigate} /></Suspense>
          <DashboardErrorBoundary key={section}><Suspense fallback={<SectionLoading />}>
            {section === "campaigns" && campaignsOwner && <CampaignsOwner />}
            {section === "youtube" && campaignsOwner && <YoutubeOwner />}
            {section === "overview" && <OverviewView navigate={navigate} />}
            {section === "opportunities" && <OpportunitiesView user={user} />}
            {section === "market" && <MarketHeatmapView />}
            {section === "chat" && <ChatView />}
            {section === "documents" && <DocumentsView user={user} />}
            {section === "matrix" && <CompanyMatrixView user={user} onDocuments={() => navigate("documents")} onSettings={() => navigate("settings")} />}
            {section === "owner-users" && campaignsOwner && <OwnerUsers />}
            {section === "templates" && <TemplatesView user={user} />}
            {section === "alerts" && <AlertsView navigate={navigate} user={user} />}
            {section === "billing" && <BillingView />}
            {section === "operations" && <OperationsCenterView />}
            {section === "automation" && <AutomationView online={engineOnline} setOnline={setEngineOnline} />}
            {section === "settings" && <SettingsView user={user} online={engineOnline} onLogout={() => { resetApiSecurityState(); onLogout(); }} />}
          </Suspense></DashboardErrorBoundary>
        </main>
        <footer className="border-t border-slate-200 bg-white px-4 py-5 text-center text-xs leading-5 text-slate-500 md:px-7"><p>Desarrollado y operado por Energética Nika S.A.S. · NIT 902050074-0 · Tuluá, Valle del Cauca</p><p><a className="text-teal-800 hover:underline" href="https://wa.me/573207830189">WhatsApp +57 320 783 0189</a> · <a className="text-teal-800 hover:underline" href="mailto:director@energeticanika.com">director@energeticanika.com</a> · Todos los derechos reservados.</p></footer>
      </SidebarInset>
      <Toaster richColors closeButton position="top-right" />
    </SidebarProvider>
  );
}

function SectionLoading() {
  return <div className="grid animate-pulse gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Cargando sección">
    {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-36 rounded-2xl border border-slate-200 bg-white" />)}
  </div>;
}

class DashboardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h2 className="font-semibold">No pudimos mostrar esta sección</h2><p className="mt-2 text-sm">Puedes volver a intentarlo o abrir otra opción del menú.</p><Button className="mt-4" onClick={() => this.setState({ failed: false })}>Volver a intentar</Button></div>;
    return this.props.children;
  }
}
