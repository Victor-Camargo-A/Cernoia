"use client";

import { FormEvent, useState } from "react";
import { AlertCircle, ArrowRight, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { BrandLockup, BrandMark } from "@/app/components/brand-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, PlatformAdmin } from "@/lib/api";

export function PlatformLoginScreen({ onAuthenticated }: { onAuthenticated: (admin: PlatformAdmin) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<{ admin: PlatformAdmin }>("/platform/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(data.admin);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible iniciar la sesión.");
    } finally {
      setLoading(false);
    }
  }

  return <main className="login-grid min-h-svh bg-[#061c25] text-white">
    <section className="login-brand-panel relative hidden overflow-hidden p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
      <BrandLockup className="relative z-10 text-white [&_.brand-mark]:text-teal-300 [&_p:last-child]:text-teal-100" />
      <div className="relative z-10 max-w-xl"><p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-300">Consola privada</p><h1 className="mt-5 text-5xl font-semibold leading-[1.04] tracking-[-0.05em]">Gobierna CernoIA con una vista segura.</h1><p className="mt-5 text-base leading-7 text-slate-300">Este acceso es independiente de las cuentas de las empresas. Permite supervisar organizaciones, capacidad operativa, cupos fundadores y trazabilidad.</p><div className="mt-8 flex items-center gap-2 text-sm text-slate-400"><ShieldCheck className="size-4 text-teal-300" /> Sin acceso implícito a documentos de clientes</div></div>
      <p className="relative z-10 max-w-xl text-xs leading-5 text-slate-500">Área restringida para administradores autorizados de la plataforma.</p>
    </section>
    <section className="flex items-center justify-center bg-[#f4f7f6] px-5 py-10 text-slate-950 sm:px-10"><div className="w-full max-w-md"><div className="mb-8 flex items-center gap-3 text-[#082d38] lg:hidden"><BrandMark className="size-10 text-teal-700" /><div><p className="brand-wordmark font-semibold">Cerno<span>IA</span></p><p className="text-xs text-slate-500">Consola de plataforma</p></div></div><Card className="border-slate-200 bg-white py-8 shadow-[0_28px_80px_-42px_rgba(2,44,54,.42)]"><CardHeader className="px-7 sm:px-8"><div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><LockKeyhole /></div><CardTitle className="text-3xl tracking-[-0.04em]">Administración de plataforma</CardTitle><CardDescription className="text-[0.95rem] leading-6">Usa una cuenta global separada de las organizaciones cliente.</CardDescription></CardHeader><CardContent className="px-7 sm:px-8"><form onSubmit={submit} className="space-y-5">{error && <Alert variant="destructive"><AlertCircle /><AlertTitle>No pudimos validar el acceso</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}<div className="space-y-2"><Label htmlFor="platform-email">Correo</Label><Input id="platform-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={loading} className="h-11" /></div><div className="space-y-2"><Label htmlFor="platform-password">Contraseña</Label><Input id="platform-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={loading} className="h-11" /></div><Button type="submit" disabled={loading} className="h-11 w-full bg-[#0b5963] hover:bg-[#084852]">{loading ? <Loader2 className="animate-spin" /> : <ArrowRight />} Entrar a la consola</Button></form><div className="mt-6 flex items-start gap-2 border-t pt-5 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-teal-700" /><p>La sesión global no habilita navegación hacia los documentos privados de ninguna empresa.</p></div></CardContent></Card></div></section>
  </main>;
}
