import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";

function required(name, fallback = "") {
  const value = String(process.env[name] ?? fallback).trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

const jwtSecret = required(
  "JWT_SECRET",
  isProduction ? "" : "desarrollo-local-no-usar-en-produccion-cambiar-por-secreto",
);

if (isProduction && jwtSecret.length < 64) {
  throw new Error("JWT_SECRET debe tener al menos 64 caracteres en producción.");
}

const originList = String(
  process.env.ALLOWED_ORIGINS ?? process.env.APP_ORIGIN ?? "http://localhost:3000",
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

const dataEncryptionKey = required(
  "DATA_ENCRYPTION_KEY",
  isProduction ? "" : "2f3533c4f4bb09b5ecb4afe880f8cf533f773ead8890c0044617f6bed5c3e268",
).toLowerCase();

if (!/^[0-9a-f]{64}$/.test(dataEncryptionKey)) {
  throw new Error("DATA_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales.");
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export const config = Object.freeze({
  env: process.env.NODE_ENV ?? "development",
  isProduction,
  port: Number(process.env.PORT ?? 4001),
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "true",
  jwtSecret,
  jwtIssuer: "cernoia-api",
  jwtAudience: "cernoia-web",
  sessionTtlHours: Math.min(24, Math.max(1, Number(process.env.SESSION_TTL_HOURS ?? 8))),
  platformSessionTtlHours: Math.min(12, Math.max(1, Number(process.env.PLATFORM_SESSION_TTL_HOURS ?? 4))),
  passwordResetTtlMinutes: boundedNumber(process.env.PASSWORD_RESET_TTL_MINUTES, 30, 10, 120),
  cookieName: process.env.COOKIE_NAME ?? (isProduction ? "__Host-cernoia_session" : "cernoia_session"),
  platformCookieName: process.env.PLATFORM_COOKIE_NAME ?? (isProduction ? "__Host-cernoia_platform_session" : "cernoia_platform_session"),
  csrfCookieName: process.env.CSRF_COOKIE_NAME ?? (isProduction ? "__Host-cernoia_csrf" : "cernoia_csrf"),
  appOrigin: originList[0],
  allowedOrigins: new Set(originList),
  n8nBaseUrl: String(process.env.N8N_BASE_URL ?? "https://n8n.secretbloom.tech").replace(/\/$/, ""),
  n8nHealthUrl: process.env.N8N_HEALTH_URL ?? "https://n8n.secretbloom.tech/healthz",
  n8nApiKey: String(process.env.N8N_API_KEY ?? ""),
  n8nWebhookSecret: String(process.env.N8N_WEBHOOK_SECRET ?? ""),
  n8nTimeoutMs: Number(process.env.N8N_TIMEOUT_MS ?? 15000),
  dataEncryptionKey,
  documentStoragePath: process.env.DOCUMENT_STORAGE_PATH ?? new URL("../storage", import.meta.url).pathname,
  documentUploadMaxBytes: Math.min(50, Math.max(1, Number(process.env.DOCUMENT_UPLOAD_MAX_MB ?? 20))) * 1024 * 1024,
  signatureUploadMaxBytes: Math.min(5, Math.max(1, Number(process.env.SIGNATURE_UPLOAD_MAX_MB ?? 3))) * 1024 * 1024,
  templateUploadMaxBytes: Math.min(25, Math.max(1, Number(process.env.TEMPLATE_UPLOAD_MAX_MB ?? 10))) * 1024 * 1024,
  ocrEnabled: process.env.OCR_ENABLED === "true",
  ocrLanguage: String(process.env.OCR_LANGUAGE ?? "spa+eng"),
  ocrMaxPages: boundedNumber(process.env.OCR_MAX_PAGES, 8, 1, 25),
  publicOcrMaxPages: boundedNumber(process.env.PUBLIC_OCR_MAX_PAGES, 120, 1, 200),
  ocrMaxImagePixels: boundedNumber(process.env.OCR_MAX_IMAGE_PIXELS, 12_000_000, 1_000_000, 30_000_000),
  clamavEnabled: process.env.CLAMAV_ENABLED === "true",
  clamavHost: String(process.env.CLAMAV_HOST ?? "127.0.0.1"),
  clamavPort: boundedNumber(process.env.CLAMAV_PORT, 3310, 1, 65535),
  malwareScanRequired: process.env.MALWARE_SCAN_REQUIRED === "true",
  redisUrl: String(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0"),
  chatMessagesPerHour: boundedNumber(process.env.CHAT_MESSAGES_PER_HOUR, 20, 1, 100),
  chatMaxPromptChars: boundedNumber(process.env.CHAT_MAX_PROMPT_CHARS, 4000, 500, 12000),
  chatWorkflowTimeoutMs: boundedNumber(process.env.CHAT_WORKFLOW_TIMEOUT_MS, 60000, 10000, 120000),
  subscriptionEnforced: process.env.SUBSCRIPTION_ENFORCED === "true",
  boldEnvironment: process.env.BOLD_ENVIRONMENT === "production" ? "production" : "test",
  boldApiBaseUrl: String(process.env.BOLD_API_BASE_URL ?? "https://integrations.api.bold.co").replace(/\/$/, ""),
  boldIdentityKey: String(process.env.BOLD_IDENTITY_KEY ?? ""),
  boldSecretKey: String(process.env.BOLD_SECRET_KEY ?? ""),
  boldCheckoutTtlMinutes: boundedNumber(process.env.BOLD_CHECKOUT_TTL_MINUTES, 30, 10, 1440),
  boldCallbackUrl: String(process.env.BOLD_CALLBACK_URL ?? `${originList[0]}/acceso?billing=return`),
  smtpHost: String(process.env.SMTP_HOST ?? ""),
  smtpPort: boundedNumber(process.env.SMTP_PORT, 587, 1, 65535),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: String(process.env.SMTP_USER ?? ""),
  smtpPassword: String(process.env.SMTP_PASSWORD ?? ""),
  notificationFromEmail: String(process.env.NOTIFICATION_FROM_EMAIL ?? ""),
  whatsappGraphApiVersion: String(process.env.WHATSAPP_GRAPH_API_VERSION ?? "v23.0"),
  whatsappPhoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? ""),
  whatsappAccessToken: String(process.env.WHATSAPP_ACCESS_TOKEN ?? ""),
  notificationWorkerBatch: boundedNumber(process.env.NOTIFICATION_WORKER_BATCH, 20, 1, 100),
  internalApiBaseUrl: String(process.env.INTERNAL_API_BASE_URL ?? "http://127.0.0.1:4001").replace(/\/$/, ""),
  workflowUrls: Object.freeze({
    "WF-008": String(process.env.N8N_WF008_WEBHOOK_URL ?? `${String(process.env.N8N_BASE_URL ?? "https://n8n.secretbloom.tech").replace(/\/$/, "")}/webhook/cernoia/wf-008`),
    "WF-019": String(process.env.N8N_WF019_WEBHOOK_URL ?? ""),
    "WF-011": String(process.env.N8N_WF011_WEBHOOK_URL ?? ""),
    "WF-005": String(process.env.N8N_WF005_WEBHOOK_URL ?? ""),
    "WF-014": String(process.env.N8N_WF014_WEBHOOK_URL ?? ""),
    "WF-015": String(process.env.N8N_WF015_WEBHOOK_URL ?? ""),
    "WF-022": String(process.env.N8N_WF022_WEBHOOK_URL ?? ""),
    "WF-023": String(process.env.N8N_WF023_WEBHOOK_URL ?? ""),
    "WF-024": String(process.env.N8N_WF024_WEBHOOK_URL ?? ""),
  }),
});
