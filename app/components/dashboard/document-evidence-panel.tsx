"use client";
import {type AnnexCatalog} from '@/lib/bids';
import { useState } from 'react';
import { Loader2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Requirement, uploadOrganizationDocument } from '@/lib/api';

export type DocumentReadiness = {
  suggested: {type:string;label:string;state:string;document_id:string|null}[];
  documents: {id:string;document_name:string;state:string}[];
  note:string;
};
const labels:Record<string,string>={missing:'Falta cargar',expired:'Vencido',processing:'Extracción pendiente o en curso',needs_review:'Requiere revisión',pending_review:'Cargado; falta validar',available:'Datos disponibles'};
export function DocumentEvidencePanel({readiness,requirements,canEdit,onUploaded,catalog,onPrepare}:{readiness:DocumentReadiness;requirements:Requirement[];canEdit:boolean;onUploaded:()=>Promise<void>;catalog?:AnnexCatalog|null;onPrepare?:()=>void}) {
  const [uploadType,setUploadType]=useState('');
  const [name,setName]=useState('');
  const [files,setFiles]=useState<File[]>([]);
  const file=files[0]??null;
  const [uploading,setUploading]=useState(false);
  const missing=requirements.filter(r=>r.document_match_status!=='matched' || (r.organization_document_expiry && new Date(r.organization_document_expiry)<new Date()));
  function choose(type:string,label:string){setUploadType(/^[a-z0-9_]{2,80}$/.test(type)?type:'other_document');setName(label);setFiles([]);}
  async function upload(){
    if(!file) return toast.error('Selecciona el documento que respalda este requisito.');
    setUploading(true);
    try {
      const failed:File[]=[];
      for(const item of files){try {await uploadOrganizationDocument(item,{name:item.name.replace(/\.[^.]+$/, '').slice(0,180),type:'auto_detect'});}catch(error){failed.push(item);toast.error(`${item.name}: ${error instanceof Error?error.message:'Error de carga'}`);}}
      setFiles(failed);
      if(failed.length){await onUploaded();return;}
      toast.success('Documento cargado. Espera la extracción y solicita el reanálisis para incorporar la evidencia.');setUploadType('');await onUploaded();}
    catch(error){toast.error(error instanceof Error?error.message:'No fue posible cargar el documento.');}
    finally{setUploading(false);}
  }
  return <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50/50 p-5"><h3 className="font-semibold">Documentos para sustentar el análisis</h3><p className="text-sm leading-6 text-slate-600">{readiness.note}</p>
    <div className="space-y-2">{readiness.suggested.map(item=><div key={item.type} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white p-3 text-sm"><div><p className="font-medium">{item.label}</p><p className="mt-1 text-xs text-slate-600">{labels[item.state]??item.state}</p></div>{canEdit && ['missing','expired','needs_review'].includes(item.state)&&<Button size="sm" variant="outline" onClick={()=>choose(item.type,item.label)}><UploadCloud/> Cargar soporte</Button>}</div>)}</div>
    {requirements.length===0?<p className="text-sm text-amber-900">Todavía no se extrajeron los requisitos del contratante. La lista anterior orienta el perfil; no sustituye la revisión de los pliegos.</p>:<div><p className="text-sm font-semibold">{missing.length} requisitos del proceso sin soporte coincidente vigente</p>{missing.map(r=><div key={r.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"><span>{r.requirement_name}{r.mandatory?' · obligatorio':''}</span>{catalog?.entries.some(e=>e.requirement_ids.includes(r.id))&&<Button size="sm" variant="outline" onClick={onPrepare}>Preparar formato oficial</Button>}{canEdit&&<Button size="sm" variant="outline" onClick={()=>choose(r.normalized_document_type||'other_document',r.requirement_name)}>Cargar documento</Button>}</div>)}</div>}
    {readiness.documents.some(d=>['processing','pending_review','needs_review','expired'].includes(d.state))&&<div className="text-xs leading-6 text-slate-600">{readiness.documents.filter(d=>d.state!=='available').map(d=><p key={d.id}>{d.document_name}: {labels[d.state]??d.state}</p>)}</div>}
    {uploadType&&<div className="space-y-3 rounded-xl border bg-white p-4"><Label htmlFor="evidence-file">Archivo empresarial</Label><Input id="evidence-file" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" onChange={e=>{const next=Array.from(e.target.files??[]);if(next.length>25||next.some(f=>f.size>20*1024*1024)){toast.error("Máximo 25 archivos de 20 MB cada uno.");return;}setFiles(next);}} disabled={uploading}/><p className="text-sm text-slate-500">{files.length} archivos seleccionados. El nombre, tipo y fechas se identificarán en cada documento.</p><div className="flex gap-2"><Button onClick={upload} disabled={uploading||!file||!name.trim()}>{uploading?<Loader2 className="animate-spin"/>:<UploadCloud/>} Cargar y procesar</Button><Button variant="ghost" onClick={()=>setUploadType('')} disabled={uploading}>Cancelar</Button></div></div>}
  </section>;
}
