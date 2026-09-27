import {attachMarketingSignup} from '../services/marketing.js';
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { config } from "../config.js";
import { pool, authQuery as query, withTenantTransaction } from "../db.js";
import { hashPassword, validatePassword, verifyPassword } from "../security.js";
import { requireAuth } from "../middleware/auth.js";
import { issueCsrfToken } from "../middleware/csrf.js";
import { writeAudit } from "../audit.js";
import { decryptSecret, encryptSecret } from "../services/secret-box.js";
import { enqueueNotification } from "../services/notifications.js";

export const authRouter = Router();

const DUMMY_HASH = hashPassword("Cernoia-acceso-temporal-2026");
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos. Espera 15 minutos antes de intentarlo nuevamente." },
});
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Has solicitado varias demos. Espera un momento antes de intentarlo nuevamente." },
});
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." },
});

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  };
}

function sessionClearCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
  };
}

function csrfClearCookieOptions() {
  return {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
  };
}

function safeUser(user) {
  return {
    id: user.id,
    organization_id: user.organization_id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    status: user.status,
  };
}

function valueHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeDemoSlug(value) {
  const base = String(value ?? "empresa")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55) || "empresa";
  return `${base}-demo-${randomBytes(4).toString("hex")}`;
}

function createTotp(secret, email) {
  return new OTPAuth.TOTP({
    issuer: "CernoIA",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

async function issueAuthenticatedSession(req, res, user) {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  await query(
    `INSERT INTO saas.app_sessions (id, user_id, organization_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, user.id, user.organization_id, expiresAt, req.ip ?? null, req.get("user-agent") ?? null],
  );
  const token = jwt.sign(
    { sub: user.id, sid: sessionId, oid: user.organization_id },
    config.jwtSecret,
    {
      algorithm: "HS256",
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      expiresIn: config.sessionTtlHours * 60 * 60,
    },
  );
  res.cookie(config.cookieName, token, sessionCookieOptions());
  const csrfToken = issueCsrfToken(res);
  await query(
    `UPDATE saas.app_users
     SET last_login_at = NOW(), failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
     WHERE id = $1`,
    [user.id],
  );
  await writeAudit({ userId: user.id, organizationId: user.organization_id, action: "auth.login", req });
  res.set("Cache-Control", "no-store");
  return { user: safeUser(user), expires_at: expiresAt.toISOString(), csrfToken };
}

authRouter.get("/csrf", (_req, res) => {
  const csrfToken = issueCsrfToken(res);
  res.set("Cache-Control", "no-store");
  res.json({ csrfToken });
});

authRouter.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!email || !password || email.length > 254 || password.length > 256) {
      return res.status(400).json({ error: "Correo y contraseña son obligatorios." });
    }

    const result = await query(
      `SELECT id, organization_id, email, full_name, role, status, password_hash,
              failed_login_attempts, locked_until, mfa_enabled
       FROM saas.app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [email],
    );
    const user = result.rows[0];
    const hashToVerify = user?.password_hash ?? await DUMMY_HASH;
    const passwordValid = await verifyPassword(password, hashToVerify);
    const locked = user?.locked_until && new Date(user.locked_until).getTime() > Date.now();
    const valid = Boolean(user && user.status === "active" && passwordValid && !locked);

    if (!valid) {
      if (user) {
        await query(
          `UPDATE saas.app_users
           SET failed_login_attempts = failed_login_attempts + 1,
               locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END,
               updated_at = NOW()
           WHERE id = $1`,
          [user.id],
        );
      }
      await writeAudit({ action: "auth.login_failed", metadata: { email }, req });
      return res.status(401).json({ error: "No fue posible validar las credenciales." });
    }

    if (user.mfa_enabled) {
      const challengeToken = jwt.sign(
        { sub: user.id, purpose: "mfa_login" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          issuer: config.jwtIssuer,
          audience: `${config.jwtAudience}:mfa`,
          expiresIn: 5 * 60,
        },
      );
      await query(
        `UPDATE saas.app_users SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
        [user.id],
      );
      res.set("Cache-Control", "no-store");
      return res.json({ mfa_required: true, challenge_token: challengeToken });
    }

    res.json(await issueAuthenticatedSession(req, res, user));
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login/mfa", sensitiveLimiter, async (req, res, next) => {
  try {
    const challengeToken = String(req.body?.challenge_token ?? "");
    const code = String(req.body?.code ?? "").trim().replace(/\s/g, "").toUpperCase();
    if (!challengeToken || !code) return res.status(400).json({ error: "Código de verificación requerido." });
    let payload;
    try {
      payload = jwt.verify(challengeToken, config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: config.jwtIssuer,
        audience: `${config.jwtAudience}:mfa`,
      });
    } catch {
      return res.status(401).json({ error: "La verificación venció. Inicia sesión nuevamente." });
    }
    if (typeof payload !== "object" || payload.purpose !== "mfa_login" || !payload.sub) {
      return res.status(401).json({ error: "La verificación no es válida." });
    }
    const userResult = await query(
      `SELECT id, organization_id, email, full_name, role, status, mfa_enabled
       FROM saas.app_users WHERE id = $1 AND status = 'active' AND mfa_enabled = TRUE`,
      [payload.sub],
    );
    if (!userResult.rowCount) return res.status(401).json({ error: "La verificación no es válida." });
    const user = userResult.rows[0];
    const verification = await withTenantTransaction(user.organization_id, async (client) => {
      const credentialResult = await client.query(
        `SELECT * FROM saas.app_mfa_credentials
         WHERE user_id = $1 AND organization_id = $2 AND pending = FALSE
         FOR UPDATE`,
        [user.id, user.organization_id],
      );
      const credential = credentialResult.rows[0];
      if (!credential || (credential.locked_until && new Date(credential.locked_until) > new Date())) {
        return { valid: false, unavailable: true };
      }
      const secret = decryptSecret({
        encrypted: credential.encrypted_secret,
        iv: credential.secret_iv,
        tag: credential.secret_tag,
      });
      const totp = createTotp(secret, user.email);
      const delta = /^\d{6}$/.test(code) ? totp.validate({ token: code, window: 1 }) : null;
      const counter = delta == null ? null : Math.floor(Date.now() / 1000 / 30) + delta;
      const recoveryHashes = Array.isArray(credential.recovery_code_hashes)
        ? [...credential.recovery_code_hashes]
        : [];
      const recoveryIndex = recoveryHashes.indexOf(valueHash(code));
      const validTotp = counter != null
        && (credential.last_used_counter == null || counter > Number(credential.last_used_counter));
      const validRecovery = recoveryIndex >= 0;
      if (!validTotp && !validRecovery) {
        await client.query(
          `UPDATE saas.app_mfa_credentials
           SET failed_attempts = failed_attempts + 1,
               locked_until = CASE WHEN failed_attempts + 1 >= 6 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END,
               updated_at = NOW()
           WHERE user_id = $1 AND organization_id = $2`,
          [user.id, user.organization_id],
        );
        return { valid: false, unavailable: false };
      }
      if (validRecovery) recoveryHashes.splice(recoveryIndex, 1);
      await client.query(
        `UPDATE saas.app_mfa_credentials
         SET last_used_counter = COALESCE($3, last_used_counter),
             recovery_code_hashes = $4::JSONB, failed_attempts = 0,
             locked_until = NULL, updated_at = NOW()
         WHERE user_id = $1 AND organization_id = $2`,
        [user.id, user.organization_id, counter, JSON.stringify(recoveryHashes)],
      );
      return { valid: true, unavailable: false };
    });
    if (!verification.valid) {
      return res.status(401).json({
        error: verification.unavailable
          ? "La verificación temporalmente no está disponible."
          : "El código no es válido.",
      });
    }
    res.json(await issueAuthenticatedSession(req, res, user));
  } catch (error) {
    next(error);
  }
});

authRouter.post("/demo/start", demoLimiter, async (req, res, next) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const fullName = String(req.body?.full_name ?? "").trim().slice(0, 120);
  const companyName = String(req.body?.company_name ?? "").trim().slice(0, 180);
  const password = String(req.body?.password ?? "");
  const passwordValidation = validatePassword(password);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Ingresa un correo electrónico válido." });
  }
  if (fullName.length < 3 || companyName.length < 2) {
    return res.status(400).json({ error: "Indica tu nombre y el nombre de tu empresa." });
  }
  if (!passwordValidation.valid) return res.status(400).json({ error: passwordValidation.error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM saas.app_users WHERE LOWER(email) = $1 LIMIT 1", [email]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ese correo ya tiene una cuenta. Entra con tus credenciales o solicita una invitación." });
    }
    const organization = (await client.query(
      `INSERT INTO saas.organizations
         (name, legal_name, slug, status, plan_code, onboarding_status, metadata, demo_enabled)
       VALUES ($1, $1, $2, 'active', 'pilot', 'profile_incomplete',
               jsonb_build_object('access_mode', 'demo', 'source', 'campaign'), TRUE)
       RETURNING id, name, slug, status`,
      [companyName, normalizeDemoSlug(companyName)],
    )).rows[0];
    const passwordHash = await hashPassword(password);
    const user = (await client.query(
      `INSERT INTO saas.app_users
         (organization_id, email, full_name, password_hash, role, status, password_changed_at)
       VALUES ($1, $2, $3, $4, 'owner', 'active', NOW())
       RETURNING id, organization_id, email, full_name, role, status`,
      [organization.id, email, fullName, passwordHash],
    )).rows[0];
    await client.query(
      `INSERT INTO saas.app_organization_settings (organization_id, notification_email, minimum_match_score)
       VALUES ($1, $2, 0) ON CONFLICT (organization_id) DO NOTHING`,
      [organization.id, email],
    );
    await client.query(
      `INSERT INTO saas.organization_capability_profiles
         (organization_id, name, company_summary, products_services, is_active, is_ready_for_ai)
       VALUES ($1, 'Perfil demo',
               'Empresa en exploración de oportunidades de contratación pública con CernoIA.',
               '["Servicios empresariales"]'::JSONB, TRUE, TRUE)`,
      [organization.id],
    );
    const searchProfile = (await client.query(
      `INSERT INTO saas.search_profiles
         (organization_id, name, description, is_active, filter_config)
       VALUES ($1, 'Exploración demo', 'Procesos abiertos para conocer el flujo de CernoIA.', TRUE,
               '{"only_open":true,"procurement_methods":["Mínima cuantía"],"process_statuses":["Publicado"],"defaults_version":1}'::JSONB)
       RETURNING id`,
      [organization.id],
    )).rows[0];
    await client.query(
      `INSERT INTO saas.process_matches
         (organization_id, search_profile_id, process_id, match_score, match_status, matched_reasons, process_snapshot)
       SELECT $1, $2, process.id, 60, 'new',
              jsonb_build_object('demo', TRUE), to_jsonb(process)
       FROM secop.processes process
       WHERE process.procurement_method='Mínima cuantía' AND process.process_status='Publicado' AND COALESCE(process.awarded, FALSE) = FALSE
         AND (process.response_deadline IS NULL OR process.response_deadline > NOW())
         AND LOWER(COALESCE(process.process_status, '')) !~ '(cancelad|adjudicad|terminad|cerrad)'
       ORDER BY process.publication_date DESC NULLS LAST, process.id
       LIMIT 50
       ON CONFLICT (search_profile_id, process_id) DO NOTHING`,
      [organization.id, searchProfile.id],
    );
    await attachMarketingSignup(client,req,organization.id);
    await client.query("COMMIT");
    await writeAudit({ userId: user.id, organizationId: organization.id, action: "auth.demo_started", metadata: { email_hash: valueHash(email) }, req });
    return res.status(201).json(await issueAuthenticatedSession(req, res, user));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error.code === "23505") return res.status(409).json({ error: "Ese correo ya tiene una cuenta. Entra con tus credenciales." });
    next(error);
  } finally {
    client.release();
  }
});

authRouter.post("/password-reset/request", sensitiveLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const generic = { requested: true, message: "Si el correo está registrado, enviaremos instrucciones." };
    if (!email || email.length > 254) return res.json(generic);
    const result = await query(
      `SELECT id, organization_id, email, full_name FROM saas.app_users
       WHERE lower(email) = $1 AND status = 'active' LIMIT 1`,
      [email],
    );
    const user = result.rows[0];
    if (user) {
      const token = randomBytes(32).toString("base64url");
      await query("UPDATE saas.password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
      await query(
        `INSERT INTO saas.password_reset_tokens
           (user_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, NOW() + ($3::TEXT || ' minutes')::INTERVAL, $4)`,
        [user.id, valueHash(token), config.passwordResetTtlMinutes, req.ip ?? null],
      );
      const resetUrl = `${config.appOrigin}/?reset_token=${encodeURIComponent(token)}`;
      await enqueueNotification({
        organizationId: user.organization_id,
        channelType: "email",
        eventType: "password_reset",
        recipient: user.email,
        subject: "Restablece tu acceso a CernoIA",
        body: `Hola ${user.full_name}. Usa este enlace durante los próximos ${config.passwordResetTtlMinutes} minutos: ${resetUrl}`,
        idempotencyKey: `password-reset:${user.id}:${valueHash(token).slice(0, 16)}`,
      });
    }
    await writeAudit({ action: "auth.password_reset_requested", metadata: { email_hash: valueHash(email) }, req });
    res.json(generic);
  } catch (error) {
    next(error);
  }
});

authRouter.post("/invitations/accept", sensitiveLimiter, async (req, res, next) => {
  const token = String(req.body?.token ?? "").trim();
  const fullNameOverride = String(req.body?.full_name ?? "").trim().slice(0, 120);
  const password = String(req.body?.password ?? "");
  const validation = validatePassword(password);
  if (!token || !validation.valid) return res.status(400).json({ error: validation.error ?? "La invitación no es válida." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invitationResult = await client.query(
      `SELECT invitation.*, organization.name AS organization_name, organization.status AS organization_status
       FROM saas.organization_invitations invitation
       JOIN saas.organizations organization ON organization.id = invitation.organization_id
       WHERE invitation.token_hash = $1
         AND invitation.accepted_at IS NULL
         AND invitation.expires_at > NOW()
       FOR UPDATE`,
      [valueHash(token)],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation || invitation.organization_status !== "active") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La invitación venció, ya fue utilizada o la organización no está activa." });
    }
    const existing = await client.query(
      "SELECT 1 FROM saas.app_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [invitation.email],
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ese correo ya tiene una cuenta. Solicita acceso al administrador." });
    }
    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO saas.app_users
        (organization_id, email, full_name, password_hash, role, status, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       RETURNING id, organization_id, email, full_name, role, status`,
      [invitation.organization_id, invitation.email, fullNameOverride || invitation.full_name, invitation.role, passwordHash],
    );
    await client.query(
      "UPDATE saas.organization_invitations SET accepted_at = NOW() WHERE id = $1",
      [invitation.id],
    );
    await client.query(
      `UPDATE saas.organizations
       SET onboarding_status = CASE WHEN onboarding_status = 'started' THEN 'profile_incomplete' ELSE onboarding_status END,
           updated_at = NOW()
       WHERE id = $1`,
      [invitation.organization_id],
    );
    await client.query("COMMIT");
    const user = userResult.rows[0];
    await writeAudit({
      userId: user.id,
      organizationId: user.organization_id,
      action: "auth.invitation_accepted",
      entityType: "organization_invitation",
      entityId: invitation.id,
      req,
    });
    return res.json(await issueAuthenticatedSession(req, res, user));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error.code === "23505") return res.status(409).json({ error: "Ese correo ya tiene una cuenta." });
    next(error);
  } finally {
    client.release();
  }
});

authRouter.post("/password-reset/confirm", sensitiveLimiter, async (req, res, next) => {
  const token = String(req.body?.token ?? "");
  const newPassword = String(req.body?.new_password ?? "");
  const validation = validatePassword(newPassword);
  if (!validation.valid) return res.status(400).json({ error: validation.error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT reset.id, reset.user_id
       FROM saas.password_reset_tokens reset
       JOIN saas.app_users user_record ON user_record.id = reset.user_id
       WHERE reset.token_hash = $1 AND reset.used_at IS NULL AND reset.expires_at > NOW()
         AND user_record.status = 'active'
       FOR UPDATE`,
      [valueHash(token)],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El enlace venció o ya fue utilizado." });
    }
    const passwordHash = await hashPassword(newPassword);
    await client.query(
      `UPDATE saas.app_users
       SET password_hash = $2, password_changed_at = NOW(), failed_login_attempts = 0,
           locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [result.rows[0].user_id, passwordHash],
    );
    await client.query("UPDATE saas.password_reset_tokens SET used_at = NOW() WHERE id = $1", [result.rows[0].id]);
    await client.query(
      "UPDATE saas.app_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
      [result.rows[0].user_id],
    );
    await client.query("COMMIT");
    res.json({ changed: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await query("UPDATE saas.app_sessions SET revoked_at = NOW() WHERE id = $1", [req.session.id]);
  await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "auth.logout", req });
  res.clearCookie(config.cookieName, sessionClearCookieOptions());
  res.clearCookie(config.csrfCookieName, csrfClearCookieOptions());
  res.status(204).end();
});

authRouter.post("/logout-all", requireAuth, async (req, res) => {
  await query(
    "UPDATE saas.app_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [req.user.id],
  );
  await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "auth.logout_all", req });
  res.clearCookie(config.cookieName, sessionClearCookieOptions());
  res.clearCookie(config.csrfCookieName, csrfClearCookieOptions());
  res.status(204).end();
});

authRouter.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password ?? "");
    const newPassword = String(req.body?.new_password ?? "");
    const validation = validatePassword(newPassword);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    if (currentPassword === newPassword) return res.status(400).json({ error: "La contraseña nueva debe ser diferente." });

    const result = await query("SELECT password_hash FROM saas.app_users WHERE id = $1", [req.user.id]);
    if (!await verifyPassword(currentPassword, result.rows[0]?.password_hash)) {
      return res.status(401).json({ error: "La contraseña actual no es correcta." });
    }

    const passwordHash = await hashPassword(newPassword);
    await query(
      "UPDATE saas.app_users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1",
      [req.user.id, passwordHash],
    );
    await query(
      "UPDATE saas.app_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [req.user.id, req.session.id],
    );
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "auth.password_changed", req });
    res.json({ changed: true });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/mfa/status", requireAuth, async (req, res, next) => {
  try {
    const result = await withTenantTransaction(req.user.organization_id, (client) => client.query(
      `SELECT user_record.mfa_enabled, user_record.mfa_enrolled_at,
              credential.pending,
              COALESCE(jsonb_array_length(credential.recovery_code_hashes), 0)::INTEGER AS recovery_codes_remaining
       FROM saas.app_users user_record
       LEFT JOIN saas.app_mfa_credentials credential ON credential.user_id = user_record.id
       WHERE user_record.id = $1`,
      [req.user.id],
    ));
    res.set("Cache-Control", "no-store");
    res.json({ mfa: result.rows[0] ?? { mfa_enabled: false, pending: false, recovery_codes_remaining: 0 } });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/mfa/setup", requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password ?? "");
    const userResult = await query("SELECT password_hash, mfa_enabled FROM saas.app_users WHERE id = $1", [req.user.id]);
    if (!await verifyPassword(currentPassword, userResult.rows[0]?.password_hash)) {
      return res.status(401).json({ error: "La contraseña actual no es correcta." });
    }
    if (userResult.rows[0]?.mfa_enabled) return res.status(409).json({ error: "La verificación en dos pasos ya está activa." });
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const encrypted = encryptSecret(secret);
    await withTenantTransaction(req.user.organization_id, (client) => client.query(
      `INSERT INTO saas.app_mfa_credentials (
         user_id, organization_id, encrypted_secret, secret_iv, secret_tag, pending
       ) VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET
         encrypted_secret = EXCLUDED.encrypted_secret, secret_iv = EXCLUDED.secret_iv,
         secret_tag = EXCLUDED.secret_tag, pending = TRUE, recovery_code_hashes = '[]'::JSONB,
         failed_attempts = 0, locked_until = NULL, updated_at = NOW()`,
      [req.user.id, req.user.organization_id, encrypted.encrypted, encrypted.iv, encrypted.tag],
    ));
    const totp = createTotp(secret, req.user.email);
    res.set("Cache-Control", "no-store");
    res.json({
      otpauth_uri: totp.toString(),
      qr_data_url: await QRCode.toDataURL(totp.toString(), { width: 256, margin: 1 }),
      manual_key: secret.match(/.{1,4}/g)?.join(" ") ?? secret,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/mfa/verify-setup", requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Escribe el código de seis dígitos." });
    const recoveryCodes = Array.from({ length: 8 }, () => {
      const value = randomBytes(5).toString("hex").toUpperCase();
      return `${value.slice(0, 5)}-${value.slice(5)}`;
    });
    const verified = await withTenantTransaction(req.user.organization_id, async (client) => {
      const result = await client.query(
        `SELECT * FROM saas.app_mfa_credentials
         WHERE user_id = $1 AND organization_id = $2 AND pending = TRUE FOR UPDATE`,
        [req.user.id, req.user.organization_id],
      );
      const credential = result.rows[0];
      if (!credential) return false;
      const secret = decryptSecret({
        encrypted: credential.encrypted_secret,
        iv: credential.secret_iv,
        tag: credential.secret_tag,
      });
      const delta = createTotp(secret, req.user.email).validate({ token: code, window: 1 });
      if (delta == null) return false;
      const counter = Math.floor(Date.now() / 1000 / 30) + delta;
      await client.query(
        `UPDATE saas.app_mfa_credentials
         SET pending = FALSE, verified_at = NOW(), last_used_counter = $2,
             recovery_code_hashes = $3::JSONB, updated_at = NOW()
         WHERE user_id = $1`,
        [req.user.id, counter, JSON.stringify(recoveryCodes.map(valueHash))],
      );
      await client.query(
        `UPDATE saas.app_users SET mfa_enabled = TRUE, mfa_enrolled_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [req.user.id],
      );
      return true;
    });
    if (!verified) return res.status(400).json({ error: "El código no coincide. Comprueba la hora de tu dispositivo." });
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "auth.mfa_enabled", req });
    res.set("Cache-Control", "no-store");
    res.json({ enabled: true, recovery_codes: recoveryCodes });
  } catch (error) {
    next(error);
  }
});

authRouter.delete("/mfa", requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password ?? "");
    const code = String(req.body?.code ?? "").replace(/\s/g, "");
    const userResult = await query("SELECT password_hash FROM saas.app_users WHERE id = $1", [req.user.id]);
    if (!await verifyPassword(currentPassword, userResult.rows[0]?.password_hash)) {
      return res.status(401).json({ error: "La contraseña actual no es correcta." });
    }
    const disabled = await withTenantTransaction(req.user.organization_id, async (client) => {
      const result = await client.query(
        `SELECT * FROM saas.app_mfa_credentials
         WHERE user_id = $1 AND organization_id = $2 AND pending = FALSE FOR UPDATE`,
        [req.user.id, req.user.organization_id],
      );
      const credential = result.rows[0];
      if (!credential) return false;
      const secret = decryptSecret({
        encrypted: credential.encrypted_secret,
        iv: credential.secret_iv,
        tag: credential.secret_tag,
      });
      if (createTotp(secret, req.user.email).validate({ token: code, window: 1 }) == null) return false;
      await client.query("DELETE FROM saas.app_mfa_credentials WHERE user_id = $1", [req.user.id]);
      await client.query(
        `UPDATE saas.app_users SET mfa_enabled = FALSE, mfa_enrolled_at = NULL, updated_at = NOW() WHERE id = $1`,
        [req.user.id],
      );
      return true;
    });
    if (!disabled) return res.status(400).json({ error: "El código de verificación no es válido." });
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "auth.mfa_disabled", req });
    res.json({ enabled: false });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/sessions", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, created_at, last_seen_at, expires_at, ip_address, user_agent,
              (id = $2) AS current
       FROM saas.app_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_seen_at DESC`,
      [req.user.id, req.session.id],
    );
    res.set("Cache-Control", "no-store");
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ user: req.user, session: { expires_at: req.session.expires_at } });
});
