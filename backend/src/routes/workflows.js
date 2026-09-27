import { requestOpportunityAnalysis } from "../services/opportunity-analysis.js";
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/subscription.js";
import { query } from "../db.js";
import { config } from "../config.js";
import { checkN8nHealth, inspectN8nWorkflows, runWorkflow } from "../services/n8n.js";
import { writeAudit } from "../audit.js";

export const workflowRouter = Router();
workflowRouter.use(requireAuth);

workflowRouter.get("/health", async (_req, res) => res.json(await checkN8nHealth()));

const PIPELINE_STAGES = Object.freeze([
  ["WF-001", "Sincronización de procesos"],
  ["WF-002", "Historial de cambios"],
  ["WF-003", "Metadatos documentales"],
  ["WF-005", "Coincidencias empresariales"],
  ["WF-008", "Preanálisis con IA"],
  ["WF-013", "Selección documental"],
  ["WF-014", "Extracción de documentos"],
  ["WF-015", "Extracción de requisitos"],
  ["WF-016", "Consolidación de requisitos"],
  ["WF-012", "Vigencias empresariales"],
  ["WF-017", "Evaluación de cumplimiento"],
  ["WF-018", "Plan de acción"],
]);

const SUPPORT_WORKFLOWS = Object.freeze([
  ["WF-007", "Gestión global de errores"],
  ["WF-011", "Validación de documentos empresariales"],
  ["WF-020", "Control de cuota de IA con Redis"],
  ["WF-021", "Alertas documentales inteligentes"],
  ["WF-022", "Generación de propuestas"],
  ["WF-023", "Chat CernoIA controlado"],
  ["WF-024", "OCR y revisión documental"],
  ["WF-025", "Entrega de notificaciones"],
  ["WF-026", "Renovaciones y conciliación Bold"],
  ["WF-019", "Orquestador principal"],
]);

workflowRouter.get("/readiness", async (_req, res, next) => {
  try {
    const requiredRelations = [
      "secop.processes",
      "secop.process_documents",
      "saas.organizations",
      "saas.process_matches",
      "saas.organization_capability_profiles",
      "saas.opportunity_ai_analyses",
      "saas.organization_documents",
      "saas.opportunity_documents",
      "saas.opportunity_requirements",
      "saas.opportunity_requirement_matrices",
      "saas.opportunity_compliance_evaluations",
      "saas.opportunity_action_plans",
      "saas.app_signature_profiles",
      "saas.document_alerts",
      "saas.alert_digests",
      "saas.proposal_packages",
      "saas.subscriptions",
      "saas.billing_orders",
      "saas.chat_threads",
      "saas.chat_messages",
      "saas.notification_channels",
      "saas.notification_outbox",
      "saas.document_extraction_reviews",
      "saas.document_templates",
      "saas.generated_template_documents",
      "ops.workflow_runs",
      "ops.sync_cursors",
      "ops.ai_quota_events",
      "ops.ai_quota_policies",
      "ops.dead_letter_jobs",
    ];
    const requiredFunctions = [
      "consolidate_opportunity_requirement_matrix_v1",
      "evaluate_opportunity_compliance_v3",
      "generate_opportunity_action_plan_v1",
    ];

    const [health, inventory, relations, functions] = await Promise.all([
      checkN8nHealth(),
      inspectN8nWorkflows(),
      query(
        `SELECT required.relation_name, to_regclass(required.relation_name) IS NOT NULL AS ready
         FROM UNNEST($1::TEXT[]) AS required(relation_name)`,
        [requiredRelations],
      ),
      query(
        `SELECT required.function_name, EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'saas' AND p.proname = required.function_name
         ) AS ready
         FROM UNNEST($1::TEXT[]) AS required(function_name)`,
        [requiredFunctions],
      ),
    ]);

    const missingDatabaseObjects = [
      ...relations.rows.filter((row) => !row.ready).map((row) => row.relation_name),
      ...functions.rows.filter((row) => !row.ready).map((row) => `saas.${row.function_name}()`),
    ];
    const workflowByCode = new Map();
    for (const workflow of inventory.workflows) {
      if (!workflow.name.startsWith("[CernoIA PROD]")) continue;
      const code = workflow.name.match(/WF-\d{3}/)?.[0];
      const current = code ? workflowByCode.get(code) : null;
      if (code && (!current || (!current.active && workflow.active))) workflowByCode.set(code, workflow);
    }
    const statusFor = ([code, name]) => {
      const workflow = workflowByCode.get(code);
      return {
        code,
        name,
        status: !inventory.available ? "unverified" : !workflow ? "missing" : workflow.active ? "active" : "inactive",
      };
    };
    const stages = PIPELINE_STAGES.map(statusFor);
    const supportWorkflows = SUPPORT_WORKFLOWS.map(statusFor);
    const webhookConfigured = Boolean(config.workflowUrls["WF-019"] && config.n8nWebhookSecret);
    const documentWebhookConfigured = Boolean(config.workflowUrls["WF-011"] && config.n8nWebhookSecret);
    const proposalWebhookConfigured = Boolean(config.workflowUrls["WF-022"] && config.n8nWebhookSecret);
    const chatWebhookConfigured = Boolean(config.workflowUrls["WF-023"] && config.n8nWebhookSecret);
    const ocrWebhookConfigured = Boolean(config.workflowUrls["WF-024"] && config.n8nWebhookSecret);
    const workflowsReady = inventory.available
      ? [...stages, ...supportWorkflows].every((workflow) => workflow.status === "active")
      : null;
    const databaseReady = missingDatabaseObjects.length === 0;
    const baseConnectionReady = Boolean(
      health.online
        && webhookConfigured
        && documentWebhookConfigured
        && proposalWebhookConfigured
        && chatWebhookConfigured
        && ocrWebhookConfigured
        && databaseReady,
    );
    const pipelineReady = Boolean(baseConnectionReady && workflowsReady);
    const configurationProblems = [];
    if (!health.online) configurationProblems.push("n8n no responde en su URL de salud");
    if (!webhookConfigured) configurationProblems.push("falta configurar el webhook WF-019 o su secreto");
    if (!documentWebhookConfigured) configurationProblems.push("falta configurar el webhook WF-011 o su secreto");
    if (!proposalWebhookConfigured) configurationProblems.push("falta configurar el webhook WF-022 o su secreto");
    if (!chatWebhookConfigured) configurationProblems.push("falta configurar el webhook WF-023 o su secreto");
    if (!ocrWebhookConfigured) configurationProblems.push("falta configurar el webhook WF-024 o su secreto");
    if (!inventory.available) configurationProblems.push("N8N_API_KEY no permite verificar workflows publicados");
    if (inventory.available && !workflowsReady) configurationProblems.push("hay workflows CernoIA PROD ausentes o sin publicar");
    if (!databaseReady) configurationProblems.push("faltan objetos de base de datos");

    res.json({
      online: Boolean(health.online),
      can_start: pipelineReady,
      base_connection_ready: baseConnectionReady,
      pipeline_ready: pipelineReady,
      inventory_verified: inventory.available,
      database_ready: databaseReady,
      webhook_configured: webhookConfigured,
      document_webhook_configured: documentWebhookConfigured,
      proposal_webhook_configured: proposalWebhookConfigured,
      chat_webhook_configured: chatWebhookConfigured,
      ocr_webhook_configured: ocrWebhookConfigured,
      stages,
      support_workflows: supportWorkflows,
      missing_database_objects: missingDatabaseObjects,
      configuration_problems: configurationProblems,
    });
  } catch (error) {
    next(error);
  }
});

workflowRouter.post("/:code/run", requireEntitlement("market_intelligence"), requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const code = String(req.params.code ?? "").toUpperCase();
    // Los flujos internos son encadenados por la orquestación. El cliente solo
    // puede iniciar el punto de entrada aprobado para evitar estados parciales.
    if (code !== "WF-019") {
      return res.status(400).json({ error: "Workflow no permitido." });
    }
    const result = await runWorkflow(code, {
      organization_id: req.user.organization_id,
      requested_by_user_id: req.user.id,
      process_id: req.body?.process_id ?? null,
      processing_mode: req.body?.processing_mode ?? "all",
    });
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "workflow.run",
      entityType: "workflow",
      entityId: code,
      metadata: { process_id: req.body?.process_id ?? null },
      req,
    });
    res.status(202).json({ accepted: true, operation: "market_intelligence_refresh", result });
  } catch (error) {
    next(error);
  }
});

workflowRouter.post('/analyses/:processId', requireEntitlement('market_intelligence'), requireRole('owner','admin'), async (req,res,next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.processId)) return res.status(400).json({error:'Proceso no válido.'});
    const analysis=await requestOpportunityAnalysis(req.user.organization_id,req.user.id,req.params.processId);
    res.status(202).json({analysis, estimated_seconds:240});
  } catch(error) {next(error);}
});
workflowRouter.get('/analyses/:analysisId', async(req,res,next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.analysisId)) return res.status(400).json({error:'Análisis no válido.'});
    const result=await query(`SELECT id,process_id,analysis_status,queued_at,started_at,finished_at,
      analysis_result->>'quota_deferred_at' AS quota_deferred_at,
      saas.analysis_matrix_metadata(capability_snapshot,organization_id) AS company_matrix,
      compatibility_score,executive_summary FROM saas.opportunity_ai_analyses WHERE id=$1 AND organization_id=$2`,[req.params.analysisId,req.user.organization_id]);
    if(!result.rowCount) return res.status(404).json({error:'Análisis no encontrado.'});
    res.json({analysis:result.rows[0]});
  }catch(error){next(error);}
});
