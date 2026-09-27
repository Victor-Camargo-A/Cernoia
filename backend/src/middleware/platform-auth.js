import { createHash } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db.js";

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function clearPlatformCookie(res) {
  res.clearCookie(config.platformCookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
  });
}

export function platformSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: config.platformSessionTtlHours * 60 * 60 * 1000,
  };
}

export function hashPlatformToken(value) {
  return tokenHash(value);
}

export async function requirePlatformAuth(req, res, next) {
  try {
    const token = req.cookies?.[config.platformCookieName];
    if (!token) return res.status(401).json({ error: "Sesión de plataforma requerida." });
    const result = await query(
      `SELECT admin.id, admin.email, admin.full_name, admin.status,
              (SELECT owner_admin_id=admin.id FROM saas.campaign_settings WHERE id=TRUE) AS campaigns_owner,
              session.id AS session_id, session.expires_at
       FROM saas.platform_admin_sessions session
       JOIN saas.platform_admin_users admin ON admin.id = session.admin_id
       WHERE session.token_hash = $1
         AND session.revoked_at IS NULL
         AND session.expires_at > NOW()
         AND admin.status = 'active'
       LIMIT 1`,
      [tokenHash(token)],
    );
    if (!result.rowCount) {
      clearPlatformCookie(res);
      return res.status(401).json({ error: "La sesión de plataforma venció o fue cerrada." });
    }
    const row = result.rows[0];
    req.platformAdmin = {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      status: row.status,
      campaigns_owner: row.campaigns_owner===true,
    };
    req.platformSession = { id: row.session_id, expires_at: row.expires_at };
    void query(
      "UPDATE saas.platform_admin_sessions SET last_seen_at = NOW() WHERE id = $1",
      [row.session_id],
    ).catch(() => undefined);
    return next();
  } catch {
    clearPlatformCookie(res);
    return res.status(401).json({ error: "La sesión de plataforma no es válida." });
  }
}

export function clearPlatformSessionCookie(res) {
  clearPlatformCookie(res);
}
