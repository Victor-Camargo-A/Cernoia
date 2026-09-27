"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import colombia from "@svg-maps/colombia";
import { ArrowLeft, Building2, CalendarRange, MapPinned, TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, MarketMetric, MarketSnapshot } from "@/lib/api";
import { formatCurrency } from "@/lib/format";

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapKey(value: string) {
  const key = normalize(value);
  if (["bogotadc", "bogota", "distritocapitaldebogota"].includes(key)) return "bogota";
  if (["guaviar", "guaviare"].includes(key)) return "guaviare";
  if (["northsantander", "nortedesantander"].includes(key)) return "nortedesantander";
  if (key.includes("sanandres") && key.includes("providencia")) return "sanandresprovidencia";
  return key;
}

function color(amount: number, maximum: number, selected: boolean) {
  if (selected) return "#f59e0b";
  if (!amount || !maximum) return "#dcebea";
  const ratio = Math.log10(amount + 1) / Math.log10(maximum + 1);
  if (ratio > .82) return "#064e5b";
  if (ratio > .64) return "#0b7680";
  if (ratio > .45) return "#35a89f";
  if (ratio > .25) return "#82d4c5";
  return "#bfe9df";
}

function isoDateMonthsAgo(months: number) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

export function MarketHeatmapView() {
  const [from, setFrom] = useState(isoDateMonthsAgo(12));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<MarketSnapshot | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedCity, setSelectedCity] = useState("");
  const [drilldown, setDrilldown] = useState<MarketMetric[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<MarketSnapshot>(`/market/heatmap?from=${from}&to=${to}`);
      setData(result);
      setSelectedDepartment(""); setSelectedCity(""); setDrilldown([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible construir el mapa.");
    } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const byDepartment = useMemo(() => new Map((data?.departments ?? []).map((item) => [mapKey(item.name), item])), [data]);
  const maximum = Math.max(0, ...(data?.departments ?? []).map((item) => Number(item.amount_cop)));

  async function selectDepartment(name: string) {
    const match = byDepartment.get(mapKey(name));
    const department = match?.name ?? name;
    setSelectedDepartment(department); setSelectedCity("");
    try {
      const result = await apiFetch<{ items: MarketMetric[] }>(`/market/drilldown?from=${from}&to=${to}&department=${encodeURIComponent(department)}`);
      setDrilldown(result.items);
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible abrir el departamento."); }
  }

  async function selectCity(city: string) {
    setSelectedCity(city);
    try {
      const result = await apiFetch<{ items: MarketMetric[] }>(`/market/drilldown?from=${from}&to=${to}&department=${encodeURIComponent(selectedDepartment)}&city=${encodeURIComponent(city)}`);
      setDrilldown(result.items);
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible abrir las pagadurías."); }
  }

  if (loading && !data) return <div className="grid gap-5 xl:grid-cols-2"><Skeleton className="h-[620px] rounded-2xl" /><Skeleton className="h-[620px] rounded-2xl" /></div>;
  return <div className="space-y-5">
    <Card className="border-slate-200 bg-[#082f38] text-white shadow-sm"><CardContent className="flex flex-wrap items-end justify-between gap-5 p-5 sm:p-6"><div><div className="flex items-center gap-2 text-sm text-teal-200"><MapPinned className="size-4" /> Inteligencia territorial SECOP</div><h2 className="mt-2 text-2xl font-semibold tracking-tight">¿Dónde está comprando el Estado?</h2><p className="mt-2 max-w-2xl text-sm text-slate-300">Explora Colombia, baja a municipio y conoce cada pagaduría dentro del periodo.</p></div><div className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-3"><div><label className="mb-1 block text-xs text-slate-300">Desde</label><Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="border-white/15 bg-white text-slate-950" /></div><div><label className="mb-1 block text-xs text-slate-300">Hasta</label><Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="border-white/15 bg-white text-slate-950" /></div><Button onClick={load} disabled={loading} className="bg-teal-300 text-slate-950 hover:bg-teal-200"><CalendarRange /> Aplicar</Button></div></CardContent></Card>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
      ["Valor publicado", formatCurrency(data?.national.amount_cop), TrendingUp],
      ["Procesos", Number(data?.national.processes ?? 0).toLocaleString("es-CO"), Building2],
      ["Pagadurías", Number(data?.national.payers ?? 0).toLocaleString("es-CO"), Building2],
      ["Departamentos", Number(data?.national.departments ?? 0).toLocaleString("es-CO"), MapPinned],
    ].map(([label, value, Icon]) => <Card key={String(label)} className="border-slate-200 bg-white shadow-sm"><CardContent className="flex items-center justify-between p-5"><div><p className="text-xs text-slate-500">{String(label)}</p><p className="mt-2 text-2xl font-semibold">{String(value)}</p></div><span className="flex size-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><Icon className="size-5" /></span></CardContent></Card>)}</section>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,.95fr)]">
      <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Mapa de contratación</CardTitle><CardDescription>La intensidad representa el valor publicado. Selecciona un departamento.</CardDescription></CardHeader><CardContent><div className="mx-auto max-w-[560px]"><svg viewBox={colombia.viewBox} role="img" aria-label="Mapa de contratación pública de Colombia" className="h-auto w-full drop-shadow-sm">{colombia.locations.map((location: { id: string; name: string; path: string }) => { const metric = byDepartment.get(mapKey(location.name)); const amount = Number(metric?.amount_cop ?? 0); const selected = mapKey(selectedDepartment) === mapKey(location.name); return <path key={location.id} d={location.path} fill={color(amount, maximum, selected)} stroke="#ffffff" strokeWidth="1.2" className="cursor-pointer transition hover:opacity-75 focus:outline-none" tabIndex={0} role="button" aria-label={`${location.name}: ${formatCurrency(amount)}`} onClick={() => void selectDepartment(location.name)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void selectDepartment(location.name); }}><title>{location.name}: {formatCurrency(amount)} · {metric?.processes ?? 0} procesos</title></path>; })}</svg><div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-slate-500"><span>Menor</span>{["#dcebea", "#bfe9df", "#82d4c5", "#35a89f", "#0b7680", "#064e5b"].map((item) => <span key={item} className="h-3 w-7 rounded-sm" style={{ backgroundColor: item }} />)}<span>Mayor</span></div><p className="mt-3 text-center text-[10px] text-slate-400">Geometría: @svg-maps/colombia, licencia CC BY 4.0.</p></div></CardContent></Card>
      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><div className="flex items-center gap-2">{selectedDepartment && <Button variant="ghost" size="icon-sm" onClick={() => { if (selectedCity) void selectDepartment(selectedDepartment); else { setSelectedDepartment(""); setDrilldown([]); } }}><ArrowLeft /></Button>}<div><h3 className="font-semibold">{selectedCity ? `Pagadurías en ${selectedCity}` : selectedDepartment ? `Municipios de ${selectedDepartment}` : "Departamentos con mayor contratación"}</h3><p className="mt-1 text-xs text-slate-500">{selectedCity ? "Entidad, NIT, procesos y valor" : "Procesos y presupuesto reportado"}</p></div></div></div><ScrollArea className="h-[570px]"><div className="divide-y">{(selectedDepartment ? drilldown : data?.departments ?? []).map((item, index) => <button key={`${item.name}-${item.nit ?? index}`} onClick={() => selectedDepartment && !selectedCity ? void selectCity(item.name) : undefined} className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-slate-50 disabled:cursor-default"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{index + 1}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{item.name}</p><p className="mt-1 text-xs text-slate-500">{item.nit ? `NIT ${item.nit} · ` : ""}{Number(item.processes).toLocaleString("es-CO")} procesos{!selectedCity && ` · ${Number(item.payers).toLocaleString("es-CO")} pagadurías`}</p></div><p className="shrink-0 text-sm font-semibold text-teal-900">{formatCurrency(item.amount_cop)}</p></button>)}</div></ScrollArea></Card>
    </div>
    <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle>Evolución mensual</CardTitle><CardDescription>{data?.metric_definition}</CardDescription></CardHeader><CardContent className="h-72"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data?.trend ?? []}><defs><linearGradient id="marketFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0b7680" stopOpacity={.34}/><stop offset="95%" stopColor="#0b7680" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" fontSize={11} /><YAxis hide /><Tooltip formatter={(value) => formatCurrency(Number(value))} /><Area type="monotone" dataKey="amount_cop" stroke="#0b7680" strokeWidth={2} fill="url(#marketFill)" /></AreaChart></ResponsiveContainer></CardContent></Card>
  </div>;
}
