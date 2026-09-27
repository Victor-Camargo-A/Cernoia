import "dotenv/config";
import Redis from "ioredis";
import { pool, query } from "../src/db.js";
import { config } from "../src/config.js";
import { checkN8nHealth, inspectN8nWorkflows } from "../src/services/n8n.js";
import { scanForMalware } from "../src/services/malware-scanner.js";

const requiredRelations = [
  "secop.processes", "secop.process_documents", "saas.organizations", "saas.process_matches",
  "saas.organization_capability_profiles", "saas.opportunity_ai_analyses", "saas.organization_documents",
  "saas.opportunity_documents", "saas.opportunity_requirements", "saas.opportunity_requirement_matrices",
  "saas.opportunity_compliance_evaluations", "saas.opportunity_action_plans", "saas.app_signature_profiles",
  "saas.document_alerts", "saas.alert_digests", "saas.proposal_packages", "ops.workflow_runs", "ops.sync_cursors",
  "saas.subscriptions", "saas.billing_orders", "saas.chat_threads", "saas.chat_messages",
  "saas.notification_channels", "saas.notification_outbox", "saas.document_extraction_reviews",
  "saas.document_templates", "saas.generated_template_documents", "saas.bold_webhook_events",
  "ops.ai_quota_events", "ops.ai_quota_policies", "ops.dead_letter_jobs",
];
const requiredFunctions = ["consolidate_opportunity_requirement_matrix_v1", "evaluate_opportunity_compliance_v3", "generate_opportunity_action_plan_v1"];
const requiredWorkflows = ["WF-001", "WF-002", "WF-003", "WF-005", "WF-007", "WF-008", "WF-011", "WF-012", "WF-013", "WF-014", "WF-015", "WF-016", "WF-017", "WF-018", "WF-019", "WF-020", "WF-021", "WF-022", "WF-023", "WF-024", "WF-025", "WF-026"];

let failed = false;
try {
  const [relations, functions, health, inventory] = await Promise.all([
    query("SELECT name, to_regclass(name) IS NOT NULL AS ready FROM UNNEST($1::TEXT[]) AS required(name)", [requiredRelations]),
    query(`SELECT name, EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'saas' AND p.proname = required.name) AS ready FROM UNNEST($1::TEXT[]) AS required(name)`, [requiredFunctions]),
    checkN8nHealth(),
    inspectN8nWorkflows(),
  ]);
  const databaseItems = [...relations.rows, ...functions.rows.map((item) => ({ name: `saas.${item.name}()`, ready: item.ready }))];
  console.log("\nBASE DE DATOS");
  console.table(databaseItems.map((item) => ({ componente: item.name, estado: item.ready ? "LISTO" : "FALTA" })));
  if (databaseItems.some((item) => !item.ready)) failed = true;

  console.log("n8n:", health.online ? "EN LÍNEA" : "NO RESPONDE");
  if (!health.online) failed = true;
  if (!inventory.available) {
    console.log("Inventario n8n: NO VERIFICADO. Revisa N8N_API_KEY en backend/.env.");
    failed = true;
  } else {
    const records = requiredWorkflows.map((code) => {
      const workflow = inventory.workflows.find((item) => item.name.startsWith("[CernoIA PROD]") && item.name.includes(code));
      return { workflow: code, estado: !workflow ? "FALTA" : workflow.active ? "PUBLICADO" : "SIN PUBLICAR" };
    });
    console.table(records);
    if (records.some((item) => item.estado !== "PUBLICADO")) failed = true;
  }

  const integrationItems = [
    ["N8N_WEBHOOK_SECRET", Boolean(config.n8nWebhookSecret)],
    ["Webhook WF-011", Boolean(config.workflowUrls["WF-011"])],
    ["Webhook WF-019", Boolean(config.workflowUrls["WF-019"])],
    ["Webhook WF-022", Boolean(config.workflowUrls["WF-022"])],
    ["Webhook WF-023", Boolean(config.workflowUrls["WF-023"])],
    ["Webhook WF-024", Boolean(config.workflowUrls["WF-024"])],
  ].map(([component, ready]) => ({ component, status: ready ? "LISTO" : "FALTA" }));
  console.log("\nINTEGRACIONES PRIVADAS");
  console.table(integrationItems);
  if (integrationItems.some((item) => item.status !== "LISTO")) failed = true;

  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const response = await redis.ping();
    console.log("Redis:", response === "PONG" ? "LISTO" : "RESPUESTA INESPERADA");
    if (response !== "PONG") failed = true;
  } catch (error) {
    console.log("Redis: FALTA -", error.message);
    failed = true;
  } finally {
    redis.disconnect();
  }

  if (config.clamavEnabled) {
    try {
      const scan = await scanForMalware(Buffer.from("CernoIA readiness check"));
      console.log("ClamAV:", scan.status === "clean" ? "LISTO" : scan.status.toUpperCase());
      if (scan.status !== "clean" && config.malwareScanRequired) failed = true;
    } catch (error) {
      console.log("ClamAV: FALTA -", error.message);
      if (config.malwareScanRequired) failed = true;
    }
  } else {
    console.log("ClamAV:", config.malwareScanRequired ? "FALTA" : "NO EXIGIDO");
    if (config.malwareScanRequired) failed = true;
  }

  const boldReady = Boolean(config.boldIdentityKey && config.boldSecretKey);
  console.log("Bold:", boldReady ? "CONFIGURADO" : config.subscriptionEnforced ? "FALTA" : "PENDIENTE DE ACEPTACIÓN");
  if (config.subscriptionEnforced && !boldReady) failed = true;

  console.log(failed ? "\nRESULTADO: configuración incompleta." : "\nRESULTADO: CernoIA está lista para iniciar el pipeline.");
  process.exitCode = failed ? 1 : 0;
} finally {
  await pool.end();
}
