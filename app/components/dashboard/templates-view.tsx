"use client";
import {DocumentViewer,type DocumentViewerTarget} from "./document-viewer";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Download, FileCog, FilePlus2, FileText, Loader2, Settings2, Sparkles, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  apiFetch,
  DocumentTemplate,
  GeneratedTemplateDocument,
  Opportunity,
  uploadDocumentTemplate,
  User,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import { EmptyState, formatFileSize, StatusBadge } from "./shared";

const contextFields = [
  ["organization_name", "Nombre comercial"], ["legal_name", "Razón social"], ["tax_id", "NIT"],
  ["organization_city", "Ciudad de la empresa"], ["organization_department", "Departamento de la empresa"],
  ["organization_website", "Sitio web"], ["organization_type", "Tipo de empresa"],
  ["representative_name", "Nombre del representante"], ["representative_email", "Correo del representante"],
  ["process_reference", "Referencia del proceso"], ["process_name", "Nombre del proceso"],
  ["entity_name", "Entidad contratante"], ["entity_nit", "NIT de la entidad"],
  ["process_city", "Ciudad del proceso"], ["process_department", "Departamento del proceso"],
  ["base_price", "Presupuesto base"], ["response_deadline", "Fecha límite"], ["process_url", "URL SECOP"],
  ["date_today", "Fecha actual"],
] as const;

export function TemplatesView({ user }: { user: User }) {
  const [viewer,setViewer]=useState<DocumentViewerTarget|null>(null);
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [generated, setGenerated] = useState<GeneratedTemplateDocument[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [generationTemplate, setGenerationTemplate] = useState<DocumentTemplate | null>(null);
  const [processId, setProcessId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [mappingTemplate, setMappingTemplate] = useState<DocumentTemplate | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [savingMapping, setSavingMapping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = user.role !== "viewer";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [templateData, opportunityData] = await Promise.all([
        apiFetch<{ templates: DocumentTemplate[]; generated: GeneratedTemplateDocument[] }>("/templates"),
        apiFetch<{ items: Opportunity[] }>("/opportunities?limit=100&stage=preparing"),
      ]);
      setTemplates(templateData.templates); setGenerated(templateData.generated); setOpportunities(opportunityData.items);
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible cargar las plantillas."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return toast.error("Selecciona un DOCX o PDF con campos editables.");
    setUploading(true);
    try {
      await uploadDocumentTemplate(file, { name, description, scope: "organization" });
      toast.success("Plantilla cargada y campos detectados.");
      setUploadOpen(false); setFile(null); setName(""); setDescription(""); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible cargar la plantilla."); }
    finally { setUploading(false); }
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!generationTemplate) return;
    setGenerating(true);
    try {
      const result = await apiFetch<{ generated: GeneratedTemplateDocument }>(`/templates/${generationTemplate.id}/generate`, {
        method: "POST", body: JSON.stringify({ process_id: processId || null }),
      });
      setGenerated((current) => [{ ...result.generated, template_name: generationTemplate.name, process_reference: opportunities.find((item) => item.process_id === processId)?.reference ?? null }, ...current]);
      setGenerationTemplate(null); setProcessId("");
      toast.success(result.generated.status === "needs_review" ? "Documento generado; revisa los campos señalados." : "Documento diligenciado y listo para descargar.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible diligenciar el documento."); }
    finally { setGenerating(false); }
  }

  function configure(template: DocumentTemplate) {
    setMappingTemplate(template);
    setMapping(Object.fromEntries(template.field_schema.map((field) => [field.name, template.field_mapping?.[field.name] ?? field.name])));
  }

  async function saveMapping() {
    if (!mappingTemplate) return;
    setSavingMapping(true);
    try {
      await apiFetch(`/templates/${mappingTemplate.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: mappingTemplate.name,
          description: mappingTemplate.description,
          status: mappingTemplate.status,
          field_mapping: mapping,
          field_schema: mappingTemplate.field_schema,
        }),
      });
      setTemplates((current) => current.map((item) => item.id === mappingTemplate.id ? { ...item, field_mapping: mapping } : item));
      setMappingTemplate(null); toast.success("Correspondencias guardadas.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "No fue posible guardar la configuración."); }
    finally { setSavingMapping(false); }
  }

  return <div className="space-y-5">
    <Card className="border-slate-200 bg-[#082f38] text-white shadow-sm"><CardContent className="flex flex-wrap items-center justify-between gap-6 p-6"><div><div className="flex items-center gap-2 text-sm text-teal-200"><Sparkles className="size-4" /> Automatización documental</div><h2 className="mt-2 text-2xl font-semibold">Diligencia formatos sin copiar datos una y otra vez</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Carga un DOCX con marcadores como <code className="rounded bg-white/10 px-1.5 py-0.5">{"{legal_name}"}</code> o un PDF con campos editables. CernoIA completa los datos de empresa y proceso.</p></div>{canEdit && <Button onClick={() => setUploadOpen(true)} className="bg-teal-300 text-slate-950 hover:bg-teal-200"><FilePlus2 /> Nueva plantilla</Button>}</CardContent></Card>
    <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><h3 className="font-semibold">Biblioteca de formatos</h3><p className="mt-1 text-xs text-slate-500">Plantillas privadas de tu empresa y formatos de entidades.</p></div>{loading ? <p className="p-8 text-sm text-slate-500">Cargando…</p> : templates.length ? <div className="divide-y">{templates.map((template) => <div key={template.id} className="flex flex-wrap items-center gap-4 p-4"><span className="flex size-11 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-800"><FileCog className="size-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-semibold">{template.name}</p><Badge variant="outline">{template.template_type === "docx" ? "DOCX" : template.template_type === "xlsx" ? "XLSX" : "PDF"}</Badge></div><p className="mt-1 text-xs text-slate-500">{template.field_schema.length} campos · {formatFileSize(template.file_size_bytes)} · {formatDate(template.updated_at)}</p></div><Button size="sm" variant="outline" onClick={()=>setViewer({title:template.name,beforeEndpoint:`/template-versions/${template.version_id}/preview`})}>Ver original</Button>{canEdit && <Button size="sm" variant="outline" onClick={() => configure(template)}><Settings2 /> Campos</Button>}{canEdit && <Button size="sm" onClick={() => setGenerationTemplate(template)} className="bg-[#0b5963] hover:bg-[#084852]"><Sparkles /> Diligenciar</Button>}</div>)}</div> : <div className="p-5"><EmptyState title="No hay plantillas" description="Carga un formato oficial o empresarial para empezar a diligenciarlo con datos verificados." /></div>}</Card>
      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm"><div className="border-b p-5"><h3 className="font-semibold">Documentos generados</h3><p className="mt-1 text-xs text-slate-500">Revisa siempre el resultado antes de usarlo.</p></div><ScrollArea className="h-[460px]"><div className="divide-y">{generated.length ? generated.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 p-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><FileText className="size-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{item.template_name}</p><p className="mt-1 truncate text-xs text-slate-500">{item.process_reference || "Sin proceso"} · {formatDate(item.generated_at || item.created_at, true)}</p></div><StatusBadge status={item.status} /><Button size="sm" variant="outline" onClick={()=>setViewer({title:item.template_name,beforeEndpoint:`/template-versions/${item.template_version_id}/preview`,afterDocumentId:item.id})}>Antes y después</Button>{item.storage_url && <Button asChild variant="ghost" size="icon-sm"><a href={item.storage_url} target="_blank" rel="noreferrer" aria-label="Descargar"><Download /></a></Button>}</div>) : <p className="p-8 text-center text-sm text-slate-500">Todavía no hay archivos generados.</p>}</div></ScrollArea></Card>
      <DocumentViewer target={viewer} onClose={()=>setViewer(null)}/>
    </div>

    <Dialog open={uploadOpen} onOpenChange={(open) => !uploading && setUploadOpen(open)}><DialogContent><DialogHeader><DialogTitle>Cargar plantilla</DialogTitle><DialogDescription>DOCX con marcadores o PDF con campos de formulario. Máximo 10 MB.</DialogDescription></DialogHeader><form onSubmit={upload} className="space-y-4"><input ref={fileRef} type="file" accept=".docx,.pdf" className="sr-only" onChange={(event) => { const next = event.target.files?.[0] ?? null; setFile(next); if (next && !name) setName(next.name.replace(/\.[^.]+$/, "")); }} /><button type="button" onClick={() => fileRef.current?.click()} className="flex min-h-28 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-slate-50"><UploadCloud className="mb-2 size-7 text-teal-700" /><span className="text-sm font-semibold">{file?.name || "Seleccionar DOCX o PDF"}</span>{file && <span className="mt-1 text-xs text-slate-500">{formatFileSize(file.size)}</span>}</button><div className="space-y-2"><Label htmlFor="template-name">Nombre</Label><Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={180} /></div><div className="space-y-2"><Label htmlFor="template-description">Descripción</Label><Textarea id="template-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setUploadOpen(false)}>Cancelar</Button><Button type="submit" disabled={!file || !name || uploading}>{uploading ? <Loader2 className="animate-spin" /> : <UploadCloud />} Analizar plantilla</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={Boolean(generationTemplate)} onOpenChange={(open) => !open && !generating && setGenerationTemplate(null)}><DialogContent><DialogHeader><DialogTitle>Diligenciar {generationTemplate?.name}</DialogTitle><DialogDescription>Selecciona una oportunidad. Los datos de empresa y representante se toman del perfil validado.</DialogDescription></DialogHeader><form onSubmit={generate} className="space-y-4"><div className="space-y-2"><Label>Oportunidad</Label><Select value={processId || "none"} onValueChange={(value) => setProcessId(value === "none" || !value ? "" : value)}><SelectTrigger className="w-full"><SelectValue placeholder="Seleccionar oportunidad" /></SelectTrigger><SelectContent><SelectItem value="none">Documento general de empresa</SelectItem>{opportunities.map((item) => <SelectItem key={item.process_id} value={item.process_id}>{item.reference || item.process_name || item.process_id}</SelectItem>)}</SelectContent></Select></div><div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">El archivo se genera como borrador. Verifica campos, anexos, adendas y la exigencia de firma antes de presentarlo.</div><DialogFooter><Button type="button" variant="outline" onClick={() => setGenerationTemplate(null)}>Cancelar</Button><Button type="submit" disabled={generating}>{generating ? <Loader2 className="animate-spin" /> : <Sparkles />} Generar y revisar</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={Boolean(mappingTemplate)} onOpenChange={(open) => !open && !savingMapping && setMappingTemplate(null)}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Correspondencia de campos</DialogTitle><DialogDescription>Indica qué dato debe llenar cada campo encontrado en la plantilla.</DialogDescription></DialogHeader><ScrollArea className="max-h-[55svh]"><div className="space-y-3 pr-4">{mappingTemplate?.field_schema.map((field) => <div key={field.name} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_1.25fr] sm:items-center"><div><p className="text-sm font-semibold">{field.name}</p><p className="text-xs text-slate-500">{field.type}</p></div><Select value={mapping[field.name] || "none"} onValueChange={(value) => setMapping((current) => ({ ...current, [field.name]: value === "none" || !value ? "" : value }))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Dejar vacío</SelectItem>{contextFields.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>)}</div></ScrollArea><DialogFooter><Button variant="outline" onClick={() => setMappingTemplate(null)}>Cancelar</Button><Button onClick={saveMapping} disabled={savingMapping}>{savingMapping && <Loader2 className="animate-spin" />} Guardar correspondencias</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
