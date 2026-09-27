"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";

type MfaStatus = { mfa_enabled: boolean; pending: boolean; mfa_enrolled_at: string | null; recovery_codes_remaining: number };

export function MfaSettings() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [dialog, setDialog] = useState<"setup" | "disable" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ qr_data_url: string; manual_key: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => apiFetch<{ mfa: MfaStatus }>("/auth/mfa/status").then((data) => setStatus(data.mfa)), []);
  useEffect(() => { void load(); }, [load]);

  async function beginSetup(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try { setSetup(await apiFetch("/auth/mfa/setup", { method: "POST", body: JSON.stringify({ current_password: password }) })); setPassword(""); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible iniciar la configuración."); }
    finally { setLoading(false); }
  }
  async function verifySetup(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      const result = await apiFetch<{ recovery_codes: string[] }>("/auth/mfa/verify-setup", { method: "POST", body: JSON.stringify({ code }) });
      setRecoveryCodes(result.recovery_codes); setCode(""); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Código no válido."); }
    finally { setLoading(false); }
  }
  async function disable(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try { await apiFetch("/auth/mfa", { method: "DELETE", body: JSON.stringify({ current_password: password, code }) }); setDialog(null); setPassword(""); setCode(""); await load(); toast.success("La verificación en dos pasos fue desactivada."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible desactivarla."); }
    finally { setLoading(false); }
  }

  return <><Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck /></div><CardTitle>Verificación en dos pasos</CardTitle><CardDescription>Añade un código temporal después de la contraseña.</CardDescription></CardHeader><CardContent><div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-slate-50 p-4"><div><p className="text-sm font-semibold">{status?.mfa_enabled ? "Protección activa" : "Protección opcional"}</p><p className="mt-1 text-xs text-slate-500">{status?.mfa_enabled ? `${status.recovery_codes_remaining} códigos de recuperación disponibles` : "Compatible con Google Authenticator, Microsoft Authenticator y similares."}</p></div>{status?.mfa_enabled ? <Button variant="outline" onClick={() => setDialog("disable")}><ShieldOff /> Desactivar</Button> : <Button onClick={() => { setDialog("setup"); setSetup(null); setRecoveryCodes([]); }}><KeyRound /> Configurar</Button>}</div></CardContent></Card>
    <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && !loading && setDialog(null)}><DialogContent><DialogHeader><DialogTitle>{dialog === "disable" ? "Desactivar verificación" : "Configurar autenticador"}</DialogTitle><DialogDescription>{dialog === "disable" ? "Confirma tu contraseña y un código temporal." : "Primero confirma tu contraseña; después escanea el código QR."}</DialogDescription></DialogHeader>
      {dialog === "disable" ? <form onSubmit={disable} className="space-y-4"><PasswordAndCode password={password} setPassword={setPassword} code={code} setCode={setCode} /><DialogFooter><Button variant="outline" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button variant="destructive" disabled={loading}>{loading && <Loader2 className="animate-spin" />} Desactivar</Button></DialogFooter></form> : recoveryCodes.length ? <div className="space-y-4"><Alert className="border-amber-200 bg-amber-50"><KeyRound className="text-amber-800" /><AlertTitle>Guarda estos códigos una sola vez</AlertTitle><AlertDescription>Cada código reemplaza al autenticador una vez. No los guardes junto con tu contraseña.</AlertDescription></Alert><div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{recoveryCodes.map((item) => <span key={item}>{item}</span>)}</div><Button className="w-full" onClick={() => { setDialog(null); setRecoveryCodes([]); toast.success("Verificación en dos pasos activa."); }}>Ya los guardé</Button></div> : setup ? <form onSubmit={verifySetup} className="space-y-4"><Image src={setup.qr_data_url} alt="Código QR para configurar el autenticador" width={208} height={208} unoptimized className="mx-auto size-52 rounded-xl border" /><div className="rounded-xl bg-slate-50 p-3 text-center"><p className="text-xs text-slate-500">Clave manual</p><p className="mt-1 font-mono text-sm font-semibold">{setup.manual_key}</p></div><div className="space-y-2"><Label htmlFor="setup-code">Código de seis dígitos</Label><Input id="setup-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="text-center font-mono tracking-[.2em]" /></div><DialogFooter><Button type="submit" disabled={loading}>{loading && <Loader2 className="animate-spin" />} Verificar y activar</Button></DialogFooter></form> : <form onSubmit={beginSetup} className="space-y-4"><div className="space-y-2"><Label htmlFor="mfa-current-password">Contraseña actual</Label><Input id="mfa-current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><DialogFooter><Button variant="outline" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button type="submit" disabled={loading}>{loading && <Loader2 className="animate-spin" />} Continuar</Button></DialogFooter></form>}
    </DialogContent></Dialog></>;
}

function PasswordAndCode({ password, setPassword, code, setCode }: { password: string; setPassword: (value: string) => void; code: string; setCode: (value: string) => void }) {
  return <><div className="space-y-2"><Label htmlFor="disable-password">Contraseña actual</Label><Input id="disable-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><div className="space-y-2"><Label htmlFor="disable-code">Código temporal</Label><Input id="disable-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} required /></div></>;
}
