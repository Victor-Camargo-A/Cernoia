"use client";

import Link from "next/link";
import {marketingEvent,trackDemoStart,verifiedSignup} from "@/lib/marketing";
import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, Eye, EyeOff, KeyRound, LockKeyhole, Loader2, MailCheck, ShieldCheck } from "lucide-react";
import { BrandLockup, BrandMark } from "@/app/components/brand-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch, User } from "@/lib/api";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";

type Mode = "login" | "demo" | "invite" | "mfa" | "forgot" | "reset" | "reset_sent" | "reset_done";

export function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [membershipOpen, setMembershipOpen] = useState(false);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const resetTokenValue = parameters.get("reset_token");
    const inviteTokenValue = parameters.get("invite_token");
    if (resetTokenValue) queueMicrotask(() => { setResetToken(resetTokenValue); setMode("reset"); });
    if (inviteTokenValue) queueMicrotask(() => { setInviteToken(inviteTokenValue); setMode("invite"); });
    if (parameters.get("demo") === "1") queueMicrotask(() => setMode("demo"));
  }, []);

  function backToLogin() {
    setMembershipOpen(false); setMode("login"); setError(""); setMfaCode(""); setChallengeToken(""); setInviteToken(""); setFullName(""); setCompanyName("");
    if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setMembershipOpen(false); setLoading(true); setError("");
    try {
      if (mode === "forgot") {
        await apiFetch("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
        setMode("reset_sent"); return;
      }
      if (mode === "reset") {
        if (newPassword !== confirmPassword) throw new Error("La confirmación no coincide.");
        await apiFetch("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, new_password: newPassword }) });
        setMode("reset_done"); window.history.replaceState({}, "", window.location.pathname); return;
      }
      if (mode === "invite") {
        if (newPassword !== confirmPassword) throw new Error("La confirmación no coincide.");
        const data = await apiFetch<{ user: User }>("/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token: inviteToken, full_name: fullName, password: newPassword }) });
        window.history.replaceState({}, "", window.location.pathname);
        onAuthenticated(data.user); return;
      }
      if (mode === "demo") {
        if(event.nativeEvent.isTrusted){await Promise.race([marketingEvent("signup_started",true),new Promise(resolve=>setTimeout(resolve,1200))]);}
        const data = await apiFetch<{ user: User }>("/auth/demo/start", { method: "POST", body: JSON.stringify({ email, full_name: fullName, company_name: companyName, password }) });
        verifiedSignup();
        window.history.replaceState({}, "", window.location.pathname);
        onAuthenticated(data.user); return;
      }
      if (mode === "mfa") {
        const data = await apiFetch<{ user: User }>("/auth/login/mfa", { method: "POST", body: JSON.stringify({ challenge_token: challengeToken, code: mfaCode }) });
        onAuthenticated(data.user); return;
      }
      const data = await apiFetch<{ user?: User; mfa_required?: boolean; challenge_token?: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (data.mfa_required && data.challenge_token) {
        setChallengeToken(data.challenge_token); setPassword(""); setMode("mfa"); return;
      }
      if (!data.user) throw new Error("La respuesta de acceso no es válida.");
      onAuthenticated(data.user);
    } catch (requestError) {
      // Keep the generic authentication response: never expose account existence.
      if (mode === "login" && requestError instanceof ApiError && requestError.status === 401) {
        setMembershipOpen(true);
      }
      setError(requestError instanceof Error ? requestError.message : "No fue posible completar la solicitud.");
    } finally { setLoading(false); }
  }

  const title = mode === "demo" ? "Regístrate para probar CernoIA" : mode === "invite" ? "Activa tu acceso" : mode === "mfa" ? "Verifica tu identidad" : mode === "forgot" ? "Recuperar acceso" : mode === "reset" ? "Nueva contraseña" : mode === "reset_sent" ? "Revisa tu correo" : mode === "reset_done" ? "Contraseña actualizada" : "Acceso a CernoIA";
  const description = mode === "demo" ? "Crea tu cuenta y recorre una oportunidad completa sin costo." : mode === "invite" ? "Completa tu perfil para entrar al espacio privado de tu empresa." : mode === "mfa" ? "Usa tu aplicación autenticadora o un código de recuperación." : mode === "forgot" ? "Te enviaremos un enlace temporal si el correo está registrado." : mode === "reset" ? "Crea una contraseña segura para volver a ingresar." : mode === "reset_sent" ? "Si el correo existe, las instrucciones ya están en camino." : mode === "reset_done" ? "Ya puedes ingresar con tu nueva contraseña." : "Ingresa con la cuenta privada asignada a tu empresa.";

  return <main className="login-grid min-h-svh bg-[#061c25] text-white">
    <section className="login-brand-panel relative hidden overflow-hidden p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
      <BrandLockup className="relative z-10 text-white [&_.brand-mark]:text-teal-300 [&_p:last-child]:text-teal-100" />
      <div className="relative z-10 max-w-2xl"><p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-300">Ver. Comprender. Anticipar.</p><h1 className="mt-5 max-w-xl text-5xl font-semibold leading-[1.04] tracking-[-0.05em] xl:text-6xl">La contratación pública, convertida en decisión.</h1><p className="mt-5 max-w-xl text-base leading-7 text-slate-300 xl:text-lg">CernoIA conecta oportunidades, requisitos y capacidades empresariales para que tu equipo se enfoque donde tiene mejores posibilidades.</p><div className="mt-9 grid max-w-xl gap-3 sm:grid-cols-3">{["Prioridad comercial", "Cobertura documental", "Alertas accionables"].map((label) => <div key={label} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-xs text-slate-300 backdrop-blur"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-teal-300/15 text-teal-300"><Check className="size-3" /></span>{label}</div>)}</div></div>
      <p className="relative z-10 max-w-xl text-xs leading-5 text-slate-500">Plataforma privada e independiente. CernoIA no pertenece a SECOP, Colombia Compra Eficiente ni representa a una entidad estatal.</p>
    </section>
    <section className="flex items-center justify-center bg-[#f4f7f6] px-5 py-10 text-slate-950 sm:px-10"><div className="w-full max-w-md"><div className="mb-8 flex items-center gap-3 text-[#082d38] lg:hidden"><BrandMark className="size-10 text-teal-700" /><div><p className="brand-wordmark font-semibold">Cerno<span>IA</span></p><p className="text-xs text-slate-500">Inteligencia de mercados públicos</p></div></div><Card className="login-card border-slate-200 bg-white py-8 shadow-[0_28px_80px_-42px_rgba(2,44,54,.42)]"><CardHeader className="px-7 sm:px-8"><div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800">{mode === "mfa" ? <ShieldCheck /> : mode.includes("reset") || mode === "forgot" ? <KeyRound /> : <LockKeyhole />}</div><CardTitle className="text-3xl tracking-[-0.04em]">{title}</CardTitle><CardDescription className="text-[0.95rem] leading-6">{description}</CardDescription></CardHeader><CardContent className="px-7 sm:px-8">
        {(mode === "reset_sent" || mode === "reset_done") ? <div className="space-y-5"><div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center"><MailCheck className="mx-auto size-9 text-emerald-700" /><p className="mt-3 text-sm text-emerald-900">{mode === "reset_sent" ? "Por seguridad, mostramos el mismo resultado exista o no la cuenta." : "Todas las sesiones anteriores fueron cerradas."}</p></div><Button onClick={backToLogin} className="w-full bg-[#0b5963] hover:bg-[#084852]"><ArrowLeft /> Volver al acceso</Button></div> : <form className="space-y-5" onSubmit={submit}>
          {error && <Alert variant="destructive"><AlertCircle /><AlertTitle>No pudimos completar la solicitud</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {(mode === "login" || mode === "forgot" || mode === "demo") && <div className="space-y-2"><Label htmlFor="email">Correo electrónico</Label><Input id="email" type="email" autoComplete="email" placeholder="nombre@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={loading} className="h-11" /></div>}
          {(mode === "invite" || mode === "demo") && <div className="space-y-2"><Label htmlFor="invite-name">Nombre completo</Label><Input id="invite-name" autoComplete="name" placeholder="Nombre y apellido" value={fullName} onChange={(event) => setFullName(event.target.value)} required minLength={3} disabled={loading} className="h-11" /></div>}
          {mode === "demo" && <div className="space-y-2"><Label htmlFor="demo-company">Empresa</Label><Input id="demo-company" autoComplete="organization" placeholder="Nombre de tu empresa" value={companyName} onChange={(event) => setCompanyName(event.target.value)} required minLength={2} disabled={loading} className="h-11" /></div>}
          {mode === "login" && <div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="password">Contraseña</Label><button type="button" onClick={() => { setMode("forgot"); setError(""); }} className="text-xs font-medium text-teal-700 hover:underline">¿La olvidaste?</button></div><PasswordInput id="password" value={password} setValue={setPassword} show={showPassword} setShow={setShowPassword} autoComplete="current-password" /></div>}
          {mode === "mfa" && <div className="space-y-2"><Label htmlFor="mfa-code">Código temporal</Label><Input id="mfa-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.toUpperCase())} autoComplete="one-time-code" inputMode="numeric" placeholder="000000 o código de recuperación" required className="h-12 text-center font-mono tracking-[.18em]" /></div>}
          {(mode === "invite" || mode === "demo") && <><div className="space-y-2"><Label htmlFor="invite-password">Contraseña</Label><PasswordInput id="invite-password" value={mode === "demo" ? password : newPassword} setValue={mode === "demo" ? setPassword : setNewPassword} show={showPassword} setShow={setShowPassword} autoComplete="new-password" /></div>{mode === "invite" && <><div className="space-y-2"><Label htmlFor="invite-confirm-password">Confirmar contraseña</Label><Input id="invite-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required autoComplete="new-password" className="h-11" /></div></>}<p className="text-xs text-slate-500">Mínimo 12 caracteres, con letras y números. {mode === "demo" ? "La demo incluye una oportunidad completa." : "Tu acceso quedará ligado a esta empresa."}</p></>}
          {mode === "reset" && <><div className="space-y-2"><Label htmlFor="new-password">Nueva contraseña</Label><PasswordInput id="new-password" value={newPassword} setValue={setNewPassword} show={showPassword} setShow={setShowPassword} autoComplete="new-password" /></div><div className="space-y-2"><Label htmlFor="confirm-password">Confirmar contraseña</Label><Input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required autoComplete="new-password" className="h-11" /></div><p className="text-xs text-slate-500">Mínimo 12 caracteres, con letras y números.</p></>}
          <Button type="submit" disabled={loading} className="h-11 w-full bg-[#0b5963] text-white hover:bg-[#084852]">{loading ? <><Loader2 className="animate-spin" /> Procesando…</> : mode === "demo" ? <>Crear cuenta demo <ArrowRight /></> : mode === "invite" ? <>Activar acceso <ArrowRight /></> : mode === "forgot" ? <>Enviar enlace <ArrowRight /></> : mode === "reset" ? <>Guardar contraseña <ArrowRight /></> : mode === "mfa" ? <>Verificar y entrar <ArrowRight /></> : <>Entrar al espacio de trabajo <ArrowRight /></>}</Button>
          {mode === "login" && <Button type="button" variant="outline" disabled={loading} onClick={event => { void trackDemoStart(event.nativeEvent); setMode("demo"); setError(""); }} className="h-11 w-full border-teal-700 text-teal-800">Crear cuenta demo <ArrowRight /></Button>}
          {mode !== "login" && <Button type="button" variant="ghost" onClick={backToLogin} className="w-full"><ArrowLeft /> Volver</Button>}
        </form>}
        <div className="mt-6 flex items-start gap-2 border-t pt-5 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-teal-700" /><p>Sesión protegida con cookie HttpOnly, CSRF, bloqueo de intentos y verificación en dos pasos opcional. Tus credenciales se mantienen protegidas.</p></div>
      </CardContent></Card><p className="mt-5 text-center text-sm"><Link href="/" className="text-teal-700 hover:underline">← Conocer CernoIA</Link></p>{mode === "login" && <div className="mt-6 rounded-2xl border border-teal-200 bg-teal-50 p-5 text-center"><p className="font-semibold text-[#082d38]">¿Tu empresa aún no tiene CernoIA?</p><p className="mt-2 text-sm leading-6 text-slate-600">Crea una cuenta demo y recorre una oportunidad completa sin costo.</p><Button type="button" variant="outline" disabled={loading} onClick={event => { void trackDemoStart(event.nativeEvent); setMode("demo"); setError(""); }} className="mt-4 border-teal-700 text-teal-800">Crear cuenta demo <ArrowRight /></Button><p className="mt-3 text-xs leading-5 text-slate-500">Si tu empresa ya tiene cuenta, solicita una invitación a su administrador.</p></div>}</div></section>
    <Dialog open={membershipOpen} onOpenChange={setMembershipOpen}>
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto rounded-3xl border-teal-100 bg-white p-6 text-slate-950 sm:p-8" onCloseAutoFocus={(event) => { event.preventDefault(); document.getElementById("email")?.focus(); }}>
        <DialogClose aria-label="Cerrar invitación" className="absolute right-3 top-3 flex size-10 items-center justify-center rounded-full text-xl text-slate-500 hover:bg-slate-100">×</DialogClose>
        <DialogHeader className="pr-5 text-left">
          <p className="text-xs font-semibold uppercase tracking-[.18em] text-teal-700">TU EMPRESA, CON MÁS OPORTUNIDADES</p>
          <DialogTitle className="mt-2 text-2xl leading-tight tracking-tight">¿Aún no tienes cuenta? Haz parte de CernoIA.</DialogTitle>
          <DialogDescription className="mt-2 text-base leading-7 text-slate-600">Encuentra oportunidades en SECOP, analiza requisitos con IA y prepara propuestas con los documentos de tu empresa.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 rounded-2xl bg-teal-50 p-4 text-sm leading-6 text-teal-950">{["Prioriza procesos según el perfil de tu empresa.", "Identifica requisitos y documentos pendientes.", "Organiza la preparación con tu equipo."].map(text => <li key={text} className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-teal-700" />{text}</li>)}</ul>
        <Link href="/planes" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0b5963] px-5 py-3 text-center font-semibold text-white hover:bg-[#084852]">Ver planes y ser suscriptor <ArrowRight className="size-4 shrink-0" /></Link>
        <p className="text-center text-xs leading-5 text-slate-500">El acceso se habilita por empresa e invitación. La membresía se activa al confirmar el pago.</p>
        <div className="border-t pt-4 text-center"><p className="text-sm text-slate-600">¿Ya tienes una cuenta? Revisa tus datos o recupera tu acceso.</p><button type="button" onClick={() => { setMembershipOpen(false); setMode("forgot"); setError(""); setPassword(""); }} className="mt-2 min-h-11 px-3 text-sm font-semibold text-teal-800 hover:underline">Ya tengo cuenta: recuperar acceso</button></div>
      </DialogContent>
    </Dialog>
  </main>;
}

function PasswordInput({ id, value, setValue, show, setShow, autoComplete }: { id: string; value: string; setValue: (value: string) => void; show: boolean; setShow: (value: boolean) => void; autoComplete: string }) {
  return <div className="relative"><Input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(event) => setValue(event.target.value)} required minLength={autoComplete === "new-password" ? 12 : undefined} className="h-11 pr-11" /><button type="button" onClick={() => setShow(!show)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate-500 transition hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600" aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}>{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div>;
}
