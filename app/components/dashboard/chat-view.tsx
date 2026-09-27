"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileText, Loader2, MessageSquarePlus, Send, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, ChatMessage, ChatThread } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ChatView() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: ChatThread[] }>("/chat/threads");
      setLoadError("");
      setThreads(Array.isArray(data.items) ? data.items : []);
      setSelectedId((current) => current || data.items[0]?.id || "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "No fue posible abrir Chat CernoIA.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void loadThreads()); }, [loadThreads]);
  useEffect(() => {
    if (!selectedId || sending) return;
    let cancelled = false;
    apiFetch<{ items: ChatMessage[] }>(`/chat/threads/${selectedId}/messages`)
      .then((data) => { if (!cancelled) setMessages(Array.isArray(data.items) ? data.items : []); })
      .catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : "No fue posible leer la conversación."); });
    return () => { cancelled = true; };
  }, [selectedId, sending]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, sending]);

  async function createThread() {
    try {
      const data = await apiFetch<{ thread: ChatThread }>("/chat/threads", {
        method: "POST",
        body: JSON.stringify({ context_mode: "organization" }),
      });
      setThreads((current) => [data.thread, ...current]);
      setSelectedId(data.thread.id);
      setMessages([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible crear la conversación.");
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content || sending) return;
    setSending(true);
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`, role: "user", content, status: "ready", citations: [], created_at: new Date().toISOString(),
    };
    try {
      let threadId = selectedId;
      if (!threadId) {
        const created = await apiFetch<{ thread: ChatThread }>("/chat/threads", {
          method: "POST", body: JSON.stringify({ context_mode: "organization" }),
        });
        threadId = created.thread.id;
        setThreads((current) => [created.thread, ...current]);
        setSelectedId(threadId);
      }
      setPrompt("");
      setMessages((current) => [...current, optimistic]);
      const data = await apiFetch<{ user_message: ChatMessage; assistant_message: ChatMessage }>(
        `/chat/threads/${threadId}/messages`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
      setMessages((current) => [...current.filter((item) => item.id !== optimistic.id), data.user_message, data.assistant_message]);
      void loadThreads();
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setPrompt(content);
      toast.error(error instanceof Error ? error.message : "El agente no pudo responder.");
    } finally {
      setSending(false);
    }
  }

  const selected = threads.find((item) => item.id === selectedId);
  return <div className="grid min-h-[calc(100svh-8rem)] gap-4 xl:grid-cols-[290px_minmax(0,1fr)]">
    <Card className="hidden gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm xl:flex xl:flex-col">
      <div className="flex items-center justify-between border-b p-4"><div><p className="font-semibold">Conversaciones</p><p className="text-xs text-slate-500">Tu historial privado</p></div><Button size="icon-sm" onClick={createThread} disabled={sending} aria-label="Nueva conversación"><MessageSquarePlus /></Button></div>
      <ScrollArea className="h-[calc(100svh-14rem)]"><div className="space-y-1 p-2">{loading ? <p className="p-3 text-sm text-slate-500">Cargando…</p> : threads.map((thread) => <button key={thread.id} disabled={sending} onClick={() => setSelectedId(thread.id)} className={cn("w-full rounded-xl px-3 py-3 text-left transition", selectedId === thread.id ? "bg-teal-50 text-teal-950" : "hover:bg-slate-50")}><p className="truncate text-sm font-medium">{thread.title}</p><p className="mt-1 text-xs text-slate-500">{formatDate(thread.last_message_at || thread.created_at, true)}</p></button>)}</div></ScrollArea>
    </Card>

    <Card className="flex min-h-[70svh] flex-col overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
      <header className="flex items-center justify-between gap-4 border-b bg-[#082f38] px-5 py-4 text-white"><div className="flex min-w-0 items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-teal-300/15 text-teal-200"><Bot /></span><div className="min-w-0"><h2 className="truncate font-semibold">{selected?.title || "Chat CernoIA"}</h2><p className="truncate text-xs text-teal-100/70">Agente controlado con contexto de tu empresa</p></div></div><Button size="sm" variant="outline" onClick={createThread} disabled={sending} className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><MessageSquarePlus /> <span className="hidden sm:inline">Nuevo chat</span></Button></header>
      {loadError && <Alert variant="destructive" className="m-4"><AlertTitle>No pudimos cargar el historial</AlertTitle><AlertDescription>{loadError}<Button variant="outline" onClick={() => void loadThreads()}>Reintentar</Button></AlertDescription></Alert>}
      <Alert className="m-4 border-cyan-100 bg-cyan-50/70"><ShieldCheck className="text-cyan-800" /><AlertTitle>Asistente de preparación, no autoridad contractual</AlertTitle><AlertDescription>CernoIA usa únicamente el contexto autorizado. Verifica pliegos, adendas y fechas antes de tomar una decisión o presentar una oferta.</AlertDescription></Alert>
      <ScrollArea className="min-h-0 flex-1"><div className="mx-auto max-w-4xl space-y-5 px-4 py-5 sm:px-7">
        {!messages.length && !sending && <div className="py-14 text-center"><span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-800"><Bot className="size-7" /></span><h3 className="mt-4 text-lg font-semibold">Pregunta sobre tu empresa, documentos o mercado</h3><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">Por ejemplo: “¿Qué documentos debo renovar este mes?” o “Resume mis oportunidades con cierre más próximo”.</p></div>}
        {messages.map((message) => <div key={message.id} className={cn("flex gap-3", message.role === "user" && "justify-end")}>
          {message.role !== "user" && <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><Bot className="size-4" /></span>}
          <div className={cn("max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6", message.role === "user" ? "bg-[#0b5963] text-white" : "border border-slate-200 bg-slate-50 text-slate-800")}><p className="whitespace-pre-wrap">{message.content}</p>{Array.isArray(message.citations) && message.citations.length > 0 && <div className="mt-3 border-t border-slate-200 pt-3"><p className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><FileText className="size-3.5" /> Fuentes del contexto</p><div className="flex flex-wrap gap-2">{message.citations.map((citation, index) => citation.url?.startsWith("http") ? <a key={`${citation.title}-${index}`} href={citation.url} target="_blank" rel="noreferrer" className="rounded-full border bg-white px-2.5 py-1 text-xs text-teal-800 hover:underline">{citation.title}</a> : <span key={`${citation.title}-${index}`} className="rounded-full border bg-white px-2.5 py-1 text-xs">{citation.title}</span>)}</div></div>}</div>
          {message.role === "user" && <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><UserRound className="size-4" /></span>}
        </div>)}
        {sending && <div className="flex gap-3"><span className="flex size-8 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><Bot className="size-4" /></span><div className="flex items-center gap-2 rounded-2xl border bg-slate-50 px-4 py-3 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" /> Consultando el contexto autorizado…</div></div>}
        <div ref={endRef} />
      </div></ScrollArea>
      <form onSubmit={send} className="border-t bg-white p-4"><div className="mx-auto flex max-w-4xl items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2 focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-100"><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Escribe tu pregunta…" maxLength={4000} rows={2} className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" /><Button type="submit" size="icon" disabled={!prompt.trim() || sending} className="shrink-0 rounded-xl bg-[#0b5963] hover:bg-[#084852]" aria-label="Enviar"><Send /></Button></div><p className="mt-2 text-center text-[11px] text-slate-400">Tus conversaciones se aíslan por empresa y usuario. Máximo 20 consultas por hora por defecto.</p></form>
    </Card>
  </div>;
}
