"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Loader2 } from "lucide-react";
import { BrandMark } from "@/app/components/brand-mark";
import { PlatformLoginScreen } from "@/app/components/platform-login-screen";
import { PlatformShell } from "@/app/components/platform-shell";
import { apiFetch, PlatformAdmin } from "@/lib/api";

export default function PlatformPage() {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    apiFetch<{ admin: PlatformAdmin }>("/platform/me")
      .then((data) => setAdmin(data.admin))
      .catch(() => setAdmin(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="flex min-h-svh items-center justify-center bg-[#061c25] text-white"><div className="flex flex-col items-center gap-4"><BrandMark className="size-12 text-teal-300" /><div className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="size-4 animate-spin" /> Verificando consola segura</div></div></main>;
  return <><Toaster richColors position="top-right" />{admin ? <PlatformShell admin={admin} onLogout={() => setAdmin(null)} /> : <PlatformLoginScreen onAuthenticated={setAdmin} />}</>;
}
