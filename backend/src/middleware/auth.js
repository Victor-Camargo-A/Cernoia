import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { authQuery as query, runWithTenantContext } from "../db.js";

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
  });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[config.cookieName];
    if (!token) return res.status(401).json({ error: "Sesión requerida." });

    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    if (typeof payload !== "object" || !payload.sub || !payload.sid) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Sesión no válida." });
    }

    const result = await query(
      `SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.status,
              s.id AS session_id, s.expires_at
       FROM saas.app_users u
       JOIN saas.app_sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2
         AND u.status = 'active'
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [payload.sub, payload.sid],
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "La sesión venció o fue cerrada." });
    }

    const row = result.rows[0];
    req.user = {
      id: row.id,
      organization_id: row.organization_id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      status: row.status,
    };
    req.session = { id: row.session_id, expires_at: row.expires_at };
    void query(
      "UPDATE saas.app_sessions SET last_seen_at = NOW() WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '5 minutes'",
      [row.session_id],
    ).catch(() => undefined);
    return runWithTenantContext(row.organization_id, () => next());
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: "La sesión venció o no es válida." });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción." });
    }
    next();
  };
}
