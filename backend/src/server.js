import {preparationRouter} from './routes/opportunity-preparation.js';
import {marketingRouter} from './routes/marketing.js';
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { pool, authPool, query } from "./db.js";
import { validateOrigin } from "./middleware/origin.js";
import { validateCsrf } from "./middleware/csrf.js";
import { authRouter } from "./routes/auth.js";
import { accountRouter } from "./routes/account.js";
import { dataRouter } from "./routes/data.js";
import { documentsRouter } from "./routes/documents.js";
import { workflowRouter } from "./routes/workflows.js";
import { proposalsRouter } from "./routes/proposals.js";
import { billingIntegrationRouter, billingRouter, billingWebhookRouter } from "./routes/billing.js";
import { chatRouter } from "./routes/chat.js";
import { marketRouter } from "./routes/market.js";
import { notificationsRouter } from "./routes/notifications.js";
import { operationsRouter } from "./routes/operations.js";
import { templatesRouter } from "./routes/templates.js";
import { platformRouter } from "./routes/platform.js";
import { ownerUsersRouter } from "./routes/owner-users.js";
import { companyMatrixRouter } from "./routes/company-matrix.js";
import { youtubeRouter, startYoutubeWorker } from "./routes/youtube.js";
import { contentRouter } from "./routes/content.js";
import { campaignOwnerRouter, campaignIntegrationRouter, campaignPublicRouter } from "./routes/campaigns.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    const error = new Error("Origen no permitido por CORS.");
    error.statusCode = 403;
    return callback(error);
  },
  credentials: true,
}));
app.use("/api/billing", billingWebhookRouter);
app.use("/api/campaign-public", campaignPublicRouter);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(validateOrigin);
app.use(validateCsrf);

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "connected", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable" });
  }
});
app.use("/api/auth", authRouter);
app.use("/api/marketing", marketingRouter);
app.use("/api", campaignOwnerRouter);
app.use("/api", campaignIntegrationRouter);
app.use("/api", youtubeRouter);
app.use("/api", platformRouter);
app.use("/api", ownerUsersRouter);
app.use("/api", companyMatrixRouter);
app.use("/api", contentRouter);
app.use("/api", documentsRouter);
app.use("/api", accountRouter);
app.use("/api", proposalsRouter);
app.use("/api", billingIntegrationRouter);
app.use("/api", billingRouter);
app.use("/api", chatRouter);
app.use("/api", marketRouter);
app.use("/api", notificationsRouter);
app.use("/api", operationsRouter);
app.use("/api", templatesRouter);
app.use("/api/workflows", workflowRouter);
app.use("/api", preparationRouter);
app.use("/api", dataRouter);

app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use((error, _req, res, _next) => {
  void _next;
  const status = error.type === "entity.too.large"
    ? 413
    : error.code === "22P02"
      ? 400
      : Number(error.statusCode ?? 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "Ocurrió un error interno." : error.message });
});

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`Cernoia API escuchando en http://127.0.0.1:${config.port}`);
  startYoutubeWorker();
});

async function shutdown(signal) {
  console.log(`${signal}: cerrando Cernoia API...`);
  server.close(async () => {
    await Promise.all([pool.end(), authPool.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
