import { config } from "../config.js";
import { createCsrfToken, safeEqual } from "../security.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  };
}

export function issueCsrfToken(res) {
  const token = createCsrfToken();
  res.cookie(config.csrfCookieName, token, csrfCookieOptions());
  return token;
}

export function validateCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const authorization = String(req.get("authorization") ?? "");
  if (
    req.path.startsWith("/api/integrations/")
    && config.n8nWebhookSecret
    && safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`)
  ) return next();
  const cookieToken = req.cookies?.[config.csrfCookieName];
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: "La validación de seguridad expiró. Actualiza la página e intenta nuevamente." });
  }
  next();
}
