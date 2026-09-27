"use client";

import { FormEvent, useEffect, useState } from "react";
import { Building2, CheckCircle2, Circle, Loader2, Plus, Save, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Account, apiFetch } from "@/lib/api";
import type {BusinessSummary} from "@/lib/company-business-summary";
import { RepresentativeEditor } from "./representative-editor";

function splitList(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function joinList(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

export function BusinessProfileSettings({ account, canManage, onRefresh }: { account: Account; canManage: boolean; onRefresh: () => Promise<void> }) {
  return <div className="space-y-5">
    <SetupProgress account={account} />
    <div className="grid gap-5 xl:grid-cols-2">
      <OrganizationIdentity account={account} canManage={canManage} onRefresh={onRefresh} />
      <CapabilityEditor account={account} canManage={canManage} onRefresh={onRefresh} />
    </div>
    <RepresentativeEditor account={account} canManage={canManage} onRefresh={onRefresh} />
    <SearchProfilesEditor account={account} canManage={canManage} onRefresh={onRefresh} />
  </div>;
}

function SetupProgress({ account }: { account: Account }) {
  const steps = [
    { label: "Identidad empresarial", ready: account.onboarding.organization_complete },
    { label: "Capacidades listas para IA", ready: account.onboarding.capability_ready },
    { label: "Perfil de búsqueda activo", ready: account.onboarding.active_search_profiles > 0 },
  ];
  return <Alert className={account.onboarding.ready_for_matching ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}>
    {account.onboarding.ready_for_matching ? <CheckCircle2 /> : <Sparkles />}
    <AlertTitle>{account.onboarding.ready_for_matching ? "Perfil listo para encontrar oportunidades" : "Completa la configuración inicial"}</AlertTitle>
    <AlertDescription>
      <p className="mb-3">WF-005 y WF-008 usan esta información para buscar y analizar procesos adecuados para tu empresa.</p>
      <div className="flex flex-wrap gap-2">{steps.map((step) => <Badge key={step.label} className={step.ready ? "bg-emerald-100 text-emerald-800" : "bg-white/80 text-amber-900"}>{step.ready ? <CheckCircle2 /> : <Circle />} {step.label}</Badge>)}</div>
    </AlertDescription>
  </Alert>;
}

function OrganizationIdentity({ account, canManage, onRefresh }: { account: Account; canManage: boolean; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState(account.organization.name ?? "");
  const [legalName, setLegalName] = useState(account.organization.legal_name ?? "");
  const [taxId, setTaxId] = useState(account.organization.tax_id ?? "");
  const [city, setCity] = useState(account.organization.city ?? "");
  const [department, setDepartment] = useState(account.organization.department ?? "");
  const [website, setWebsite] = useState(account.organization.website ?? "");
  const [representativeName, setRepresentativeName] = useState(account.organization.representative_name ?? "");
  const [organizationType, setOrganizationType] = useState(account.organization.organization_type ?? "unconfirmed");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      await apiFetch("/account/organization", { method: "PATCH", body: JSON.stringify({ name, legal_name: legalName, tax_id: taxId, city, department, website, representative_name: representativeName, organization_type: organizationType }) });
      toast.success("La identidad empresarial quedó actualizada.");
      await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible actualizar la empresa."); }
    finally { setSaving(false); }
  }

  const typeLabels: Record<string, string> = {
    unconfirmed: "Selecciona una opción",
    legal_entity: "Persona jurídica",
    natural_person: "Persona natural",
    consortium: "Consorcio",
    temporary_union: "Unión temporal",
    nonprofit: "Entidad sin ánimo de lucro",
    other: "Otro tipo de proponente",
  };
  const suggestion = account.organization_type_suggestion;

  return <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-teal-50 text-teal-800"><Building2 className="size-5" /></div><CardTitle>Identidad empresarial</CardTitle><CardDescription>Datos básicos usados para separar la cuenta y presentar los análisis.</CardDescription></CardHeader><CardContent><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><Field id="company-name" label="Nombre corto" value={name} setValue={setName} disabled={!canManage} required /><Field id="legal-name" label="Razón social" value={legalName} setValue={setLegalName} disabled={!canManage} /><Field id="tax-id" label="NIT o identificación" value={taxId} setValue={setTaxId} disabled={!canManage} required /><div className="space-y-2"><Label>Tipo de proponente</Label><Select value={organizationType} onValueChange={(value) => setOrganizationType((value ?? "unconfirmed") as Account["organization"]["organization_type"])} disabled={!canManage}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(typeLabels).map(([value, label]) => <SelectItem key={value} value={value} disabled={value === "unconfirmed"}>{label}</SelectItem>)}</SelectContent></Select></div><Field id="company-website" label="Sitio web" value={website} setValue={setWebsite} disabled={!canManage} type="url" placeholder="https://empresa.com" /><Field id="company-city" label="Ciudad" value={city} setValue={setCity} disabled={!canManage} /><Field id="company-department" label="Departamento" value={department} setValue={setDepartment} disabled={!canManage} />{suggestion && suggestion.organization_type !== organizationType && <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-xs leading-5 text-cyan-950 sm:col-span-2"><p><strong>Sugerencia del análisis documental:</strong> {typeLabels[suggestion.organization_type] ?? suggestion.organization_type}.</p><p className="mt-1 text-cyan-800">Se detectó en “{suggestion.document_name}”. Confírmala antes de guardarla; CernoIA no cambia este dato automáticamente.</p>{canManage && <Button type="button" variant="outline" size="sm" className="mt-3 border-cyan-300 bg-white" onClick={() => setOrganizationType(suggestion.organization_type)}>Usar sugerencia</Button>}</div>}{canManage && <Button type="submit" disabled={saving || organizationType === "unconfirmed"} className="sm:col-span-2 sm:w-fit bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar empresa</Button>}</form></CardContent></Card>;
}

function CapabilityEditor({ account, canManage, onRefresh }: { account: Account; canManage: boolean; onRefresh: () => Promise<void> }) {
  const profile = account.capability_profile;
  const [summary, setSummary] = useState(profile?.company_summary ?? "");
  const [products, setProducts] = useState(joinList(profile?.products_services));
  const [unspsc, setUnspsc] = useState(joinList(profile?.unspsc_codes));
  const [departments, setDepartments] = useState(joinList(profile?.service_departments));
  const [methods, setMethods] = useState(joinList(profile?.procurement_methods));
  const [contractTypes, setContractTypes] = useState(joinList(profile?.contract_types));
  const [minimumValue, setMinimumValue] = useState(String(profile?.minimum_contract_value ?? ""));
  const [maximumValue, setMaximumValue] = useState(String(profile?.maximum_contract_value ?? ""));
  const [years, setYears] = useState(String(profile?.years_experience ?? ""));
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      await apiFetch("/account/capability-profile", { method: "PUT", body: JSON.stringify({ company_summary: summary, products_services: splitList(products), unspsc_codes: splitList(unspsc), service_departments: splitList(departments), procurement_methods: splitList(methods), contract_types: splitList(contractTypes), minimum_contract_value: minimumValue || null, maximum_contract_value: maximumValue || null, years_experience: years || null }) });
      toast.success("El perfil de capacidades ya está listo para el análisis.");
      await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar las capacidades."); }
    finally { setSaving(false); }
  }

  return <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="flex items-start justify-between gap-3"><div><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><Sparkles className="size-5" /></div><CardTitle>Capacidades para IA</CardTitle></div><Badge className={profile?.is_ready_for_ai ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>{profile?.is_ready_for_ai ? "Listo" : "Incompleto"}</Badge></div><CardDescription>Los documentos completan automáticamente los campos respaldados. Puedes modificar cualquier dato; los cambios que guardes tendrán prioridad.</CardDescription></CardHeader><CardContent>{profile?.automatic_profile&&<p className="mb-4 rounded-xl bg-teal-50 p-4 text-sm leading-6 text-teal-950">{profile.automatic_profile.message}{profile.automatic_profile.unspsc_suggestions?.map(item=><span key={item.code} className="mt-2 block"><strong>{item.code} · {item.label}</strong><br/>{item.reason}</span>)}{profile.automatic_profile.unspsc_status==="queued"&&<span className="mt-2 block">La IA está clasificando los códigos UNSPSC a partir de tus documentos.</span>}</p>}<form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><div className="space-y-2 sm:col-span-2"><Label htmlFor="company-summary">Descripción de capacidades</Label><Textarea id="company-summary" value={summary} onChange={(event) => setSummary(event.target.value)} disabled={!canManage} minLength={40} maxLength={5000} rows={5} placeholder="Servicios, experiencia, equipo y alcance que la empresa puede acreditar…" required /></div><ListField id="products" label="Productos y servicios" value={products} setValue={setProducts} disabled={!canManage} placeholder="Actividades respaldadas por tus documentos" /><ListField id="unspsc" label="Códigos UNSPSC" value={unspsc} setValue={setUnspsc} disabled={!canManage} placeholder="Códigos de tu empresa, separados por comas" /><ListField id="service-departments" label="Cobertura" value={departments} setValue={setDepartments} disabled={!canManage} placeholder="Nacional" /><ListField id="procurement-methods" label="Modalidades preferidas" value={methods} setValue={setMethods} disabled={!canManage} placeholder="Mínima cuantía, Selección abreviada" /><ListField id="contract-types" label="Tipos de contrato" value={contractTypes} setValue={setContractTypes} disabled={!canManage} placeholder="Suministro, Servicios, Obra" /><Field id="experience-years" label="Años de experiencia" value={years} setValue={setYears} disabled={!canManage} type="number" min="0" /><Field id="minimum-contract" label="Valor mínimo (COP)" value={minimumValue} setValue={setMinimumValue} disabled={!canManage} type="number" min="0" /><Field id="maximum-contract" label="Valor máximo (COP)" value={maximumValue} setValue={setMaximumValue} disabled={!canManage} type="number" min="0" />{canManage && <Button type="submit" disabled={saving} className="sm:col-span-2 sm:w-fit bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar capacidades</Button>}</form></CardContent></Card>;
}

function SearchProfilesEditor({ account, canManage, onRefresh }: { account: Account; canManage: boolean; onRefresh: () => Promise<void> }) {
  type SearchProfile = Account["search_profiles"][number];
  const initial = account.search_profiles[0] as SearchProfile | undefined;
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? ""); const [description, setDescription] = useState(initial?.description ?? "");
  const [methods, setMethods] = useState(joinList(initial?.procurement_methods??["Mínima cuantía"]));
  const [statuses, setStatuses] = useState(joinList(initial?.process_statuses??["Publicado"]));
  const [contractTypes,setContractTypes]=useState(joinList(initial?.contract_types));
  const [keywords, setKeywords] = useState(joinList(initial?.keywords)); const [excluded, setExcluded] = useState(joinList(initial?.excluded_keywords));
  const [departments, setDepartments] = useState(joinList(initial?.departments)); const [unspsc, setUnspsc] = useState(joinList(initial?.unspsc_codes));
  const [minimum, setMinimum] = useState(String(initial?.minimum_budget ?? "")); const [maximum, setMaximum] = useState(String(initial?.maximum_budget ?? ""));
  const [onlyOpen, setOnlyOpen] = useState(initial?.only_open ?? true); const [active, setActive] = useState(initial?.is_active ?? true); const [saving, setSaving] = useState(false);

  const [recommendations,setRecommendations]=useState<BusinessSummary["recommendations"]|null>(null);
  useEffect(()=>{let active=true;void apiFetch<{business_summary?:BusinessSummary}>("/company-matrix").then(data=>{if(active)setRecommendations(data.business_summary?.recommendations??null)}).catch(()=>{});return()=>{active=false}},[]);
  function addRecommendedMethods(){setMethods([...new Set([...splitList(methods),"Mínima cuantía",...(recommendations?.procurement_methods.map(m=>m.name)??[])])].join(", "));}

  function selectProfile(profile: SearchProfile) {
    setMethods(joinList(profile.procurement_methods)); setStatuses(joinList(profile.process_statuses)); setContractTypes(joinList(profile.contract_types));
    setSelectedId(profile.id); setName(profile.name); setDescription(profile.description ?? ""); setKeywords(joinList(profile.keywords));
    setExcluded(joinList(profile.excluded_keywords)); setDepartments(joinList(profile.departments)); setUnspsc(joinList(profile.unspsc_codes));
    setMinimum(String(profile.minimum_budget ?? "")); setMaximum(String(profile.maximum_budget ?? "")); setOnlyOpen(profile.only_open); setActive(profile.is_active);
  }

  function createNew() {
    setMethods("Mínima cuantía"); setStatuses("Publicado"); setContractTypes(""); setSelectedId(""); setName(""); setDescription(""); setKeywords(""); setExcluded(""); setDepartments(""); setUnspsc(""); setMinimum(""); setMaximum(""); setOnlyOpen(true); setActive(true); }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      const data = await apiFetch<{ search_profile: SearchProfile }>("/account/search-profile", { method: "PUT", body: JSON.stringify({ id: selectedId || null, name, description, procurement_methods: splitList(methods), process_statuses: splitList(statuses), contract_types: splitList(contractTypes), keywords: splitList(keywords), excluded_keywords: splitList(excluded), departments: splitList(departments), unspsc_codes: splitList(unspsc), minimum_budget: minimum || null, maximum_budget: maximum || null, only_open: onlyOpen, is_active: active }) });
      setSelectedId(data.search_profile.id); toast.success("El perfil de búsqueda quedó guardado."); await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar el perfil de búsqueda."); }
    finally { setSaving(false); }
  }

  return <Card className="border-slate-200 bg-white shadow-sm"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700"><Search className="size-5" /></div><CardTitle>Perfiles de búsqueda</CardTitle><CardDescription>Define qué procesos debe convertir CernoIA en oportunidades.</CardDescription></div>{canManage && <Button variant="outline" onClick={createNew}><Plus /> Nuevo perfil</Button>}</div></CardHeader><CardContent className="grid gap-5 lg:grid-cols-[240px_1fr]"><div className="space-y-2">{account.search_profiles.length ? account.search_profiles.map((profile) => <button type="button" key={profile.id} onClick={() => selectProfile(profile)} className={`w-full rounded-xl border p-3 text-left transition ${selectedId === profile.id ? "border-teal-500 bg-teal-50" : "border-slate-200 hover:bg-slate-50"}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{profile.name}</span><span className={`size-2.5 rounded-full ${profile.is_active ? "bg-emerald-500" : "bg-slate-300"}`} /></div><p className="mt-1 text-xs text-slate-500">{profile.keywords.length} palabras · {profile.departments.length || "todos los"} departamentos</p></button>) : <div className="rounded-xl border border-dashed p-4 text-sm text-slate-500">Aún no existe un perfil. Crea el primero con el formulario.</div>}</div><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><div className="space-y-2 rounded-xl border border-teal-200 bg-teal-50 p-4 sm:col-span-2"><h3 className="text-sm font-semibold">Filtros y capacidad documental</h3><p className="text-sm">La búsqueda inicial usa mínima cuantía y estado publicado. Puedes modificar ambos filtros.</p>{recommendations&&<><p className="text-sm">{recommendations.message}</p>{recommendations.contract_types.length>0&&<div className="space-y-2"><p className="text-sm">Tipos afines: {recommendations.contract_types.join(" · ")}</p>{canManage&&<Button type="button" variant="outline" onClick={()=>setContractTypes([...new Set([...splitList(contractTypes),...recommendations.contract_types])].join(", "))}>Agregar tipos de contrato sugeridos</Button>}</div>}{recommendations.can_expand&&<><p className="text-sm">Modalidades para explorar: {recommendations.procurement_methods.map(m=>m.name).join(" · ")}</p>{canManage&&<Button type="button" variant="outline" onClick={addRecommendedMethods}>Agregar modalidades sugeridas y conservar mínima cuantía</Button>}</>}<p className="text-xs text-slate-600">{recommendations.limitation}</p></>}{!splitList(methods).some(m=>m.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()==='minima cuantia')&&methods&&<p className="text-xs text-amber-900">Este filtro excluirá mínima cuantía. Puedes agregarla aunque explores contratos de mayor alcance.</p>}</div><Field id="search-name" label="Nombre del perfil" value={name} setValue={setName} disabled={!canManage} placeholder="Oportunidades principales" required /><div className="space-y-2"><Label>Estado</Label><div className="flex h-10 items-center justify-between rounded-md border px-3"><span className="text-sm">Perfil activo</span><Switch checked={active} onCheckedChange={setActive} disabled={!canManage} /></div></div><div className="space-y-2 sm:col-span-2"><Label htmlFor="search-description">Descripción</Label><Textarea id="search-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canManage} rows={2} maxLength={1000} placeholder="Objetivo de este perfil…" /></div><ListField id="search-methods" label="Modalidades de contratación" value={methods} setValue={setMethods} disabled={!canManage} placeholder="Mínima cuantía" /><ListField id="search-statuses" label="Estados del proceso" value={statuses} setValue={setStatuses} disabled={!canManage} placeholder="Publicado" /><ListField id="search-contract-types" label="Tipos de contrato" value={contractTypes} setValue={setContractTypes} disabled={!canManage} placeholder="Prestación de servicios, Consultoría" /><ListField id="search-keywords" label="Palabras clave" value={keywords} setValue={setKeywords} disabled={!canManage} placeholder="energía solar, mantenimiento eléctrico" /><ListField id="excluded-keywords" label="Excluir palabras" value={excluded} setValue={setExcluded} disabled={!canManage} placeholder="interventoría, combustible" /><ListField id="search-departments" label="Departamentos" value={departments} setValue={setDepartments} disabled={!canManage} placeholder="Valle del Cauca, Cauca" /><ListField id="search-unspsc" label="Códigos UNSPSC" value={unspsc} setValue={setUnspsc} disabled={!canManage} placeholder="Códigos de tu empresa, separados por comas" /><Field id="minimum-budget" label="Presupuesto mínimo (COP)" value={minimum} setValue={setMinimum} disabled={!canManage} type="number" min="0" /><Field id="maximum-budget" label="Presupuesto máximo (COP)" value={maximum} setValue={setMaximum} disabled={!canManage} type="number" min="0" /><div className="flex items-center justify-between rounded-xl border p-3 sm:col-span-2"><div><p className="text-sm font-medium">Solo procesos abiertos</p><p className="text-xs text-slate-500">Evita mostrar convocatorias que ya cerraron.</p></div><Switch checked={onlyOpen} onCheckedChange={setOnlyOpen} disabled={!canManage} /></div>{canManage && <Button type="submit" disabled={saving} className="sm:col-span-2 sm:w-fit bg-[#0b5963] hover:bg-[#084852]">{saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar perfil</Button>}</form></CardContent></Card>;
}

function Field({ id, label, value, setValue, disabled, ...props }: { id: string; label: string; value: string; setValue: (value: string) => void; disabled: boolean } & Omit<React.ComponentProps<typeof Input>, "id" | "value" | "onChange" | "disabled">) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} onChange={(event) => setValue(event.target.value)} disabled={disabled} {...props} /></div>;
}

function ListField({ id, label, value, setValue, disabled, placeholder }: { id: string; label: string; value: string; setValue: (value: string) => void; disabled: boolean; placeholder?: string }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} onChange={(event) => setValue(event.target.value)} disabled={disabled} placeholder={placeholder} /><p className="text-xs text-slate-500">Separa varios valores con comas.</p></div>;
}
