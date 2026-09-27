import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { pool, query } from "../db.js";
import { verifyPassword } from "../security.js";
import { enqueueNotification } from "../services/notifications.js";
import {
  clearPlatformSessionCookie,
  hashPlatformToken,
  platformSessionCookieOptions,
  requirePlatformAuth,
} from "../middleware/platform-auth.js";

export const platformRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiados intentos de administración. Espera 15 minutos." },
});

function valueHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeAdmin(admin) {
  return { id: admin.id, email: admin.email, full_name: admin.full_name, status: admin.status, campaigns_owner:admin.campaigns_owner===true };
}

function normalizeSlug(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

async function writePlatformAudit(admin, action, metadata = {}) {
  await query(
    `INSERT INTO saas.app_audit_log (action, entity_type, entity_id, metadata)
     VALUES ($1, 'platform', $2, $3::JSONB)`,
    [action, admin?.id ?? null, JSON.stringify({ platform_admin_id: admin?.id ?? null, ...metadata })],
  );
}

platformRouter.post("/platform/login", loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!validEmail(email) || !password || password.length > 256) {
      return res.status(400).json({ error: "Correo y contraseña son obligatorios." });
    }
    const result = await query(
      `SELECT id, email, full_name, password_hash, status,
              (SELECT owner_admin_id=saas.platform_admin_users.id FROM saas.campaign_settings WHERE id=TRUE) AS campaigns_owner
       FROM saas.platform_admin_users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email],
    );
    const admin = result.rows[0];
    if (!admin || admin.status !== "active" || !await verifyPassword(password, admin.password_hash)) {
      await writePlatformAudit(null, "platform.login_failed", { email_hash: valueHash(email) });
      return res.status(401).json({ error: "No fue posible validar las credenciales de plataforma." });
    }
    const rawToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + config.platformSessionTtlHours * 60 * 60 * 1000);
    await query(
      `INSERT INTO saas.platform_admin_sessions
        (id, admin_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, admin.id, hashPlatformToken(rawToken), expiresAt, req.ip ?? null, req.get("user-agent") ?? null],
    );
    await query("UPDATE saas.platform_admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1", [admin.id]);
    res.cookie(config.platformCookieName, rawToken, platformSessionCookieOptions());
    await writePlatformAudit(admin, "platform.login");
    res.set("Cache-Control", "no-store");
    return res.json({ admin: safeAdmin(admin), expires_at: expiresAt.toISOString() });
  } catch (error) {
    next(error);
  }
});

platformRouter.get("/platform/me", requirePlatformAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ admin: req.platformAdmin, expires_at: req.platformSession.expires_at });
});

platformRouter.post("/platform/logout", requirePlatformAuth, async (req, res, next) => {
  try {
    await query("UPDATE saas.platform_admin_sessions SET revoked_at = NOW() WHERE id = $1", [req.platformSession.id]);
    await writePlatformAudit(req.platformAdmin, "platform.logout");
    clearPlatformSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

platformRouter.use("/platform", requirePlatformAuth);

platformRouter.get("/platform/overview", async (_req, res, next) => {
  try {
    const [organizations, users, subscriptions, founders, services, workflowRuns, audit] = await Promise.all([
      query(`SELECT COUNT(*)::INTEGER AS total,
                    COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active,
                    COUNT(*) FILTER (WHERE status = 'suspended')::INTEGER AS suspended,
                    COUNT(*) FILTER (WHERE onboarding_status <> 'ready')::INTEGER AS onboarding_pending
             FROM saas.organizations`),
      query(`SELECT COUNT(*)::INTEGER AS total,
                    COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active
             FROM saas.app_users`),
      query(`SELECT status, COUNT(*)::INTEGER AS total
             FROM saas.subscriptions GROUP BY status ORDER BY status`),
      query(`WITH assigned AS (
               SELECT founder_number FROM saas.subscriptions WHERE founder_number IS NOT NULL
               UNION
               SELECT founder_number FROM saas.billing_orders
               WHERE founder_number IS NOT NULL AND status IN ('draft', 'link_created', 'pending') AND expires_at>NOW()
             )
             SELECT COUNT(*)::INTEGER AS assigned,
                    GREATEST(0, 100 - COUNT(*))::INTEGER AS available
             FROM assigned`),
      query(`SELECT service_name, status, MAX(created_at) AS checked_at
             FROM ops.service_health_snapshots
             GROUP BY service_name, status
             ORDER BY service_name, checked_at DESC`),
      query(`SELECT status, COUNT(*)::INTEGER AS total
             FROM ops.workflow_runs
             WHERE started_at >= NOW() - INTERVAL '24 hours'
             GROUP BY status ORDER BY status`),
      query(`SELECT id, action, entity_type, entity_id, metadata, created_at
             FROM saas.app_audit_log
             ORDER BY created_at DESC LIMIT 20`),
    ]);
    res.json({
      organizations: organizations.rows[0],
      users: users.rows[0],
      subscriptions: subscriptions.rows,
      founders: founders.rows[0],
      services: services.rows,
      workflow_runs: workflowRuns.rows,
      audit: audit.rows,
    });
  } catch (error) {
    next(error);
  }
});

platformRouter.get("/platform/organizations", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT organization.id, organization.name, organization.slug, organization.status,
              organization.plan_code, organization.onboarding_status, organization.created_at,
              COUNT(DISTINCT app_user.id)::INTEGER AS user_count,
              COUNT(DISTINCT app_user.id) FILTER (WHERE app_user.status = 'active')::INTEGER AS active_user_count,
              subscription.status AS subscription_status,
              subscription.founder_number,
              subscription.current_period_end,
              owner.email AS owner_email,
              owner.full_name AS owner_name
       FROM saas.organizations organization
       LEFT JOIN saas.app_users app_user ON app_user.organization_id = organization.id
       LEFT JOIN saas.subscriptions subscription ON subscription.organization_id = organization.id
       LEFT JOIN LATERAL (
         SELECT email, full_name
         FROM saas.app_users
         WHERE organization_id = organization.id AND role = 'owner'
         ORDER BY created_at ASC LIMIT 1
       ) owner ON TRUE
       GROUP BY organization.id, subscription.status, subscription.founder_number,
                subscription.current_period_end, owner.email, owner.full_name
       ORDER BY organization.created_at DESC`,
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

platformRouter.post("/platform/organizations", async (req, res, next) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 180);
  const slug = normalizeSlug(req.body?.slug || name);
  const ownerName = String(req.body?.owner_name ?? "").trim().slice(0, 120);
  const ownerEmail = String(req.body?.owner_email ?? "").trim().toLowerCase();
  const role = String(req.body?.role ?? "owner");
  if (name.length < 2 || !slug || ownerName.length < 3 || !validEmail(ownerEmail) || role !== "owner") {
    return res.status(400).json({ error: "Nombre, slug y datos del propietario son obligatorios." });
  }

  const existingOwner = await query(
    "SELECT 1 FROM saas.app_users WHERE LOWER(email) = $1 LIMIT 1",
    [ownerEmail],
  );
  if (existingOwner.rowCount) return res.status(409).json({ error: "Ese correo ya pertenece a una organización." });
  const pendingOwner = await query(
    "SELECT 1 FROM saas.organization_invitations WHERE LOWER(email) = $1 AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1",
    [ownerEmail],
  );
  if (pendingOwner.rowCount) return res.status(409).json({ error: "Ese correo ya tiene una invitación vigente." });

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = valueHash(rawToken);
  const client = await pool.connect();
  let organization;
  let invitation;
  try {
    await client.query("BEGIN");
    const organizationResult = await client.query(
      `INSERT INTO saas.organizations (name, slug, status, onboarding_status)
       VALUES ($1, $2, 'active', 'started')
       RETURNING id, name, slug, status, onboarding_status, created_at`,
      [name, slug],
    );
    organization = organizationResult.rows[0];
    const invitationResult = await client.query(
      `INSERT INTO saas.organization_invitations
        (organization_id, email, full_name, role, token_hash, expires_at)
       VALUES ($1, $2, $3, 'owner', $4, NOW() + INTERVAL '72 hours')
       RETURNING id, email, full_name, role, expires_at`,
      [organization.id, ownerEmail, ownerName, tokenHash],
    );
    invitation = invitationResult.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error.code === "23505") return res.status(409).json({ error: "El slug o el correo ya están registrados." });
    return next(error);
  } finally {
    client.release();
  }

  const inviteUrl = `${config.appOrigin}/?invite_token=${encodeURIComponent(rawToken)}`;
  await enqueueNotification({
    organizationId: organization.id,
    channelType: "email",
    eventType: "organization_invitation",
    recipient: ownerEmail,
    subject: "Activa tu acceso a CernoIA",
    body: `Hola ${ownerName}. Activa el espacio ${organization.name} durante las próximas 72 horas: ${inviteUrl}`,
    idempotencyKey: `organization-invitation:${invitation.id}`,
  }).catch(() => undefined);
  await writePlatformAudit(req.platformAdmin, "platform.organization_created", { organization_id: organization.id, invitation_id: invitation.id });
  res.status(201).json({ organization, invitation: { ...invitation, invite_url: inviteUrl } });
});

platformRouter.patch("/platform/organizations/:organizationId", async (req, res, next) => {
  const status = String(req.body?.status ?? "");
  if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "Estado no válido." });
  try {
    const result = await query(
      `UPDATE saas.organizations
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, slug, status, plan_code, onboarding_status`,
      [req.params.organizationId, status],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Organización no encontrada." });
    await writePlatformAudit(req.platformAdmin, "platform.organization_status_changed", { organization_id: result.rows[0].id, status });
    res.json({ organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
