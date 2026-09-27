import { config } from "../config.js";
import { safeEqual } from "../security.js";

function isTrustedInternalIntegration(req) {
  if (!req.path.startsWith("/api/integrations/")) return false;
  const authorization = String(req.get("authorization") ?? "");
  return Boolean(
    config.n8nWebhookSecret
      && safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`),
  );
}

export function validateOrigin(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  if (isTrustedInternalIntegration(req)) return next();
  const origin = String(req.get("origin") ?? "").replace(/\/$/, "");
  if (!origin && !config.isProduction) return next();
  if (!config.allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origen de solicitud no permitido." });
  }
  next();
}
