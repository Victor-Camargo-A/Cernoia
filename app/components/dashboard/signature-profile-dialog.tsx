"use client";

import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Eraser, FileImage, Loader2, PenLine, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SignatureProfile, uploadSignatureProfile } from "@/lib/api";

type SignatureKind = "drawn" | "uploaded";

export function SignatureProfileDialog({
  open,
  onOpenChange,
  defaultName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onSaved: (signature: SignatureProfile) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<SignatureKind>("drawn");
  const [hasInk, setHasInk] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [signerName, setSignerName] = useState(defaultName);
  const [signerRole, setSignerRole] = useState("Representante legal");
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
    setHasInk(false);
  }

  useEffect(() => {
    if (!open || kind !== "drawn") return;
    const frame = requestAnimationFrame(clearCanvas);
    return () => cancelAnimationFrame(frame);
  }, [kind, open]);

  function resetForm() {
    setSignerName(defaultName);
    setSignerRole("Representante legal");
    setConsent(false);
    setFile(null);
    setKind("drawn");
    setHasInk(false);
  }

  function changeOpen(next: boolean) {
    if (saving) return;
    if (!next) resetForm();
    onOpenChange(next);
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rectangle = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rectangle.left) * (canvas.width / rectangle.width),
      y: (event.clientY - rectangle.top) * (canvas.height / rectangle.height),
    };
  }

  function beginStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const next = point(event);
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(next.x, next.y);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#082f38";
    context.lineWidth = 4.5;
  }

  function continueStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const next = point(event);
    context.lineTo(next.x, next.y);
    context.stroke();
    setHasInk(true);
  }

  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function chooseFile(next: File | null) {
    if (!next) return;
    if (!["image/png", "image/jpeg"].includes(next.type)) {
      toast.error("La firma debe ser una imagen PNG o JPG.");
      return;
    }
    if (next.size > 3 * 1024 * 1024) {
      toast.error("La imagen supera el límite de 3 MB.");
      return;
    }
    setFile(next);
  }

  async function canvasBlob() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 1));
  }

  async function save() {
    if (signerName.trim().length < 3) return toast.error("Indica el nombre completo de la persona firmante.");
    if (!signerRole.trim()) return toast.error("Indica el cargo o calidad de la persona firmante.");
    if (!consent) return toast.error("Debes aceptar el consentimiento de firma electrónica.");
    if (kind === "drawn" && !hasInk) return toast.error("Dibuja tu firma en el recuadro.");
    if (kind === "uploaded" && !file) return toast.error("Selecciona una imagen de firma.");

    setSaving(true);
    try {
      const payload = kind === "drawn" ? await canvasBlob() : file;
      if (!payload) throw new Error("No fue posible preparar la imagen de firma.");
      const data = await uploadSignatureProfile(payload, {
        filename: kind === "drawn" ? "firma-cernoia.png" : file?.name || "firma.png",
        signerName: signerName.trim(),
        signerRole: signerRole.trim(),
        kind,
      });
      onSaved(data.signature);
      window.dispatchEvent(new Event('cernoia-signature-updated'));
      resetForm();
      onOpenChange(false);
      toast.success("La firma electrónica quedó guardada de forma privada.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible guardar la firma.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configurar firma electrónica</DialogTitle>
          <DialogDescription>
            Dibuja o carga la imagen que podrá aplicarse únicamente cuando lo autorices para una propuesta concreta.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="signature-name">Nombre de la persona firmante</Label>
              <Input id="signature-name" value={signerName} onChange={(event) => setSignerName(event.target.value)} maxLength={180} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature-role">Cargo o calidad</Label>
              <Input id="signature-role" value={signerRole} onChange={(event) => setSignerRole(event.target.value)} maxLength={160} placeholder="Representante legal" />
            </div>
          </div>

          <Tabs value={kind} onValueChange={(value) => setKind(value as SignatureKind)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="drawn"><PenLine /> Dibujar</TabsTrigger>
              <TabsTrigger value="uploaded"><FileImage /> Subir imagen</TabsTrigger>
            </TabsList>
            <TabsContent value="drawn" className="mt-4 space-y-3">
              <div className="overflow-hidden rounded-2xl border-2 border-dashed border-slate-200 bg-white shadow-inner">
                <canvas
                  ref={canvasRef}
                  width={720}
                  height={240}
                  aria-label="Área para dibujar la firma"
                  className="block aspect-[3/1] w-full touch-none cursor-crosshair"
                  onPointerDown={beginStroke}
                  onPointerMove={continueStroke}
                  onPointerUp={endStroke}
                  onPointerCancel={endStroke}
                  onPointerLeave={(event) => drawingRef.current && endStroke(event)}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">Usa el ratón, el dedo o un lápiz táctil.</p>
                <Button type="button" variant="outline" size="sm" onClick={clearCanvas}><Eraser /> Limpiar</Button>
              </div>
            </TabsContent>
            <TabsContent value="uploaded" className="mt-4">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="sr-only" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex min-h-40 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-5 text-center transition hover:border-teal-400 hover:bg-teal-50/40"
              >
                <Upload className="mb-3 size-8 text-teal-700" />
                <span className="text-sm font-semibold">{file ? file.name : "Selecciona una imagen PNG o JPG"}</span>
                <span className="mt-1 text-xs text-slate-500">Fondo blanco o transparente · máximo 3 MB</span>
              </button>
            </TabsContent>
          </Tabs>

          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-teal-200 bg-teal-50/60 p-4">
            <Checkbox checked={consent} onCheckedChange={(value) => setConsent(value === true)} className="mt-0.5" />
            <span className="text-sm leading-6 text-teal-950/80">
              Autorizo el almacenamiento privado de esta firma y su uso solo en los paquetes que confirme desde mi sesión. Entiendo que debo revisar cada documento y que este mecanismo no equivale por sí solo a una firma digital certificada.
            </span>
          </label>

          <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-600">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-700" />
            La imagen, su huella SHA-256, el consentimiento y la aplicación a cada paquete quedan registrados para trazabilidad.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="button" disabled={saving} onClick={save} className="bg-[#0b5963] hover:bg-[#084852]">
            {saving ? <Loader2 className="animate-spin" /> : <PenLine />} Guardar firma
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
