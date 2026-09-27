import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { pool, query } from "../db.js";

let mailTransport = null;

function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!config.smtpHost || !config.notificationFromEmail) return null;
  mailTransport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
  });
  return mailTransport;
}

async function sendEmail(job) {
  let transport = getMailTransport();
  let from = config.notificationFromEmail;
  if (job.event_type === 'owner_sale_confirmed') {
    const {campaignSettings, campaignTransport} = await import('./campaigns.js');
    const settings = await campaignSettings();
    transport = campaignTransport(settings);
    from = settings.sender_email;
  }
  if (!transport) {
    const error = new Error("El canal SMTP no está configurado.");
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }
  const info = await transport.sendMail({
    from,
    to: job.recipient,
    subject: job.subject || "Notificación de CernoIA",
    text: job.body_text,
  });
  return { provider: "smtp", messageId: info.messageId, response: info.response };
}

async function sendWhatsApp(job) {
  if (!config.whatsappPhoneNumberId || !config.whatsappAccessToken) {
    const error = new Error("WhatsApp Business no está configurado.");
    error.code = "WHATSAPP_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(
    `https://graph.facebook.com/${config.whatsappGraphApiVersion}/${config.whatsappPhoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.whatsappAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(job.recipient).replace(/[^0-9]/g, ""),
        type: "text",
        text: { preview_url: false, body: job.body_text.slice(0, 4096) },
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `WhatsApp respondió ${response.status}.`);
    error.code = `WHATSAPP_${response.status}`;
    throw error;
  }
  return { provider: "whatsapp_cloud", messageId: data?.messages?.[0]?.id ?? null, response: data };
}

async function deliver(job) {
  if (job.channel_type === "email") return sendEmail(job);
  if (job.channel_type === "whatsapp") return sendWhatsApp(job);
  return { provider: "cernoia", messageId: null, response: { stored: true } };
}

export async function enqueueNotification({
  organizationId,
  channelId = null,
  channelType,
  eventType,
  recipient = null,
  subject = null,
  body,
  payload = {},
  idempotencyKey,
  scheduledAt = new Date(),
}) {
  const result = await query(
    `INSERT INTO saas.notification_outbox (
       organization_id, channel_id, channel_type, event_type, recipient,
       subject, body_text, payload, idempotency_key, scheduled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10)
     ON CONFLICT (organization_id, idempotency_key) DO UPDATE
       SET updated_at = saas.notification_outbox.updated_at
     RETURNING id, status`,
    [
      organizationId,
      channelId,
      channelType,
      eventType,
      recipient,
      subject,
      String(body).slice(0, 12000),
      JSON.stringify(payload),
      idempotencyKey,
      scheduledAt,
    ],
  );
  return result.rows[0];
}

async function claimJobs(limit) {
  const client = await pool.connect();
  const workerId = `api-${randomUUID()}`;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidates AS (
         SELECT id
         FROM saas.notification_outbox
         WHERE status IN ('queued', 'failed')
           AND scheduled_at <= NOW()
           AND attempts < max_attempts
           AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '10 minutes')
         ORDER BY scheduled_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE saas.notification_outbox job
       SET status = 'sending', locked_at = NOW(), locked_by = $2,
           attempts = attempts + 1, updated_at = NOW()
       FROM candidates
       WHERE job.id = candidates.id
       RETURNING job.*`,
      [limit, workerId],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function dispatchOutboxBatch(limit = config.notificationWorkerBatch) {
  const jobs = await claimJobs(Math.min(100, Math.max(1, Number(limit) || 1)));
  const summary = { claimed: jobs.length, sent: 0, failed: 0, dead_lettered: 0 };
  for (const job of jobs) {
    try {
      const result = await deliver(job);
      await query(
        `UPDATE saas.notification_outbox
         SET status = 'sent', sent_at = NOW(), provider_message_id = $2,
             last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [job.id, result.messageId],
      );
      await query(
        `INSERT INTO saas.notification_deliveries
           (outbox_id, organization_id, attempt_number, provider, status, response_snapshot)
         VALUES ($1, $2, $3, $4, 'sent', $5::JSONB)`,
        [job.id, job.organization_id, job.attempts, result.provider, JSON.stringify(result.response ?? {})],
      );
      await query(
        `UPDATE ops.dead_letter_jobs
         SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
         WHERE job_type = 'notification' AND source_id = $1
           AND organization_id = $2 AND status IN ('open', 'retrying')`,
        [job.id, job.organization_id],
      );
      summary.sent += 1;
    } catch (error) {
      const exhausted = Number(job.attempts) >= Number(job.max_attempts);
      const retryMinutes = Math.min(240, 2 ** Number(job.attempts));
      await query(
        `UPDATE saas.notification_outbox
         SET status = 'failed', last_error = LEFT($2, 2000),
             scheduled_at = NOW() + ($3::TEXT || ' minutes')::INTERVAL,
             locked_at = NULL, locked_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [job.id, error.message, retryMinutes],
      );
      await query(
        `INSERT INTO saas.notification_deliveries
           (outbox_id, organization_id, attempt_number, provider, status, error_message)
         VALUES ($1, $2, $3, $4, 'failed', LEFT($5, 2000))`,
        [job.id, job.organization_id, job.attempts, job.channel_type, error.message],
      );
      if (exhausted) {
        await query(
          `INSERT INTO ops.dead_letter_jobs
             (organization_id, job_type, source_id, payload, last_error)
           VALUES ($1, 'notification', $2, $3::JSONB, LEFT($4, 2000))
           ON CONFLICT DO NOTHING`,
          [job.organization_id, job.id, JSON.stringify({ event_type: job.event_type }), error.message],
        );
        summary.dead_lettered += 1;
      }
      summary.failed += 1;
    }
  }
  return summary;
}

export function notificationReadiness() {
  return {
    email: Boolean(config.smtpHost && config.notificationFromEmail),
    whatsapp: Boolean(config.whatsappPhoneNumberId && config.whatsappAccessToken),
  };
}
