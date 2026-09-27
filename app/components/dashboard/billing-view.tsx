"use client";

import { useCallback, useEffect, useState } from "react";
import {verifiedCheckout,verifiedPurchases} from "@/lib/marketing";
import { Check, CreditCard, Crown, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, BillingOverview } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import { StatusBadge } from "./shared";

export function BillingView() {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const load = useCallback(async () => {
    try {
      const refreshed=await apiFetch<{unavailable:number}>("/billing/refresh",{method:"POST",body:"{}"});
      if(refreshed.unavailable) toast.warning("Bold no respondió a alguna consulta. Se conserva el último estado registrado.");
      const overview=await apiFetch<BillingOverview>("/billing/overview");setData(overview);verifiedPurchases(overview.orders,overview.tracking_started_at);
    }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible consultar el plan."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  async function checkout() {
    setCheckingOut(true);
    try {
      const result = await apiFetch<{ order: { id:string;amount_cop:string|number;currency:string;checkout_url: string | null } }>("/billing/checkout", { method: "POST", body: "{}" });
      if (!result.order.checkout_url) throw new Error("Bold no devolvió un enlace de pago.");
      if(data?.gateway.environment==="production")verifiedCheckout(result.order);
      window.location.assign(result.order.checkout_url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible iniciar el pago.");
      setCheckingOut(false);
    }
  }

  if (!loading && !data) return <Alert><AlertTitle>No pudimos consultar tus pagos</AlertTitle><AlertDescription><Button variant="outline" onClick={() => void load()}>Volver a intentar</Button></AlertDescription></Alert>;
  if (loading || !data) return <div className="grid gap-5 xl:grid-cols-2"><Skeleton className="h-96 rounded-2xl" /><Skeleton className="h-96 rounded-2xl" /></div>;
  const founderProgress = Math.min(100, Math.max(0, Number(data.founders.assigned)));
  const active = data.subscription?.status === "active";
  const canRenew = Boolean(data.subscription?.can_renew);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">La confirmación puede tardar unos minutos. El estado se actualiza automáticamente.</p><Button variant="outline" onClick={() => void load()}><RefreshCw className="size-4" /> Actualizar pagos</Button></div>
    {data.gateway.configured && data.gateway.environment === "test" && <Alert><AlertTitle>Pagos en modo de prueba</AlertTitle><AlertDescription>Los pagos de prueba no representan cobros reales.</AlertDescription></Alert>}
    <Card className="overflow-hidden border-0 bg-[#082f38] text-white shadow-xl shadow-teal-950/10"><CardContent className="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center"><div><Badge className="border-amber-300/30 bg-amber-300/15 text-amber-100"><Crown /> Comunidad fundadora</Badge><h2 className="mt-4 text-3xl font-semibold tracking-tight">Las primeras 100 empresas construyen CernoIA</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Precio fundador de <strong className="text-white">$250.000 COP al mes</strong>, protegido durante 12 meses desde la activación. Después del cupo 100, el plan mensual será de $1.200.000 COP.</p><div className="mt-5 max-w-xl"><div className="mb-2 flex justify-between text-xs text-slate-300"><span>{data.founders.confirmed ?? 0} confirmados · {data.founders.reserved ?? 0} reservas temporales</span><span>{data.founders.available} cupos disponibles</span></div><Progress value={founderProgress} className="bg-white/10 [&>div]:bg-amber-300" /></div></div><div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-center"><p className="text-xs text-slate-300">Precio disponible ahora</p><p className="mt-2 text-3xl font-semibold">{formatCurrency(data.founders.available > 0 ? 250000 : 1200000)}</p><p className="text-xs text-slate-400">COP / mes</p>{!active && <Button onClick={checkout} disabled={checkingOut || !data.gateway.configured} className="mt-4 w-full bg-amber-300 text-slate-950 hover:bg-amber-200">{checkingOut ? <Loader2 className="animate-spin" /> : <CreditCard />} Pagar con Bold</Button>}</div></CardContent></Card>
    {!data.gateway.configured && <Alert className="border-amber-200 bg-amber-50"><ShieldCheck className="text-amber-700" /><AlertTitle>Bold está preparado, pero aún no conectado</AlertTitle><AlertDescription>Los pagos todavía no están disponibles. Contacta al administrador de tu organización.</AlertDescription></Alert>}
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Tu suscripción</CardTitle><CardDescription>El acceso solo cambia cuando Bold confirma el pago por una notificación firmada o una consulta autenticada.</CardDescription></CardHeader><CardContent>{data.subscription ? <div className="space-y-4"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold">{data.subscription.plan_name}</p>{data.subscription.founder_number && <p className="mt-1 text-sm text-amber-700">Fundador #{data.subscription.founder_number}</p>}</div><StatusBadge status={data.subscription.status} /></div><div className="grid gap-3 sm:grid-cols-2"><Info label="Próxima renovación" value={formatDate(data.subscription.next_payment_due_at)} /><Info label="Precio protegido hasta" value={formatDate(data.subscription.founder_price_ends_at)} /><Info label="Ciclos aprobados" value={String(data.subscription.paid_cycles)} /><Info label="Pasarela" value="Bold" /></div>{canRenew && <Button variant="outline" onClick={checkout} disabled={checkingOut}><CreditCard /> Generar enlace de renovación</Button>}{active && !canRenew && <p className="text-xs leading-5 text-slate-500">El enlace de renovación se habilitará siete días antes del vencimiento para proteger el calendario y el precio del plan.</p>}</div> : <div className="py-8 text-center"><CreditCard className="mx-auto size-9 text-slate-300" /><p className="mt-3 font-semibold">Aún no hay una suscripción activa</p><p className="mt-1 text-sm text-slate-500">El cupo fundador se confirma con el primer pago aprobado.</p></div>}</CardContent></Card>
      <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Todo incluido</CardTitle><CardDescription>Una sola oferta para operar de principio a fin.</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{["Chat CernoIA con contexto", "Mapa nacional de contratación", "Expediente y alertas documentales", "Diligenciamiento de plantillas", "Evaluación de cumplimiento", "Acceso para tu equipo"].map((feature) => <div key={feature} className="flex items-start gap-2 rounded-xl border bg-slate-50 p-3 text-sm"><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Check className="size-3" /></span>{feature}</div>)}</CardContent></Card>
    </div>
    <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><h3 className="font-semibold">Historial de pagos</h3><p className="mt-1 text-xs text-slate-500">Órdenes creadas y confirmadas por Bold.</p></div><div className="divide-y">{data.orders.length ? data.orders.map((order) => <div key={order.id} className="flex flex-wrap items-center gap-4 p-4"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{order.billing_reason === "initial" ? "Activación" : "Renovación"} · {formatCurrency(order.amount_cop)}</p><p className="mt-1 text-xs text-slate-500">{formatDate(order.created_at, true)} · {order.reference}</p><p className="mt-2 text-xs text-slate-600">{order.status === "approved" ? "Pago confirmado." : order.status === "rejected" ? "Bold rechazó el pago. Puedes volver a intentarlo." : order.status === "expired" ? "Enlace o reserva vencida. No hay pago confirmado; el cupo temporal está liberado." : order.status === "cancelled" ? "Pago anulado." : "Sin pago confirmado. Un intento fallido o abandonado no activa la suscripción."}</p>{["draft","pending","link_created"].includes(order.status) && <p className="mt-1 text-xs text-amber-700">Reserva temporal hasta {formatDate(order.expires_at, true)}. No eres fundador hasta confirmar el pago.</p>}{order.provider_checked_at && <p className="mt-1 text-xs text-slate-500">Consultado en Bold: {formatDate(order.provider_checked_at, true)}{order.provider_status === "PAID" && order.status !== "approved" ? " · Pago recibido por Bold, activación pendiente de conciliación." : ""}</p>}</div>{order.founder_number && order.status === "approved" && <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800"><Crown /> #{order.founder_number}</Badge>}<StatusBadge status={order.status} />{order.checkout_url && order.status === "link_created" && <Button asChild variant="outline" size="sm"><a href={order.checkout_url}><ExternalLink /> Continuar pago</a></Button>}</div>) : <p className="p-8 text-center text-sm text-slate-500">No hay movimientos todavía.</p>}</div></Card>
  </div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>;
}
