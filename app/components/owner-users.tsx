"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { roleLabels } from "./dashboard/shared";
import type { UserRole } from "@/lib/api";

type Entry = { id:string; full_name:string; email:string; role:UserRole; status:string; organization_name:string; organization_status:string; plan_name:string|null; subscription_status:string|null; effective_subscription_status:string|null; current_period_end:string|null; next_payment_due_at:string|null; paid_cycles:number|null; last_login_at:string|null };
const labels: Record<string,string> = {active:"Activa",invited:"Invitada",suspended:"Suspendida",pending:"Pendiente",past_due:"Pago vencido",cancelled:"Cancelada",expired:"Vencida"};
export function OwnerUsers({endpoint="/owner/users"}:{endpoint?:string}) {
  const [search,setSearch]=useState(""); const [page,setPage]=useState(1);
  const [data,setData]=useState<{items:Entry[];total:number}|null>(null);
  const [error,setError]=useState(""); const [loading,setLoading]=useState(true); const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;setLoading(true);setError("");setData(null);
    const timer=setTimeout(()=>{void apiFetch<{items:Entry[];total:number}>(`${endpoint}?page=${page}&search=${encodeURIComponent(search)}`).then(value=>{if(active)setData(value);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"No se pudieron consultar los usuarios.");}).finally(()=>{if(active)setLoading(false);});},250);
    return()=>{active=false;clearTimeout(timer);};
  },[endpoint,search,page,revision]);
  return <section className="space-y-4 rounded-2xl border bg-white p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Usuarios y suscripciones</h2><p className="mt-1 text-sm text-slate-600">La suscripción pertenece a la empresa y se comparte con sus usuarios.</p></div><Button variant="outline" disabled={loading} onClick={()=>setRevision(n=>n+1)}>Actualizar</Button></div>
    <Input aria-label="Buscar usuarios por nombre, correo o empresa" placeholder="Buscar por nombre, correo o empresa" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} />
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {loading&&<p role="status">Consultando usuarios…</p>}
    {data&&<><p className="text-sm text-slate-500">{data.total} usuarios encontrados</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Usuario","Empresa","Cuenta / rol","Suscripción","Vencimiento / renovación","Último ingreso"].map(t=><th key={t} className="p-3">{t}</th>)}</tr></thead><tbody>{data.items.map(u=><tr key={u.id} className="border-t"><td className="p-3"><p className="font-medium">{u.full_name}</p><p>{u.email}</p></td><td className="p-3">{u.organization_name}<p className="text-xs text-slate-500">{labels[u.organization_status]??u.organization_status}</p></td><td className="p-3">{labels[u.status]??u.status}<p>{roleLabels[u.role]??u.role}</p></td><td className="p-3"><p className="font-medium">{u.effective_subscription_status?(labels[u.effective_subscription_status]??u.effective_subscription_status):"Sin suscripción"}</p><p>{u.plan_name??"Sin plan contratado"}</p><p className="text-xs">{u.paid_cycles??0} ciclos pagados</p></td><td className="p-3">{formatDate(u.current_period_end)}<p className="text-xs">Renovación: {formatDate(u.next_payment_due_at)}</p></td><td className="p-3">{u.last_login_at?formatDate(u.last_login_at,true):"Sin ingreso"}</td></tr>)}</tbody></table></div>{!data.items.length&&<p>No hay usuarios para esta búsqueda.</p>}</>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={loading||page===1} onClick={()=>setPage(n=>n-1)}>Anterior</Button><span>Página {page}</span><Button variant="outline" disabled={loading||!data||page*50>=data.total} onClick={()=>setPage(n=>n+1)}>Siguiente</Button></div>
  </section>;
}
