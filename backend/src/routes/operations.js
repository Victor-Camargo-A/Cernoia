import { Router } from "express";
import Redis from "ioredis";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { config } from "../config.js";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { checkN8nHealth } from "../services/n8n.js";
import { scanForMalware } from "../services/malware-scanner.js";
import { dispatchOutboxBatch, notificationReadiness } from "../services/notifications.js";
import { processBoldEvent } from "./billing.js";

import { snapshot } from '../services/quota-core.mjs';
export const operationsRouter = Router();
operationsRouter.use(requireAuth, requireRole("owner", "admin"));

async function redisHealth() {
  const started = Date.now();
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 2500,
    commandTimeout: 2500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const reply = await redis.ping();
    return { status: reply === "PONG" ? "healthy" : "degraded", latency_ms: Date.now() - started };
  } catch (error) {
    return { status: "offline", latency_ms: Date.now() - started, reason: error.code ?? "unreachable" };
  } finally {
    redis.disconnect();
  }
}

async function storageHealth() {
  const started = Date.now();
  try {
    await access(config.documentStoragePath, fsConstants.R_OK | fsConstants.W_OK);
    return { status: "healthy", latency_ms: Date.now() - started };
  } catch (error) {
    return { status: "offline", latency_ms: Date.now() - started, reason: error.code ?? "unavailable" };
  }
}

async function antivirusHealth() {
  const started = Date.now();
  if (!config.clamavEnabled) {
    return { status: config.malwareScanRequired ? "offline" : "unknown", configured: false };
  }
  try {
    const result = await scanForMalware(Buffer.from("CernoIA health check"));
    return { status: result.status === "clean" ? "healthy" : "degraded", latency_ms: Date.now() - started, configured: true };
  } catch (error) {
    return { status: "offline", latency_ms: Date.now() - started, configured: true, reason: error.code ?? "unavailable" };
  }
}

operationsRouter.get("/operations/summary", async (req, res, next) => {
  try {
    const started = Date.now();
    const [databaseResult, redis, n8n, storage, antivirus, workflows, quota, notifications, deadLetters, billing] = await Promise.all([
      query("SELECT NOW() AS now").then(() => ({ status: "healthy", latency_ms: Date.now() - started })),
      redisHealth(),
      checkN8nHealth(),
      storageHealth(),
      antivirusHealth(),
      query(
        `SELECT status, COUNT(*)::INTEGER AS total
         FROM ops.workflow_runs
         WHERE metadata ->> 'organization_id' = $1::TEXT
           AND created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY status`,
        [req.user.organization_id],
      ),
      query(
        `SELECT outcome, COUNT(*)::INTEGER AS total,
                MAX(daily_used)::INTEGER AS daily_used, MAX(daily_limit)::INTEGER AS daily_limit
         FROM ops.ai_quota_events
         WHERE (organization_id = $1 OR organization_id IS NULL)
           AND created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY outcome`,
        [req.user.organization_id],
      ),
      query(
        `SELECT status, COUNT(*)::INTEGER AS total
         FROM saas.notification_outbox
         WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY status`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id, job_type, source_id, status, attempt_count, last_error,
                next_retry_at, created_at, updated_at
         FROM ops.dead_letter_jobs
         WHERE organization_id = $1 AND status IN ('open', 'retrying')
         ORDER BY created_at DESC LIMIT 50`,
        [req.user.organization_id],
      ),
      query(
        `SELECT status, COUNT(*)::INTEGER AS total
         FROM saas.billing_orders
         WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
         GROUP BY status`,
        [req.user.organization_id],
      ),
    ]);
    const services = {
      database: databaseResult,
      redis,
      n8n: { status: n8n.online ? "healthy" : "offline", detail: n8n.error ?? n8n.status ?? null },
      storage,
      antivirus,
      notifications: notificationReadiness(),
      bold: { status: config.boldIdentityKey && config.boldSecretKey ? "healthy" : "unknown", configured: Boolean(config.boldIdentityKey && config.boldSecretKey) },
    };
    await Promise.all(
      Object.entries(services)
        .filter(([, value]) => typeof value?.status === "string")
        .map(([name, value]) => query(
          `INSERT INTO ops.service_health_snapshots (service_name, status, latency_ms, details)
           VALUES ($1, $2, $3, $4::JSONB)`,
          [name, value.status, value.latency_ms ?? null, JSON.stringify(value)],
        )),
    );
    res.json({
      services,
      workflows: workflows.rows,
      quota: quota.rows,
      notifications: notifications.rows,
      billing: billing.rows,
      dead_letters: deadLetters.rows,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/notifications/dispatch", async (req, res, next) => {
  try {
    res.json(await dispatchOutboxBatch(req.body?.limit));
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/dead-letters/:jobId/retry", async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE ops.dead_letter_jobs
       SET status = 'retrying', attempt_count = attempt_count + 1, next_retry_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status IN ('open', 'retrying')
       RETURNING *`,
      [req.params.jobId, req.user.organization_id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Incidencia no encontrada." });
    if (result.rows[0].job_type === "notification" && result.rows[0].source_id) {
      await query(
        `UPDATE saas.notification_outbox
         SET status = 'queued', attempts = 0, scheduled_at = NOW(), last_error = NULL, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [result.rows[0].source_id, req.user.organization_id],
      );
    } else if (result.rows[0].job_type === "bold_webhook" && result.rows[0].source_id) {
      await query(
        `UPDATE saas.bold_webhook_events
         SET processing_status = 'pending', attempts = 0, error_message = NULL, updated_at = NOW()
         WHERE event_id = $1`,
        [result.rows[0].source_id],
      );
      try {
        await processBoldEvent(result.rows[0].source_id);
      } catch (error) {
        await query(
          `UPDATE ops.dead_letter_jobs
           SET status = 'open', last_error = LEFT($2, 2000), updated_at = NOW()
           WHERE id = $1`,
          [result.rows[0].id, error.message],
        );
        error.statusCode = 502;
        throw error;
      }
    }
    res.json({ job: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get('/operations/ai-quota', async (_req,res,next)=>{
 const redis=new Redis(config.redisUrl,{maxRetriesPerRequest:1,commandTimeout:5000});
 try {res.json(await snapshot(redis));}catch(e){next(e);}finally{redis.disconnect();}
});
