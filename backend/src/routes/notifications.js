import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { query } from "../db.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeEqual } from "../security.js";
import {
  dispatchOutboxBatch,
  enqueueNotification,
  notificationReadiness,
} from "../services/notifications.js";

export const notificationsRouter = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

function internalAuthorized(req) {
  return Boolean(
    config.n8nWebhookSecret
      && safeEqual(String(req.get("authorization") ?? ""), `Bearer ${config.n8nWebhookSecret}`),
  );
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function materializeAlertOutbox() {
  const result = await query(
    `INSERT INTO saas.notification_outbox (
       organization_id, channel_id, channel_type, event_type, recipient,
       subject, body_text, payload, idempotency_key
     )
     SELECT alert.organization_id, channel.id, channel.channel_type, 'document_alert', channel.destination,
            alert.title, alert.message,
            jsonb_build_object('alert_id', alert.id, 'document_id', alert.organization_document_id,
                               'severity', alert.severity, 'due_date', alert.due_date),
            'document-alert:' || alert.id::TEXT || ':' || channel.id::TEXT || ':' ||
            CASE
              WHEN alert.alert_type = 'expiring' THEN 'due-' || timing.days_remaining::TEXT
              WHEN alert.alert_type = 'expired' THEN 'overdue-' || ABS(timing.days_remaining)::TEXT
              ELSE 'week-' || TO_CHAR(CURRENT_DATE, 'IYYY-IW')
            END
     FROM saas.document_alerts alert
     JOIN saas.organization_documents document
       ON document.id = alert.organization_document_id
      AND document.organization_id = alert.organization_id
     JOIN saas.notification_channels channel
       ON channel.organization_id = alert.organization_id
      AND channel.status = 'active'
     LEFT JOIN LATERAL (
       SELECT type_policy.alert_schedule_days
       FROM saas.document_type_policies type_policy
       WHERE type_policy.document_type = document.document_type
         AND type_policy.is_active = TRUE
         AND (type_policy.organization_id = alert.organization_id OR type_policy.organization_id IS NULL)
       ORDER BY type_policy.organization_id IS NOT NULL DESC, type_policy.updated_at DESC
       LIMIT 1
     ) policy ON TRUE
     CROSS JOIN LATERAL (
       SELECT (alert.due_date - CURRENT_DATE)::INTEGER AS days_remaining
     ) timing
     WHERE alert.status = 'open'
       AND alert.last_triggered_at >= NOW() - INTERVAL '36 hours'
       AND (
         (
           alert.alert_type = 'expiring'
           AND (
             timing.days_remaining = 0
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 COALESCE(policy.alert_schedule_days, '[30,15,5,2,1]'::JSONB)
               ) schedule(day)
               WHERE schedule.day ~ '^[0-9]+$'
                 AND schedule.day::INTEGER = timing.days_remaining
             )
           )
         )
         OR (alert.alert_type = 'expired' AND timing.days_remaining IN (-1, -7, -30))
         OR (
           alert.alert_type IN ('missing_date', 'review_required')
           AND (alert.first_triggered_at::DATE = CURRENT_DATE OR EXTRACT(ISODOW FROM CURRENT_DATE) = 1)
         )
       )
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING id`,
  );
  return result.rowCount;
}

notificationsRouter.post("/integrations/notifications/dispatch", async (req, res, next) => {
  try {
    if (!internalAuthorized(req)) return res.status(401).json({ error: "Integración no autorizada." });
    const materialized = await materializeAlertOutbox();
    const summary = await dispatchOutboxBatch(req.body?.limit);
    res.json({ ...summary, materialized });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.use(requireAuth);

notificationsRouter.get("/notifications", async (req, res, next) => {
  try {
    const [channels, deliveries] = await Promise.all([
      query(
        `SELECT id, channel_type, destination, display_name, status, is_primary,
                verified_at, created_at, updated_at
         FROM saas.notification_channels
         WHERE organization_id = $1
         ORDER BY channel_type, is_primary DESC, created_at DESC`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id, channel_type, event_type, recipient, subject, status, attempts,
                max_attempts, scheduled_at, sent_at, last_error, created_at
         FROM saas.notification_outbox
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.user.organization_id],
      ),
    ]);
    res.json({ channels: channels.rows, deliveries: deliveries.rows, readiness: notificationReadiness() });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post(
  "/notifications/channels",
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const channelType = String(req.body?.channel_type ?? "").toLowerCase();
      const destination = String(req.body?.destination ?? "").trim().toLowerCase();
      const displayName = String(req.body?.display_name ?? "").trim().slice(0, 120);
      if (!['email', 'whatsapp'].includes(channelType)) {
        return res.status(400).json({ error: "Selecciona correo o WhatsApp." });
      }
      if (channelType === "email" && !EMAIL_PATTERN.test(destination)) {
        return res.status(400).json({ error: "El correo no es válido." });
      }
      if (channelType === "whatsapp" && !PHONE_PATTERN.test(destination)) {
        return res.status(400).json({ error: "Usa un teléfono internacional, por ejemplo +573001234567." });
      }
      const token = randomBytes(32).toString("base64url");
      const verificationValue = channelType === "whatsapp" ? token.slice(0, 8).toUpperCase() : token;
      const result = await query(
        `INSERT INTO saas.notification_channels (
           organization_id, channel_type, destination, display_name, status,
           verification_token_hash, verification_expires_at, created_by_user_id
         ) VALUES ($1, $2, $3, NULLIF($4, ''), 'pending_verification', $5,
                   NOW() + INTERVAL '30 minutes', $6)
         ON CONFLICT (organization_id, channel_type, destination) DO UPDATE
           SET display_name = EXCLUDED.display_name, status = 'pending_verification',
               verification_token_hash = EXCLUDED.verification_token_hash,
               verification_expires_at = EXCLUDED.verification_expires_at,
               updated_at = NOW()
         RETURNING id, channel_type, destination, display_name, status, is_primary, created_at`,
        [req.user.organization_id, channelType, destination, displayName, digest(verificationValue), req.user.id],
      );
      const channel = result.rows[0];
      const verificationUrl = `${config.appOrigin}/?notification_channel=${channel.id}&verification=${encodeURIComponent(token)}`;
      const body = channelType === "email"
        ? `Confirma este canal de CernoIA abriendo el siguiente enlace: ${verificationUrl}`
        : `Código de verificación CernoIA: ${verificationValue}`;
      await enqueueNotification({
        organizationId: req.user.organization_id,
        channelId: channel.id,
        channelType,
        eventType: "channel_verification",
        recipient: destination,
        subject: "Confirma tu canal de alertas CernoIA",
        body,
        payload: { channel_id: channel.id },
        idempotencyKey: `channel-verification:${channel.id}:${digest(verificationValue).slice(0, 12)}`,
      });
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "notification_channel.created",
        entityType: "notification_channel",
        entityId: channel.id,
        metadata: { channel_type: channelType },
        req,
      });
      res.status(201).json({ channel, verification_queued: true });
    } catch (error) {
      next(error);
    }
  },
);

notificationsRouter.post(
  "/notifications/channels/:channelId/verify",
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const token = String(req.body?.token ?? "").trim();
      if (token.length < 8) return res.status(400).json({ error: "El código de verificación no es válido." });
      const result = await query(
        `UPDATE saas.notification_channels
         SET status = 'active', verified_at = NOW(), verification_token_hash = NULL,
             verification_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
           AND status = 'pending_verification'
           AND verification_expires_at > NOW()
           AND verification_token_hash = $3
         RETURNING id, channel_type, destination, display_name, status, is_primary, verified_at`,
        [req.params.channelId, req.user.organization_id, digest(token)],
      );
      if (!result.rowCount) return res.status(400).json({ error: "El código venció o no coincide." });
      res.json({ channel: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

notificationsRouter.post(
  "/notifications/channels/:channelId/test",
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const result = await query(
        `SELECT id, channel_type, destination
         FROM saas.notification_channels
         WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [req.params.channelId, req.user.organization_id],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Canal activo no encontrado." });
      const channel = result.rows[0];
      const queued = await enqueueNotification({
        organizationId: req.user.organization_id,
        channelId: channel.id,
        channelType: channel.channel_type,
        eventType: "channel_test",
        recipient: channel.destination,
        subject: "Prueba de alertas CernoIA",
        body: "Tu canal de alertas está conectado correctamente.",
        idempotencyKey: `channel-test:${channel.id}:${Date.now()}`,
      });
      res.status(202).json({ queued });
    } catch (error) {
      next(error);
    }
  },
);

notificationsRouter.patch(
  "/notifications/channels/:channelId",
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? "active");
      const isPrimary = Boolean(req.body?.is_primary);
      if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: "Estado no válido." });
      const result = await query(
        `UPDATE saas.notification_channels
         SET status = $3, is_primary = $4, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND verified_at IS NOT NULL
         RETURNING id, channel_type, destination, display_name, status, is_primary, verified_at`,
        [req.params.channelId, req.user.organization_id, status, isPrimary],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Canal no encontrado." });
      if (isPrimary && status === "active") {
        await query(
          `UPDATE saas.notification_channels
           SET is_primary = FALSE, updated_at = NOW()
           WHERE organization_id = $1 AND channel_type = $2 AND id <> $3 AND is_primary = TRUE`,
          [req.user.organization_id, result.rows[0].channel_type, result.rows[0].id],
        );
      }
      res.json({ channel: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);
