"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandMark } from "@/app/components/brand-mark";
import { DashboardShell } from "@/app/components/dashboard-shell";
import { LoginScreen } from "@/app/components/login-screen";
import { apiFetch, resetApiSecurityState, User } from "@/lib/api";

export default function WorkspaceEntry() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unauthorized = () => {
      resetApiSecurityState();
      setUser(null);
      setChecking(false);
    };
    window.addEventListener("cernoia:unauthorized", unauthorized);
    apiFetch<{ user: User }>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return () => window.removeEventListener("cernoia:unauthorized", unauthorized);
  }, []);

  if (checking) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-[#061c25] text-white">
        <div className="flex flex-col items-center gap-4">
          <BrandMark className="size-12 text-teal-300" />
          <div className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="size-4 animate-spin" /> Verificando sesión segura</div>
        </div>
      </main>
    );
  }

  return user
    ? <DashboardShell user={user} onLogout={() => setUser(null)} />
    : <LoginScreen onAuthenticated={setUser} />;
}
