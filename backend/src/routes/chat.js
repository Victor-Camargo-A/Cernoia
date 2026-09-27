import { Router } from "express";
import { config } from "../config.js";
import { query } from "../db.js";
import { writeAudit } from "../audit.js";
import { requireAuth } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/subscription.js";
import { runWorkflow } from "../services/n8n.js";

export const chatRouter = Router();
chatRouter.use(requireAuth, requireEntitlement("chat_cernoia"));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_MODES = new Set(["organization", "opportunity", "documents", "market"]);

function normalizeWorkflowResponse(value) {
  const source = Array.isArray(value) ? value[0] ?? {} : value ?? {};
  const nested = source?.data ?? source?.result ?? source;
  const answer = String(
    nested?.answer ?? nested?.output ?? nested?.message ?? nested?.text ?? "",
  ).trim();
  const citations = Array.isArray(nested?.citations)
    ? nested.citations.slice(0, 20).map((citation) => ({
        title: String(citation?.title ?? citation?.label ?? "Fuente").slice(0, 200),
        url: String(citation?.url ?? "").slice(0, 2000),
        process_id: String(citation?.process_id ?? "").slice(0, 80),
      }))
    : [];
  return {
    answer: answer.slice(0, 12000),
    citations,
    modelProvider: String(nested?.model_provider ?? "google").slice(0, 80),
    modelName: String(nested?.model_name ?? "gemini").slice(0, 120),
    executionId: String(nested?.execution_id ?? source?.executionId ?? "").slice(0, 160),
    quota: nested?.quota && typeof nested.quota === "object" ? nested.quota : {},
  };
}

chatRouter.get("/chat/threads", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT thread.id, thread.title, thread.status, thread.context_mode, thread.process_id,
              thread.last_message_at, thread.created_at, thread.updated_at,
              process.reference AS process_reference, process.process_name
       FROM saas.chat_threads thread
       LEFT JOIN secop.processes process ON process.id = thread.process_id
       WHERE thread.organization_id = $1 AND thread.created_by_user_id = $2
       ORDER BY thread.last_message_at DESC NULLS LAST, thread.created_at DESC
       LIMIT 100`,
      [req.user.organization_id, req.user.id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/chat/threads", async (req, res, next) => {
  try {
    const contextMode = String(req.body?.context_mode ?? "organization");
    const processId = req.body?.process_id ? String(req.body.process_id) : null;
    if (!CONTEXT_MODES.has(contextMode)) return res.status(400).json({ error: "Contexto de conversación no válido." });
    if (processId && !UUID_PATTERN.test(processId)) return res.status(400).json({ error: "La oportunidad no es válida." });
    if (contextMode === "opportunity") {
      const access = await query(
        `SELECT 1 FROM saas.process_matches
         WHERE organization_id = $1 AND process_id = $2 LIMIT 1`,
        [req.user.organization_id, processId],
      );
      if (!access.rowCount) return res.status(404).json({ error: "Oportunidad no encontrada." });
    }
    const result = await query(
      `INSERT INTO saas.chat_threads
         (organization_id, created_by_user_id, title, context_mode, process_id)
       VALUES ($1, $2, 'Nueva conversación', $3, $4)
       RETURNING *`,
      [req.user.organization_id, req.user.id, contextMode, processId],
    );
    res.status(201).json({ thread: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/chat/threads/:threadId/messages", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT message.id, message.role, message.content, message.status, message.citations,
              message.model_provider, message.model_name, message.error_message, message.created_at
       FROM saas.chat_messages message
       JOIN saas.chat_threads thread ON thread.id = message.thread_id
       WHERE message.thread_id = $1 AND message.organization_id = $2
         AND thread.created_by_user_id = $3
       ORDER BY message.created_at ASC
       LIMIT 500`,
      [req.params.threadId, req.user.organization_id, req.user.id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/chat/threads/:threadId/messages", async (req, res, next) => {
  let userMessage = null;
  try {
    const content = String(req.body?.content ?? "").trim();
    if (!content || content.length > config.chatMaxPromptChars) {
      return res.status(400).json({ error: `Escribe un mensaje de máximo ${config.chatMaxPromptChars} caracteres.` });
    }
    const [threadResult, usageResult] = await Promise.all([
      query(
        `SELECT id, title, context_mode, process_id
         FROM saas.chat_threads
         WHERE id = $1 AND organization_id = $2 AND created_by_user_id = $3 AND status = 'active'`,
        [req.params.threadId, req.user.organization_id, req.user.id],
      ),
      query(
        `SELECT COUNT(*)::INTEGER AS used
         FROM saas.chat_messages
         WHERE organization_id = $1 AND user_id = $2 AND role = 'user'
           AND created_at >= NOW() - INTERVAL '1 hour'`,
        [req.user.organization_id, req.user.id],
      ),
    ]);
    if (!threadResult.rowCount) return res.status(404).json({ error: "Conversación no encontrada." });
    if (Number(usageResult.rows[0].used) >= config.chatMessagesPerHour) {
      return res.status(429).json({
        error: "Alcanzaste el límite temporal del chat. Intenta nuevamente más tarde.",
        retry_after_seconds: 3600,
      });
    }
    const thread = threadResult.rows[0];
    const history = await query(
      `SELECT role, content FROM saas.chat_messages
       WHERE thread_id = $1 AND organization_id = $2 AND status = 'ready'
       ORDER BY created_at DESC LIMIT 12`,
      [thread.id, req.user.organization_id],
    );
    const inserted = await query(
      `INSERT INTO saas.chat_messages
         (thread_id, organization_id, user_id, role, content, status)
       VALUES ($1, $2, $3, 'user', $4, 'ready')
       RETURNING id, role, content, status, citations, created_at`,
      [thread.id, req.user.organization_id, req.user.id, content],
    );
    userMessage = inserted.rows[0];
    await query(
      `UPDATE saas.chat_threads
       SET title = CASE WHEN title = 'Nueva conversación' THEN LEFT($2, 80) ELSE title END,
           last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [thread.id, content],
    );

    const workflowResult = await runWorkflow(
      "WF-023",
      {
        organization_id: req.user.organization_id,
        requested_by_user_id: req.user.id,
        thread_id: thread.id,
        message_id: userMessage.id,
        message: content,
        context_mode: thread.context_mode,
        process_id: thread.process_id,
        history: history.rows.reverse(),
        controls: {
          language: "es-CO",
          only_cernoia_context: true,
          require_citations_for_process_claims: true,
          refuse_secret_or_cross_tenant_requests: true,
        },
      },
      { timeoutMs: config.chatWorkflowTimeoutMs },
    );
    const normalized = normalizeWorkflowResponse(workflowResult);
    if (!normalized.answer) throw new Error("El agente no devolvió una respuesta utilizable.");
    const assistantResult = await query(
      `INSERT INTO saas.chat_messages (
         thread_id, organization_id, role, content, status, citations,
         model_provider, model_name, quota_snapshot, workflow_execution_id
       ) VALUES ($1, $2, 'assistant', $3, 'ready', $4::JSONB, $5, $6, $7::JSONB, NULLIF($8, ''))
       RETURNING id, role, content, status, citations, model_provider, model_name, created_at`,
      [
        thread.id,
        req.user.organization_id,
        normalized.answer,
        JSON.stringify(normalized.citations),
        normalized.modelProvider,
        normalized.modelName,
        JSON.stringify(normalized.quota),
        normalized.executionId,
      ],
    );
    await query("UPDATE saas.chat_threads SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1", [thread.id]);
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "chat.message_completed",
      entityType: "chat_thread",
      entityId: thread.id,
      metadata: { context_mode: thread.context_mode },
      req,
    });
    res.status(201).json({ user_message: userMessage, assistant_message: assistantResult.rows[0] });
  } catch (error) {
    if (userMessage) {
      await query(
        `INSERT INTO saas.chat_messages
           (thread_id, organization_id, role, content, status, error_message)
         VALUES ($1, $2, 'assistant', 'No pude completar la consulta en este momento.', 'failed', LEFT($3, 2000))`,
        [req.params.threadId, req.user.organization_id, error.message],
      ).catch(() => undefined);
    }
    next(error);
  }
});

chatRouter.patch("/chat/threads/:threadId", async (req, res, next) => {
  try {
    const status = String(req.body?.status ?? "active");
    const title = String(req.body?.title ?? "").trim().slice(0, 120);
    if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: "Estado no válido." });
    const result = await query(
      `UPDATE saas.chat_threads
       SET status = $4, title = COALESCE(NULLIF($5, ''), title), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND created_by_user_id = $3
       RETURNING *`,
      [req.params.threadId, req.user.organization_id, req.user.id, status, title],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Conversación no encontrada." });
    res.json({ thread: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
