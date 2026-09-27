import { enqueueOwnerSale } from '../services/owner-sales.js';
import { randomUUID } from "node:crypto";
import { Router, raw } from "express";
import { config } from "../config.js";
import { pool, query, withTenantTransaction } from "../db.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeEqual } from "../security.js";
import {
  fetchBoldLink,
  boldEventId,
  boldOrderAction,
  createBoldPaymentLink,
  normalizeBoldEvent,
  verifyBoldSignature,
} from "../services/bold.js";

export const billingWebhookRouter = Router();
export const billingRouter = Router();
export const billingIntegrationRouter = Router();


async function activateApprovedOrder(client, order, event, payload) {
  if(order.founder_number) {
    const claimed=await client.query('SELECT 1 FROM saas.subscriptions WHERE founder_number=$1 AND organization_id<>$2',[order.founder_number,order.organization_id]);
    if(claimed.rowCount) {
      const slot=await client.query('SELECT number FROM saas.next_founder_slot()');
      if(!slot.rowCount) throw new Error('El pago requiere conciliación: el cupo reservado ya no está disponible.');
      order={...order,founder_number:slot.rows[0].number};
      await client.query('UPDATE saas.billing_orders SET founder_number=$2 WHERE id=$1',[order.id,order.founder_number]);
    }
  }
  const previousResult = await client.query(
    `SELECT status FROM saas.subscriptions WHERE organization_id = $1 FOR UPDATE`,
    [order.organization_id],
  );
  const previousStatus = previousResult.rows[0]?.status ?? "pending";
  const subscriptionResult = await client.query(
    `WITH previous AS (
       SELECT * FROM saas.subscriptions WHERE organization_id = $1 FOR UPDATE
     ), period AS (
       SELECT CASE
         WHEN (SELECT current_period_end FROM previous) > NOW()
           THEN (SELECT current_period_end FROM previous)
         ELSE NOW()
       END AS starts_at
     )
     INSERT INTO saas.subscriptions (
       organization_id, plan_code, status, founder_number, founder_price_starts_at,
       founder_price_ends_at, current_period_start, current_period_end,
       next_payment_due_at, activated_at, paid_cycles
     )
     SELECT $1, $2, 'active', $3,
            CASE WHEN $3::INTEGER IS NOT NULL THEN COALESCE((SELECT founder_price_starts_at FROM previous), NOW()) END,
            CASE WHEN $3::INTEGER IS NOT NULL
              THEN COALESCE((SELECT founder_price_ends_at FROM previous), NOW() + INTERVAL '12 months') END,
            starts_at, starts_at + INTERVAL '1 month', starts_at + INTERVAL '1 month',
            COALESCE((SELECT activated_at FROM previous), NOW()),
            COALESCE((SELECT paid_cycles FROM previous), 0) + 1
     FROM period
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_code = EXCLUDED.plan_code,
       status = 'active',
       founder_number = COALESCE(saas.subscriptions.founder_number, EXCLUDED.founder_number),
       founder_price_starts_at = COALESCE(saas.subscriptions.founder_price_starts_at, EXCLUDED.founder_price_starts_at),
       founder_price_ends_at = COALESCE(saas.subscriptions.founder_price_ends_at, EXCLUDED.founder_price_ends_at),
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       next_payment_due_at = EXCLUDED.next_payment_due_at,
       activated_at = COALESCE(saas.subscriptions.activated_at, EXCLUDED.activated_at),
       paid_cycles = saas.subscriptions.paid_cycles + 1,
       updated_at = NOW()
     RETURNING *`,
    [order.organization_id, order.plan_code, order.founder_number],
  );
  const subscription = subscriptionResult.rows[0];
  await enqueueOwnerSale(client, order, event);
  await client.query(
    `UPDATE saas.billing_orders
     SET subscription_id = $2, status = 'approved', marketing_is_test = $9, provider_transaction_id = NULLIF($3, ''),
         payer_email = NULLIF($4, ''), payment_method = NULLIF($5, ''),
         period_start = $6, period_end = $7, approved_at = NOW(),
         raw_payment_snapshot = $8::JSONB, error_message = NULL, updated_at = NOW()
     WHERE id = $1`,
    [
      order.id,
      subscription.id,
      event.transactionId,
      event.payerEmail,
      event.paymentMethod,
      subscription.current_period_start,
      subscription.current_period_end,
      JSON.stringify(payload),
      config.boldEnvironment!=="production",
    ],
  );
  await client.query(
    `UPDATE saas.organizations SET plan_code = $2, updated_at = NOW() WHERE id = $1`,
    [order.organization_id, order.plan_code],
  );
  await client.query(
    `INSERT INTO saas.subscription_events
       (organization_id, subscription_id, billing_order_id, event_type, from_status, to_status, metadata)
     VALUES ($1, $2, $3, 'payment_approved', $4, 'active', $5::JSONB)`,
    [order.organization_id, subscription.id, order.id, previousStatus, JSON.stringify({ bold_event: event.type })],
  );
}

export async function processBoldEvent(eventId) {
  const client = await pool.connect();
  let relatedOrganizationId = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cernoia_founder_slots_v1'))");
    const eventResult = await client.query(
      `SELECT * FROM saas.bold_webhook_events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    const eventRecord = eventResult.rows[0];
    if (!eventRecord || ["processed", "ignored"].includes(eventRecord.processing_status)) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `UPDATE saas.bold_webhook_events
       SET processing_status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE event_id = $1`,
      [eventId],
    );
    const normalized = normalizeBoldEvent(eventRecord.raw_payload);
    const orderResult = await client.query(
      `SELECT * FROM saas.billing_orders
       WHERE ($1 <> '' AND provider_link_id = $1)
          OR ($2 <> '' AND reference = $2)
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [normalized.providerLinkId, normalized.merchantReference],
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query(
        `UPDATE saas.bold_webhook_events
         SET processing_status = 'ignored', error_message = 'Orden no encontrada', processed_at = NOW(), updated_at = NOW()
         WHERE event_id = $1`,
        [eventId],
      );
      await client.query("COMMIT");
      return;
    }
    relatedOrganizationId = order.organization_id;
    const action = boldOrderAction(order, normalized);
    if (action === "approve") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bold-payment:${normalized.transactionId}`]);
      const duplicatePayment = await client.query(
        `SELECT id FROM saas.billing_orders WHERE provider_transaction_id = $1 AND id <> $2 AND status IN ('approved', 'cancelled') LIMIT 1`,
        [normalized.transactionId, order.id],
      );
      if (duplicatePayment.rowCount) throw new Error("La transacción ya está asociada a otra orden.");
      await activateApprovedOrder(client, order, normalized, eventRecord.raw_payload);
    } else if (action === "reject") {
      await client.query(
        `UPDATE saas.billing_orders
         SET status = 'rejected', provider_transaction_id = NULLIF($2, ''),
             raw_payment_snapshot = $3::JSONB, updated_at = NOW()
         WHERE id = $1 AND status <> 'approved'`,
        [order.id, normalized.transactionId, JSON.stringify(eventRecord.raw_payload)],
      );
    } else if (action === "cancel") {
      await client.query(
        `UPDATE saas.billing_orders
         SET status = 'cancelled', raw_payment_snapshot = $2::JSONB, updated_at = NOW()
         WHERE id = $1`,
        [order.id, JSON.stringify(eventRecord.raw_payload)],
      );
      await client.query(
        `UPDATE saas.subscriptions
         SET status = 'past_due', updated_at = NOW()
         WHERE organization_id = $1 AND date_trunc('milliseconds', current_period_end) = $2::timestamptz AND current_period_end > NOW()`,
        [order.organization_id, order.period_end],
      );
    }
    await client.query(
      `UPDATE saas.bold_webhook_events
       SET provider_link_id = NULLIF($2, ''), provider_transaction_id = NULLIF($3, ''),
           processing_status = 'processed', processed_at = NOW(), error_message = NULL, updated_at = NOW()
       WHERE event_id = $1`,
      [eventId, normalized.providerLinkId, normalized.transactionId],
    );
    await client.query("COMMIT");
    await query(
      `UPDATE ops.dead_letter_jobs
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE job_type = 'bold_webhook' AND source_id = $1 AND status IN ('open', 'retrying')`,
      [eventId],
    ).catch(() => undefined);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const failure = await query(
      `UPDATE saas.bold_webhook_events
       SET processing_status = 'failed', attempts = attempts + 1,
           error_message = LEFT($2, 2000), updated_at = NOW()
       WHERE event_id = $1
       RETURNING attempts, raw_payload`,
      [eventId, error.message],
    ).catch(() => undefined);
    if (Number(failure?.rows?.[0]?.attempts ?? 0) >= 8) {
      await query(
        `INSERT INTO ops.dead_letter_jobs
           (organization_id, job_type, source_id, payload, last_error)
         SELECT $1, 'bold_webhook', $2, $3::JSONB, LEFT($4, 2000)
         WHERE NOT EXISTS (
           SELECT 1 FROM ops.dead_letter_jobs
           WHERE job_type = 'bold_webhook' AND source_id = $2 AND status IN ('open', 'retrying')
         )`,
        [relatedOrganizationId, eventId, JSON.stringify(failure.rows[0].raw_payload ?? {}), error.message],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

billingWebhookRouter.post(
  "/webhooks/bold",
  raw({ type: "application/json", limit: "512kb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const signature = req.get("x-bold-signature");
    if (!verifyBoldSignature(rawBody, signature)) {
      return res.status(401).json({ accepted: false });
    }
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ accepted: false });
    }
    const eventId = boldEventId(payload, rawBody);
    const normalized = normalizeBoldEvent(payload);
    try {
      await query(
        `INSERT INTO saas.bold_webhook_events
           (event_id, event_type, provider_transaction_id, provider_link_id, signature_valid, raw_payload)
         VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), TRUE, $5::JSONB)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, normalized.type, normalized.transactionId, normalized.providerLinkId, JSON.stringify(payload)],
      );
      // Confirmamos la recepción después de persistir el evento y procesamos
      // fuera de la solicitud. Un 200 evita reintentos innecesarios de Bold.
      res.status(200).json({ accepted: true });
      setImmediate(() => processBoldEvent(eventId).catch((error) => console.error("Webhook Bold:", error.message)));
    } catch {
      res.status(503).json({ accepted: false });
    }
  },
);

billingRouter.use(requireAuth);

billingRouter.get("/billing/overview", async (req, res, next) => {
  try {
    const [plans, subscription, orders, founders] = await Promise.all([
      query(
        `SELECT code, name, description, amount_cop, billing_interval,
                protected_price_months, customer_limit, features
         FROM saas.subscription_plans WHERE is_active = TRUE AND is_public = TRUE
         ORDER BY amount_cop ASC`,
      ),
      query(
        `SELECT subscription.*, plan.name AS plan_name, plan.amount_cop,
                (subscription.status = 'active'
                  AND subscription.current_period_end IS NOT NULL
                  AND subscription.current_period_end <= NOW() + INTERVAL '7 days') AS can_renew
         FROM saas.subscriptions subscription
         JOIN saas.subscription_plans plan ON plan.code = subscription.plan_code
         WHERE subscription.organization_id = $1`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id, reference, plan_code, billing_reason, amount_cop, currency, founder_number,
                CASE WHEN status IN ('draft','link_created','pending') AND expires_at<NOW() THEN 'expired' ELSE status END AS status,
                provider_link_id, checkout_url, period_start, period_end,
                raw_payment_snapshot->'provider_query'->>'status' AS provider_status,
                raw_payment_snapshot->>'provider_checked_at' AS provider_checked_at,
                expires_at, approved_at, created_at, marketing_is_test
         FROM saas.billing_orders
         WHERE organization_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [req.user.organization_id],
      ),
      pool.query(`SELECT * FROM saas.founder_availability()`),
    ]);
    res.json({
      plans: plans.rows,
      subscription: subscription.rows[0] ?? null,
      orders: orders.rows,
      tracking_started_at: (await query("SELECT started_at FROM saas.marketing_tracking_settings WHERE id=TRUE")).rows[0]?.started_at,
      founders: founders.rows[0],
      gateway: {
        provider: "bold",
        configured: Boolean(config.boldIdentityKey && config.boldSecretKey),
        environment: config.boldEnvironment,
      },
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post(
  "/billing/checkout",
  requireRole("owner", "admin"),
  async (req, res, next) => {
    let order;
    try {
      if (!config.boldIdentityKey || !config.boldSecretKey) {
        return res.status(503).json({ error: "Los pagos aún no están disponibles. Contacta al administrador." });
      }
      order = await withTenantTransaction(req.user.organization_id, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('cernoia_founder_slots_v1'))");
        await client.query(
          `UPDATE saas.billing_orders SET status = 'expired', updated_at = NOW()
           WHERE status IN ('draft', 'link_created', 'pending') AND expires_at < NOW()`,
        );
        const reusable = await client.query(
          `SELECT * FROM saas.billing_orders
           WHERE organization_id = $1 AND status IN ('draft', 'link_created', 'pending') AND expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.organization_id],
        );
        if (reusable.rowCount) {
          if (reusable.rows[0].checkout_url) return reusable.rows[0];
          const inProgress = new Error("Ya estamos preparando tu enlace de pago. Espera unos instantes y vuelve a consultar.");
          inProgress.statusCode = 409;
          throw inProgress;
        }

        const subscription = await client.query(
          `SELECT * FROM saas.subscriptions WHERE organization_id = $1 FOR UPDATE`,
          [req.user.organization_id],
        );
        const current = subscription.rows[0];
        if (
          current?.status === "active"
          && current?.current_period_end
          && new Date(current.current_period_end).getTime() > Date.now() + (7 * 24 * 60 * 60 * 1000)
        ) {
          const renewalError = new Error("La renovación se habilita siete días antes del vencimiento.");
          renewalError.statusCode = 409;
          throw renewalError;
        }
        let planCode = "business_2026";
        let founderNumber = null;
        if (
          current?.founder_number
          && current?.founder_price_ends_at
          && new Date(current.founder_price_ends_at).getTime() > Date.now()
          && Number(current.paid_cycles ?? 0) < 12
        ) {
          planCode = "founders_2026";
          founderNumber = current.founder_number;
        } else if (!current?.activated_at) {
          const slot = await client.query('SELECT number FROM saas.next_founder_slot()');
          if (slot.rowCount) {
            planCode = "founders_2026";
            founderNumber = slot.rows[0].number;
          }
        }
        const plan = await client.query(
          `SELECT * FROM saas.subscription_plans WHERE code = $1 AND is_active = TRUE`,
          [planCode],
        );
        const reference = `CERNOIA-${randomUUID()}`;
        const result = await client.query(
          `INSERT INTO saas.billing_orders (
             organization_id, created_by_user_id, reference, plan_code, billing_reason,
             amount_cop, founder_number, status, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft',
                     NOW() + ($8::TEXT || ' minutes')::INTERVAL)
           RETURNING *`,
          [
            req.user.organization_id,
            req.user.id,
            reference,
            planCode,
            !current ? "initial" : current.status === "active" ? "renewal" : "reactivation",
            plan.rows[0].amount_cop,
            founderNumber,
            config.boldCheckoutTtlMinutes,
          ],
        );
        return result.rows[0];
      });

      if (["link_created", "pending"].includes(order.status) && order.checkout_url) {
        return res.json({ order });
      }
      const link = await createBoldPaymentLink({
        amountCop: order.amount_cop,
        reference: order.reference,
        description: order.plan_code === "founders_2026"
          ? `CernoIA Plan Fundadores · cupo ${order.founder_number}`
          : "CernoIA Plan Empresarial mensual",
        callbackUrl: config.boldCallbackUrl,
      });
      const result = await query(
        `UPDATE saas.billing_orders
         SET status = 'link_created', provider_link_id = $2, checkout_url = $3,
             raw_create_response = $4::JSONB, marketing_is_test = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING id, reference, plan_code, billing_reason, amount_cop, currency,
                   founder_number, status, provider_link_id, checkout_url, expires_at, created_at`,
        [order.id, link.providerLinkId, link.checkoutUrl, JSON.stringify(link.raw),config.boldEnvironment!=="production"],
      );
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "billing.checkout_created",
        entityType: "billing_order",
        entityId: order.id,
        metadata: { plan_code: order.plan_code, founder_number: order.founder_number },
        req,
      });
      res.status(201).json({ order: result.rows[0] });
    } catch (error) {
      if (order?.id) {
        await query(
          `UPDATE saas.billing_orders
           SET status = 'error', error_message = LEFT($2, 2000), updated_at = NOW()
           WHERE id = $1 AND status = 'draft'`,
          [order.id, error.message],
        ).catch(() => undefined);
      }
      next(error);
    }
  },
);

billingIntegrationRouter.post(
  "/integrations/billing/reconcile",
  async (req, res, next) => {
    try {
      if (
        !config.n8nWebhookSecret
        || !safeEqual(String(req.get("authorization") ?? ""), `Bearer ${config.n8nWebhookSecret}`)
      ) return res.status(401).json({ error: "Integración no autorizada." });
      const pending = await query(
        `SELECT event_id FROM saas.bold_webhook_events
         WHERE processing_status IN ('pending', 'failed') AND attempts < 8
         ORDER BY received_at ASC LIMIT 50`,
      );
      const outcomes = await Promise.allSettled(pending.rows.map((item) => processBoldEvent(item.event_id)));
      const expiredOrders = await query(
          `UPDATE saas.billing_orders
           SET status = 'expired', updated_at = NOW()
           WHERE status IN ('draft', 'link_created', 'pending')
             AND expires_at IS NOT NULL AND expires_at < NOW()
           RETURNING id`,
        );
      // Las transiciones son deliberadamente secuenciales. Una suscripción que
      // acaba de vencer debe pasar primero por past_due y solo después puede
      // evaluarse el periodo de gracia, evitando resultados dependientes del
      // orden de ejecución de consultas concurrentes.
      const pastDueEvents = await query(
          `WITH changed AS (
             UPDATE saas.subscriptions
             SET status = 'past_due', updated_at = NOW()
             WHERE status = 'active' AND current_period_end IS NOT NULL
               AND current_period_end <= NOW()
             RETURNING id, organization_id
           )
           INSERT INTO saas.subscription_events
             (organization_id, subscription_id, event_type, from_status, to_status)
           SELECT organization_id, id, 'payment_due', 'active', 'past_due' FROM changed
           RETURNING id`,
        );
      const expiredEvents = await query(
          `WITH changed AS (
             UPDATE saas.subscriptions
             SET status = 'expired', updated_at = NOW()
             WHERE status = 'past_due' AND current_period_end IS NOT NULL
               AND current_period_end <= NOW() - INTERVAL '15 days'
             RETURNING id, organization_id
           )
           INSERT INTO saas.subscription_events
             (organization_id, subscription_id, event_type, from_status, to_status)
           SELECT organization_id, id, 'grace_period_ended', 'past_due', 'expired' FROM changed
           RETURNING id`,
        );
      const reminders = await query(
          `WITH due AS (
             SELECT subscription.id, subscription.organization_id,
                    subscription.next_payment_due_at::DATE AS due_date,
                    (subscription.next_payment_due_at::DATE - CURRENT_DATE)::INTEGER AS days_remaining,
                    plan.name AS plan_name, plan.amount_cop
             FROM saas.subscriptions subscription
             JOIN saas.subscription_plans plan ON plan.code = subscription.plan_code
             WHERE subscription.status = 'active'
               AND subscription.next_payment_due_at IS NOT NULL
               AND subscription.next_payment_due_at::DATE BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
           )
           INSERT INTO saas.notification_outbox (
             organization_id, channel_id, channel_type, event_type, recipient,
             subject, body_text, payload, idempotency_key
           )
           SELECT due.organization_id, channel.id, channel.channel_type,
                  'subscription_renewal', channel.destination,
                  CASE WHEN due.days_remaining = 0
                    THEN 'Tu renovación de CernoIA vence hoy'
                    ELSE 'Tu renovación de CernoIA está próxima'
                  END,
                  'Tu ' || due.plan_name || ' por COP $' || due.amount_cop::TEXT
                    || CASE WHEN due.days_remaining = 0
                      THEN ' vence hoy. '
                      ELSE ' vence en ' || due.days_remaining::TEXT || ' días. '
                    END
                    || 'Genera el enlace seguro de Bold desde ' || $1::TEXT,
                  jsonb_build_object('subscription_id', due.id, 'due_date', due.due_date,
                                     'days_remaining', due.days_remaining),
                  'subscription-renewal:' || due.id::TEXT || ':' || due.due_date::TEXT
                    || ':' || due.days_remaining::TEXT || ':' || channel.id::TEXT
           FROM due
           JOIN saas.notification_channels channel
             ON channel.organization_id = due.organization_id AND channel.status = 'active'
           WHERE due.days_remaining IN (7, 3, 1, 0)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [`${config.appOrigin}/acceso?billing=renew`],
        );
      res.json({
        reviewed: outcomes.length,
        completed: outcomes.filter((item) => item.status === "fulfilled").length,
        failed: outcomes.filter((item) => item.status === "rejected").length,
        expired_orders: expiredOrders.rowCount,
        marked_past_due: pastDueEvents.rowCount,
        marked_expired: expiredEvents.rowCount,
        renewal_reminders_queued: reminders.rowCount,
      });
    } catch (error) {
      next(error);
    }
  },
);

billingRouter.post('/billing/refresh', requireRole('owner','admin'), async(req,res,next) => {
  try {
    const orders=await query(`UPDATE saas.billing_orders SET raw_payment_snapshot=COALESCE(raw_payment_snapshot,'{}'::jsonb)||jsonb_build_object('provider_checked_at',NOW())
      WHERE id IN (SELECT id FROM saas.billing_orders WHERE organization_id=$1 AND provider_link_id IS NOT NULL
        AND status IN ('draft','link_created','pending','expired','rejected') AND created_at>NOW()-INTERVAL '7 days'
        AND COALESCE((raw_payment_snapshot->>'provider_checked_at')::timestamptz,'epoch')<NOW()-INTERVAL '25 seconds'
        ORDER BY created_at DESC LIMIT 3) RETURNING *`,[req.user.organization_id]);
    let unavailable=0;
    for(const order of orders.rows) {
      try {
        const data=await fetchBoldLink(order);
        await query(`UPDATE saas.billing_orders SET raw_payment_snapshot=COALESCE(raw_payment_snapshot,'{}'::jsonb)||jsonb_build_object('provider_query',$3::jsonb),
          status=CASE WHEN status IN ('approved','cancelled') THEN status WHEN $4='REJECTED' THEN 'rejected'
          WHEN $4 IN ('EXPIRED','CANCELLED') THEN 'expired' WHEN expires_at<NOW() AND $4<>'PAID' THEN 'expired' ELSE status END,
          updated_at=NOW() WHERE id=$1 AND organization_id=$2`,[order.id,req.user.organization_id,JSON.stringify(data),data.status]);
        if(data.status==='PAID' && data.transaction_id) {
          const payload={id:'bold-api:'+order.id+':'+data.transaction_id,type:'SALE_APPROVED',verification_source:'authenticated_bold_api',data:{payment_link:order.provider_link_id,reference:order.reference,payment_id:data.transaction_id,amount:{total_amount:Number(data.total),currency:data.currency},payment_method:data.payment_method}};
          await query(`INSERT INTO saas.bold_webhook_events(event_id,event_type,signature_valid,raw_payload)
            VALUES($1,'SALE_APPROVED',FALSE,$2::jsonb) ON CONFLICT(event_id) DO NOTHING`,[payload.id,JSON.stringify(payload)]);
          await processBoldEvent(payload.id);
        }
      } catch { unavailable++; }
    }
    res.json({checked:orders.rowCount,unavailable});
  }catch(error){next(error);}
});
