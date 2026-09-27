"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, Clock3, Download, FileCheck2, FileUp, Loader2, MoreHorizontal,
  Pencil, Plus, ShieldCheck, Trash2, UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, OrganizationDocument, uploadOrganizationDocument, User } from "@/lib/api";
import { DOCUMENT_TYPES } from "@/lib/document-types";
import { formatDate } from "@/lib/format";
import { EmptyState, ErrorState, formatFileSize, LoadingList, StatusBadge } from "./shared";
import { DocumentGovernancePanel } from "./document-governance-panel";

const documentTypes = DOCUMENT_TYPES;

const documentTypeLabels = Object.fromEntries(documentTypes);

export function DocumentsView({ user }: { user: User }) {
  const [items, setItems] = useState<OrganizationDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const [uploadProgress, setUploadProgress] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [documentName, setDocumentName] = useState("");
  const [documentType, setDocumentType] = useState("auto_detect");
  const [description, setDescription] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [editTarget, setEditTarget] = useState<OrganizationDocument | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrganizationDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = user.role !== "viewer";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<{ items: OrganizationDocument[] }>("/documents");
      setItems(data.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No fue posible consultar los documentos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("cernoia:refresh", refresh);
    return () => window.removeEventListener("cernoia:refresh", refresh);
  }, [load]);

  useEffect(() => {
    if (!items.length) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const counts = useMemo(() => ({
    valid: items.filter((item) => item.validity_status === "valid").length,
    expiring: items.filter((item) => item.validity_status === "expiring").length,
    expired: items.filter((item) => item.validity_status === "expired").length,
    unknown: items.filter((item) => item.validity_status === "unknown").length,
  }), [items]);

  function selectFiles(selected: FileList | null) {
    const next=Array.from(selected ?? []);
    if (!next.length) return;
    if (next.length>25) return toast.error("Selecciona hasta 25 archivos por carga.");
    if (next.some(f=>f.size>20*1024*1024)) return toast.error("Cada archivo debe pesar como máximo 20 MB.");
    setFiles(next);
    setDocumentName(next.length===1?next[0].name.replace(/\.[^.]+$/, ""):"");
  }

  function resetUpload() {
    setFiles([]);
    setUploadProgress("");
    setDocumentName("");
    setDocumentType("auto_detect");
    setDescription("");
    setIssueDate("");
    setExpiryDate("");
    setFileInputKey((value) => value + 1);
  }

  async function submitUpload(event: FormEvent) {
    event.preventDefault();
    if (!file) return toast.error("Selecciona el archivo que deseas cargar.");
    if (files.length===1&&!documentName.trim()) return toast.error("Escribe un nombre para el documento.");
    setUploading(true);
    const failed:File[]=[];let succeeded=0;
    try {
      for (const [index,item] of files.entries()) {
        setUploadProgress(`${index+1} de ${files.length}: ${item.name}`);
        try {
          await uploadOrganizationDocument(item,{name:files.length===1?documentName.trim():item.name.replace(/\.[^.]+$/, "").slice(0,180),type:files.length>1?"auto_detect":documentType,description:description.trim(),issueDate:files.length===1?issueDate:"",expiryDate:files.length===1?expiryDate:""});
          succeeded++;
        } catch(e) {
          failed.push(item);
          toast.error(`${item.name}: ${e instanceof Error?e.message:"No fue posible cargar el archivo."}`);
        }
      }
      if(succeeded) toast.success(`${succeeded} documento(s) cargados. La matriz empresarial se actualizará automáticamente.`);
      if(failed.length){setFiles(failed);if(failed.length===1)setDocumentName(failed[0].name.replace(/\.[^.]+$/, "").slice(0,180));}
      else {setUploadOpen(false);resetUpload();}
      await load();
    } finally {setUploading(false);setUploadProgress("");}
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault(); if (!editTarget) return; setSavingEdit(true);
    try {
      await apiFetch(`/documents/${editTarget.id}/metadata`, {method:"PATCH", body:JSON.stringify({document_name:documentName,document_type:documentType,issue_date:issueDate,expiration_date:expiryDate})});
      setEditTarget(null); resetUpload(); await load(); toast.success("Documento actualizado. La matriz se actualizará automáticamente.");
    } catch (error) {toast.error(error instanceof Error?error.message:"No fue posible guardar.");}
    finally {setSavingEdit(false);}
  }

  async function deleteDocument() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/documents/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("El documento fue retirado del repositorio.");
      setDeleteTarget(null);
      await load();
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "No fue posible retirar el documento.");
    } finally {
      setDeleting(false);
    }
  }

  function downloadUrl(document: OrganizationDocument) {
    return document.storage_url || `/api/documents/${document.id}/file`;
  }

  const summary = [
    { label: "Vigentes", value: counts.valid, icon: CheckCircle2, style: "bg-emerald-50 text-emerald-700" },
    { label: "Por vencer", value: counts.expiring, icon: Clock3, style: "bg-amber-50 text-amber-700" },
    { label: "Vencidos", value: counts.expired, icon: AlertCircle, style: "bg-rose-50 text-rose-700" },
    { label: "Sin vigencia", value: counts.unknown, icon: ShieldCheck, style: "bg-slate-100 text-slate-600" },
  ];

  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm text-teal-900">Los documentos son opcionales para ingresar. Carga los soportes de tu empresa, representante, experiencia, finanzas y equipo: cada cambio actualizará automáticamente la Matriz empresarial IA.</p>
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        {summary.map((item) => <Card key={item.label} className="border-slate-200 bg-white py-4 shadow-sm"><CardContent className="flex items-center justify-between gap-3 px-4 sm:px-5"><div><p className="text-xs font-medium text-slate-500 sm:text-sm">{item.label}</p><p className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{item.value}</p></div><span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${item.style}`}><item.icon className="size-5" /></span></CardContent></Card>)}
      </section>

      <DocumentGovernancePanel canEdit={canEdit} canManage={user.role === "owner" || user.role === "admin"} onUpdated={load} />

      <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
          <div><h2 className="font-semibold">Repositorio empresarial</h2><p className="mt-0.5 text-xs text-slate-500">Archivos, validación y vigencias en un solo lugar.</p></div>
          {canEdit && <Button onClick={() => setUploadOpen(true)} className="bg-[#0b5963] text-white hover:bg-[#084852]"><Plus /> Cargar documentos</Button>}
        </div>
        {loading ? <LoadingList /> : error ? <div className="p-5"><ErrorState message={error} retry={load} /></div> : items.length === 0 ? (
          <div className="p-5"><EmptyState title="Aún no hay documentos" description="Carga el primer archivo empresarial para controlar su vigencia y compararlo con los requisitos." action={canEdit ? <Button onClick={() => setUploadOpen(true)}><UploadCloud /> Cargar primer documento</Button> : undefined} /></div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table><TableHeader><TableRow><TableHead className="pl-5">Documento</TableHead><TableHead>Tipo</TableHead><TableHead>Vencimiento</TableHead><TableHead>Validación</TableHead><TableHead>Vigencia</TableHead><TableHead className="w-12 pr-5" /></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell className="max-w-[360px] pl-5"><div className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><FileCheck2 className="size-4" /></span><div className="min-w-0"><p className="truncate font-medium">{item.document_name}</p><p className="mt-1 truncate text-xs text-slate-500">{item.original_filename || item.mime_type || "Archivo"} · {formatFileSize(item.file_size_bytes)}</p></div></div></TableCell><TableCell className="max-w-52"><span className="line-clamp-2 text-sm">{item.document_type_label || documentTypeLabels[item.document_type] || item.document_type}</span></TableCell><TableCell><p>{item.expiry_date ? formatDate(item.expiry_date) : "No indicado"}</p>{item.expiration_source === "policy" && <p className="text-xs text-slate-500">Calculado según política</p>}{item.issue_date && <p className="mt-1 text-xs text-slate-500">Expedido {formatDate(item.issue_date)}</p>}</TableCell><TableCell><StatusBadge status={["queued","processing","retry"].includes(item.metadata_status || "") ? "metadata_processing" : item.verification_status === "verified" ? "verified" : item.review_status === "pending" && item.extraction_status === "extracted" ? "review_required" : item.extraction_status} /></TableCell><TableCell><StatusBadge status={item.validity_status} /></TableCell><TableCell className="pr-5"><DocumentMenu document={item} downloadUrl={downloadUrl(item)} canEdit={canEdit} onEdit={() => {setEditTarget(item);setDocumentName(item.document_name);setDocumentType(item.document_type);setIssueDate(item.issue_date?.slice(0,10)||"");setExpiryDate(item.expiry_date?.slice(0,10)||"");}} onDelete={() => setDeleteTarget(item)} /></TableCell></TableRow>)}</TableBody></Table>
            </div>
            <div className="divide-y md:hidden">{items.map((item) => <div key={item.id} className="p-4"><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-800"><FileCheck2 className="size-5" /></span><div className="min-w-0 flex-1"><p className="line-clamp-2 font-semibold leading-5">{item.document_name}</p><p className="mt-1 truncate text-xs text-slate-500">{item.document_type_label || documentTypeLabels[item.document_type] || item.document_type}</p></div><DocumentMenu document={item} downloadUrl={downloadUrl(item)} canEdit={canEdit} onEdit={() => {setEditTarget(item);setDocumentName(item.document_name);setDocumentType(item.document_type);setIssueDate(item.issue_date?.slice(0,10)||"");setExpiryDate(item.expiry_date?.slice(0,10)||"");}} onDelete={() => setDeleteTarget(item)} /></div><div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={item.validity_status} /><StatusBadge status={["queued","processing","retry"].includes(item.metadata_status || "") ? "metadata_processing" : item.verification_status === "verified" ? "verified" : item.review_status === "pending" && item.extraction_status === "extracted" ? "review_required" : item.extraction_status} /><span className="text-xs text-slate-500">Vence {formatDate(item.expiry_date)}</span></div></div>)}</div>
          </>
        )}
      </Card>

      <Dialog open={uploadOpen} onOpenChange={(open) => { if (!uploading) { setUploadOpen(open); if (!open) resetUpload(); } }}>
        <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Cargar documentos empresariales</DialogTitle><DialogDescription>Selecciona o arrastra hasta 25 archivos de distintos tipos. CernoIA leerá cada documento para identificar su nombre y fecha de expedición y actualizar tu matriz. Podrás corregir los datos después.</DialogDescription></DialogHeader>
          <form onSubmit={submitUpload} className="space-y-5">
            <input key={fileInputKey} ref={fileRef} type="file" multiple disabled={uploading} className="sr-only" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" onChange={(event) => selectFiles(event.target.files)} />
            <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!uploading) selectFiles(event.dataTransfer.files); }} className="flex min-h-36 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-5 text-center transition hover:border-teal-400 hover:bg-teal-50/40">
              {file ? <><FileCheck2 className="mb-3 size-8 text-teal-700" /><span className="max-w-full truncate text-sm font-semibold">{files.length>1?`${files.length} archivos seleccionados`:file.name}</span><span className="mt-1 text-xs text-slate-500">{formatFileSize(file.size)} · Clic para cambiar</span></> : <><FileUp className="mb-3 size-8 text-teal-700" /><span className="text-sm font-semibold">Selecciona o arrastra tus archivos</span><span className="mt-1 text-xs text-slate-500">PDF, Word, Excel, PNG o JPG · máximo 20 MB</span></>}
            </button>
            <div className="grid gap-4 sm:grid-cols-2">
              {files.length>1&&<ul className="space-y-1 text-xs text-slate-500 sm:col-span-2">{files.map((f,i)=><li key={`${f.name}-${i}`}>{f.name}</li>)}</ul>}
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="document-name">Nombre visible</Label><Input id="document-name" disabled={files.length>1||uploading} value={files.length>1?"Se usará el nombre de cada archivo":documentName} onChange={(event) => setDocumentName(event.target.value)} maxLength={180} placeholder="Ej. Cámara de Comercio — septiembre 2026" required={files.length===1} /></div>
              <div className="space-y-2 sm:col-span-2"><Label>Tipo documental</Label><Select disabled={uploading || files.length>1} value={files.length>1?"auto_detect":documentType} onValueChange={(value) => { if (value) setDocumentType(value); }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto_detect">Detectar automáticamente</SelectItem>{documentTypes.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="issue-date">Fecha de expedición</Label><Input id="issue-date" disabled={uploading || files.length>1} type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} /><p className="text-xs text-slate-500">Si no la conoces, el análisis intentará identificarla en el archivo.</p></div>
              <div className="space-y-2"><Label htmlFor="expiry-date">Fecha de vencimiento</Label><Input id="expiry-date" disabled={uploading || files.length>1} type="date" value={expiryDate} min={issueDate || undefined} onChange={(event) => setExpiryDate(event.target.value)} /><p className="text-xs text-slate-500">Opcional: CernoIA intentará extraerla o calcularla según la política.</p></div>
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="document-description">Descripción</Label><Textarea id="document-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} placeholder="Contexto o notas para el equipo…" /></div>
            </div>
            {uploadProgress&&<p role="status" className="text-sm text-teal-800">Cargando {uploadProgress}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={uploading} onClick={() => setUploadOpen(false)}>Cancelar</Button><Button type="submit" disabled={uploading || !file} className="bg-[#0b5963] hover:bg-[#084852]">{uploading ? <Loader2 className="animate-spin" /> : <UploadCloud />} {uploading ? "Cargando…" : "Cargar y procesar"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onOpenChange={open=>{if(!open&&!savingEdit){setEditTarget(null);resetUpload();}}}>
        <DialogContent><DialogHeader><DialogTitle>Editar documento</DialogTitle><DialogDescription>Los cambios actualizarán la matriz documental.</DialogDescription></DialogHeader>
          <form onSubmit={saveEdit} className="space-y-4">
            <Label htmlFor="edit-name">Nombre</Label><Input id="edit-name" value={documentName} onChange={e=>setDocumentName(e.target.value)} required maxLength={180}/>
            <Label htmlFor="edit-type">Tipo</Label><Select value={documentType} onValueChange={v=>{ if(v) setDocumentType(v); }}><SelectTrigger id="edit-type"><SelectValue/></SelectTrigger><SelectContent>{!documentTypes.some(([code])=>code===documentType)&&<SelectItem value={documentType}>{editTarget?.document_type_label || documentType}</SelectItem>}{documentTypes.map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
            <Label htmlFor="edit-issue">Fecha de expedición</Label><Input id="edit-issue" type="date" value={issueDate} onChange={e=>setIssueDate(e.target.value)}/>
            <Label htmlFor="edit-expiry">Fecha de vencimiento</Label><Input id="edit-expiry" type="date" min={issueDate||undefined} value={expiryDate} onChange={e=>setExpiryDate(e.target.value)}/>
            <DialogFooter><Button disabled={savingEdit}>{savingEdit?"Guardando…":"Guardar cambios"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>¿Retirar este documento?</AlertDialogTitle><AlertDialogDescription>“{deleteTarget?.document_name}” dejará de estar disponible para nuevas validaciones. La acción quedará registrada en la auditoría.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={deleting} onClick={(event) => { event.preventDefault(); void deleteDocument(); }}>{deleting && <Loader2 className="animate-spin" />} Retirar</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DocumentMenu({ downloadUrl, canEdit, onEdit, onDelete }: { document: OrganizationDocument; downloadUrl: string; canEdit: boolean; onEdit: () => void; onDelete: () => void }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Acciones del documento"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem asChild><a href={downloadUrl} target="_blank" rel="noreferrer"><Download /> Descargar</a></DropdownMenuItem>{canEdit && <DropdownMenuItem onClick={onEdit}><Pencil /> Editar datos</DropdownMenuItem>}{canEdit && <DropdownMenuItem className="text-rose-700 focus:text-rose-700" onClick={onDelete}><Trash2 /> Retirar</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>;
}
