"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { BellRing, CheckCircle2, Loader2, Mail, MessageCircle, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { StatusBadge } from "./shared";

type Channel = { id: string; channel_type: "email" | "whatsapp"; destination: string; display_name: string | null; status: string; is_primary: boolean; verified_at: string | null };
type Delivery = { id: string; event_type: string; channel_type: string; recipient: string; subject: string | null; status: string; attempts: number; sent_at: string | null; created_at: string };

export function NotificationSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [readiness, setReadiness] = useState({ email: false, whatsapp: false });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [type, setType] = useState<"email" | "whatsapp">("email");
  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<Channel | null>(null);
  const [token, setToken] = useState("");
  const load = useCallback(async () => {
    const data = await apiFetch<{ channels: Channel[]; deliveries: Delivery[]; readiness: typeof readiness }>("/notifications");
    setChannels(data.channels); setDeliveries(data.deliveries); setReadiness(data.readiness);
  }, []);
  useEffect(() => { queueMicrotask(() => void load().catch(() => undefined)); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      const data = await apiFetch<{ channel: Channel }>("/notifications/channels", { method: "POST", body: JSON.stringify({ channel_type: type, destination, display_name: name }) });
      setVerifyTarget(data.channel); setDialogOpen(false); setDestination(""); setName(""); await load();
      toast.success("Enviamos la verificación al canal indicado.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible crear el canal."); }
    finally { setSaving(false); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); if (!verifyTarget) return; setSaving(true);
    try { await apiFetch(`/notifications/channels/${verifyTarget.id}/verify`, { method: "POST", body: JSON.stringify({ token }) }); setVerifyTarget(null); setToken(""); await load(); toast.success("Canal verificado y activo."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Código no válido."); }
    finally { setSaving(false); }
  }
  async function test(channel: Channel) {
    try { await apiFetch(`/notifications/channels/${channel.id}/test`, { method: "POST", body: "{}" }); toast.success("Prueba agregada a la cola de entrega."); await load(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible enviar la prueba."); }
  }

  return <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
    <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><BellRing /></div><CardTitle>Canales de alertas</CardTitle><CardDescription>Recibe avisos de documentos y oportunidades por correo o WhatsApp.</CardDescription></CardHeader><CardContent className="space-y-3">{channels.map((channel) => <div key={channel.id} className="flex items-center gap-3 rounded-xl border p-3"><span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">{channel.channel_type === "email" ? <Mail className="size-4" /> : <MessageCircle className="size-4" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{channel.display_name || channel.destination}</p><p className="truncate text-xs text-slate-500">{channel.destination}</p></div><StatusBadge status={channel.status} />{channel.status === "pending_verification" ? <Button size="sm" variant="outline" onClick={() => setVerifyTarget(channel)}>Verificar</Button> : <Button size="icon-sm" variant="ghost" onClick={() => void test(channel)} aria-label="Enviar prueba"><Send /></Button>}</div>)}{!channels.length && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Aún no hay canales configurados.</p>}<Button onClick={() => setDialogOpen(true)} className="w-full"><Plus /> Añadir canal</Button><p className="text-xs text-slate-500">Servidor: correo {readiness.email ? "listo" : "pendiente"} · WhatsApp {readiness.whatsapp ? "listo" : "pendiente"}.</p></CardContent></Card>
    <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><h3 className="font-semibold">Últimas entregas</h3><p className="mt-1 text-xs text-slate-500">Trazabilidad de cada mensaje y sus reintentos.</p></div><div className="divide-y">{deliveries.slice(0, 12).map((item) => <div key={item.id} className="flex items-center gap-3 p-4"><span className="flex size-8 items-center justify-center rounded-full bg-slate-100"><CheckCircle2 className="size-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{item.subject || item.event_type}</p><p className="mt-1 truncate text-xs text-slate-500">{item.recipient} · {formatDate(item.sent_at || item.created_at, true)}</p></div><StatusBadge status={item.status} /></div>)}{!deliveries.length && <p className="p-8 text-center text-sm text-slate-500">No hay entregas todavía.</p>}</div></Card>
    <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}><DialogContent><DialogHeader><DialogTitle>Añadir canal</DialogTitle><DialogDescription>Te enviaremos un código o enlace para confirmar que controlas el destino.</DialogDescription></DialogHeader><form onSubmit={create} className="space-y-4"><div className="space-y-2"><Label>Tipo</Label><Select value={type} onValueChange={(value) => setType((value || "email") as "email" | "whatsapp")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="email">Correo electrónico</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label htmlFor="channel-destination">Destino</Label><Input id="channel-destination" type={type === "email" ? "email" : "tel"} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder={type === "email" ? "alertas@empresa.com" : "+573001234567"} required /></div><div className="space-y-2"><Label htmlFor="channel-name">Nombre</Label><Input id="channel-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Administración" /></div><DialogFooter><Button variant="outline" type="button" onClick={() => setDialogOpen(false)}>Cancelar</Button><Button disabled={saving}>{saving && <Loader2 className="animate-spin" />} Enviar verificación</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={Boolean(verifyTarget)} onOpenChange={(open) => !open && !saving && setVerifyTarget(null)}><DialogContent><DialogHeader><DialogTitle>Verificar canal</DialogTitle><DialogDescription>Pega el código recibido. En correo también puedes abrir directamente el enlace enviado.</DialogDescription></DialogHeader><form onSubmit={verify} className="space-y-4"><div className="space-y-2"><Label htmlFor="channel-token">Código o token</Label><Input id="channel-token" value={token} onChange={(event) => setToken(event.target.value)} required /></div><DialogFooter><Button disabled={saving}>{saving && <Loader2 className="animate-spin" />} Verificar</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
