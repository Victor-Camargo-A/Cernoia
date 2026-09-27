#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = join(projectRoot, "n8n/workflows");

const CREDENTIALS = Object.freeze({
  postgres: { postgres: { id: "YdZl2oI4ndBEPoWO", name: "Postgres account" } },
  gemini: { googlePalmApi: { id: "ZfWqIHhxn1PfcxaP", name: "Google Gemini(PaLM) Api account" } },
  redis: { redis: { id: "REPLACE_CERNOIA_REDIS", name: "CernoIA Redis" } },
  header: { httpHeaderAuth: { id: "REPLACE_CERNOIA_HEADER_AUTH", name: "CernoIA Webhook Secret" } },
});

const WORKFLOW_IDS = Object.freeze({
  "WF-020": "j8pT4mQ2xR6vN9sL",
  "WF-021": "r3D7kM9pQ2vX5nLs",
  "WF-022": "u6P2cR8mT4yK9wQz",
});

const FILES = Object.freeze({
  "WF-008": "WF-008-preanalisis-ia.json",
  "WF-011": "WF-011-validacion-documento-empresarial.json",
  "WF-015": "WF-015-extraccion-ia-requisitos.json",
  "WF-020": "WF-020-control-cuota-gemini-redis.json",
  "WF-021": "WF-021-alertas-documentales-ia.json",
  "WF-022": "WF-022-generacion-paquete-propuesta.json",
});

const INPUT_FIELDS = [
  "provider",
  "model_name",
  "workflow_code",
  "organization_id",
  "request_id",
  "payload_json",
  "rpm_limit",
  "rpd_limit",
];

function edge(node, type = "main", index = 0) {
  return { node, type, index };
}

function setMain(workflow, source, outputs) {
  workflow.connections[source] = { main: outputs.map((nodes) => nodes.map((name) => edge(name))) };
}

function inputSchema(fields) {
  return fields.map((name) => ({
    id: name,
    displayName: name,
    required: false,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type: ["rpm_limit", "rpd_limit"].includes(name) ? "number" : "string",
    removed: false,
  }));
}

function workflowInputValues(fields) {
  return fields.map((name) => ({ name }));
}

function manualNode(code, position, suffix = "001") {
  return {
    parameters: {},
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name: `Inicio Manual ${code}`,
  };
}

function executeTriggerNode(code, fields, position, suffix = "002") {
  return {
    parameters: { workflowInputs: { values: workflowInputValues(fields) } },
    type: "n8n-nodes-base.executeWorkflowTrigger",
    typeVersion: 1.2,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name: `Entrada desde otro workflow ${code}`,
  };
}

function codeNode(code, name, jsCode, position, suffix) {
  return {
    parameters: { jsCode },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name,
  };
}

function postgresNode(code, name, query, queryReplacement, position, suffix) {
  return {
    parameters: {
      operation: "executeQuery",
      query,
      options: { queryReplacement },
    },
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.6,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name,
    credentials: CREDENTIALS.postgres,
  };
}

function ifTrueNode(code, name, expression, position, suffix) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
        conditions: [{
          id: `${code.slice(-3)}000000-0000-4000-8000-000000001${suffix}`,
          leftValue: expression,
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        }],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.3,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name,
  };
}

function redisIncrementNode(code, name, key, ttl, position, suffix) {
  return {
    parameters: { operation: "incr", key, expire: true, ttl },
    type: "n8n-nodes-base.redis",
    typeVersion: 1,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name,
    credentials: CREDENTIALS.redis,
  };
}

function executeWorkflowNode({ code, name, workflowId, cachedName, value, fields, position, suffix }) {
  return {
    parameters: {
      workflowId: {
        __rl: true,
        value: workflowId,
        mode: "list",
        cachedResultUrl: `/workflow/${workflowId}`,
        cachedResultName: cachedName,
      },
      workflowInputs: {
        mappingMode: "defineBelow",
        value,
        matchingColumns: [],
        schema: inputSchema(fields),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: { waitForSubWorkflow: true },
    },
    type: "n8n-nodes-base.executeWorkflow",
    typeVersion: 1.3,
    position,
    id: `${code.slice(-3)}000000-0000-4000-8000-000000000${suffix}`,
    name,
    alwaysOutputData: true,
  };
}

function quotaCall(code, position, suffix) {
  return executeWorkflowNode({
    code,
    name: `Reservar cuota Gemini ${code}`,
    workflowId: WORKFLOW_IDS["WF-020"],
    cachedName: "[CernoIA PROD] WF-020 — Control de cuota Gemini con Redis",
    fields: INPUT_FIELDS,
    position,
    suffix,
    value: {
      provider: "google",
      model_name: "={{ $json.model_name ?? $json.ai_requirement_model ?? 'models/gemini-3.1-flash-lite' }}",
      workflow_code: code,
      organization_id: "={{ $json.organization_id ?? '' }}",
      request_id: `={{ $json.analysis_id ?? $json.opportunity_document_id ?? $json.organization_document_id ?? $json.proposal_package_id ?? '${code}-' + $execution.id }}`,
      payload_json: "={{ JSON.stringify($json) }}",
      rpm_limit: "={{ Number($json.gemini_rpm_limit ?? 0) }}",
      rpd_limit: "={{ Number($json.gemini_rpd_limit ?? 0) }}",
    },
  });
}

function baseWorkflow(code, title, id, nodes, connections) {
  return {
    name: `[CernoIA PROD] ${code} — ${title}`,
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: {
      executionOrder: "v1",
      timezone: "America/Bogota",
      callerPolicy: "workflowsFromSameOwner",
      errorWorkflow: "AVQTQyh3FwAMYgwW",
    },
    versionId: `${code.slice(-3)}000000-0000-4000-8000-000000000099`,
    id,
    tags: [],
  };
}

function buildWorkflow020() {
  const code = "WF-020";
  const nodes = [
    manualNode(code, [-920, -120]),
    executeTriggerNode(code, INPUT_FIELDS, [-920, 80]),
    codeNode(code, "Normalizar solicitud de cuota WF-020", `const raw = $input.first()?.json ?? {};
let payload = {};
try {
  payload = typeof raw.payload_json === 'string' && raw.payload_json.trim()
    ? JSON.parse(raw.payload_json)
    : (raw.payload && typeof raw.payload === 'object' ? raw.payload : {});
} catch {
  throw new Error('payload_json no contiene JSON válido para WF-020');
}
const clean = (value, fallback, max = 120) => {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, max);
  return text || fallback;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const provider = clean(raw.provider, 'google', 40);
const modelName = clean(raw.model_name, 'models-gemini-3.1-flash-lite', 120);
const workflowCode = /^WF-\\d{3}$/i.test(String(raw.workflow_code ?? '')) ? String(raw.workflow_code).toUpperCase() : 'WF-UNKNOWN';
const organizationId = uuid.test(String(raw.organization_id ?? '')) ? String(raw.organization_id) : '';
const requestId = String(raw.request_id ?? workflowCode + '-' + $execution.id).replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 180);
const optionalInteger = (value, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(maximum, Math.max(minimum, parsed))
    : null;
};
const requestedRpmLimit = optionalInteger(raw.rpm_limit, 1, 10000);
const requestedRpdLimit = optionalInteger(raw.rpd_limit, 1, 10000000);
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
const quotaDay = parts.year + '-' + parts.month + '-' + parts.day;
const dailyKey = ['cernoia', 'ai-quota', 'v1', provider, modelName, 'day', quotaDay].join(':');
return [{ json: {
  ...payload,
  quota_payload_json: JSON.stringify(payload), provider, model_name: String(raw.model_name ?? 'models/gemini-3.1-flash-lite'),
  model_key: modelName, workflow_code: workflowCode, organization_id: organizationId, request_id: requestId,
  requested_rpm_limit: requestedRpmLimit, requested_rpd_limit: requestedRpdLimit,
  quota_day: quotaDay, daily_key: dailyKey,
  n8n_execution_id: String($execution.id ?? ''), wait_attempts: 0
} }];`, [-656, -16], "003"),
    postgresNode(code, "Cargar política de cuota WF-020", `SELECT
  COALESCE($3::INTEGER, policy.rpm_limit, 8)::INTEGER AS rpm_limit,
  COALESCE($4::INTEGER, policy.rpd_limit, 400)::INTEGER AS rpd_limit,
  CASE WHEN $3::INTEGER IS NOT NULL OR $4::INTEGER IS NOT NULL THEN 'workflow_override'
       WHEN policy.id IS NOT NULL THEN 'database_policy' ELSE 'safe_default' END AS quota_policy_source
FROM (SELECT 1) seed
LEFT JOIN LATERAL (
  SELECT id, rpm_limit, rpd_limit
  FROM ops.ai_quota_policies
  WHERE provider = $1 AND model_name = $2 AND is_active = TRUE
  ORDER BY updated_at DESC
  LIMIT 1
) policy ON TRUE;`, "={{ [ String($json.provider), String($json.model_name), $json.requested_rpm_limit === null ? null : Number($json.requested_rpm_limit), $json.requested_rpd_limit === null ? null : Number($json.requested_rpd_limit) ] }}", [-416, -16], "017"),
    codeNode(code, "Aplicar política de cuota WF-020", `const context = $('Normalizar solicitud de cuota WF-020').first().json;
const rpmLimit = Math.max(1, Number($json.rpm_limit ?? 8));
const rpdLimit = Math.max(1, Number($json.rpd_limit ?? 400));
return [{ json: { ...context, rpm_limit: rpmLimit, rpd_limit: rpdLimit,
  quota_policy_source: String($json.quota_policy_source ?? 'safe_default') } }];`, [-176, -16], "018"),
    redisIncrementNode(code, "Reservar cupo diario Redis WF-020", "={{ $('Aplicar política de cuota WF-020').first().json.daily_key }}", 172800, [64, -16], "004"),
    codeNode(code, "Evaluar límite diario WF-020", `const context = $('Aplicar política de cuota WF-020').first().json;
const dailyUsed = Number($json[context.daily_key] ?? 0);
return [{ json: { ...context, daily_used: dailyUsed, daily_allowed: dailyUsed <= context.rpd_limit } }];`, [304, -16], "005"),
    ifTrueNode(code, "¿Hay cupo diario WF-020?", "={{ $json.daily_allowed === true }}", [544, -16], "006"),
    codeNode(code, "Preparar ventana por minuto WF-020", `const base = $('Evaluar límite diario WF-020').first().json;
const now = new Date();
const epochMinute = Math.floor(now.getTime() / 60000);
const minuteKey = ['cernoia', 'ai-quota', 'v1', base.provider, base.model_key, 'minute', epochMinute].join(':');
const waitAttempts = Number($json.wait_attempts ?? base.wait_attempts ?? 0);
return [{ json: { ...base, minute_key: minuteKey, minute_epoch: epochMinute, wait_attempts: waitAttempts } }];`, [784, -112], "007"),
    redisIncrementNode(code, "Reservar cupo minuto Redis WF-020", "={{ $('Preparar ventana por minuto WF-020').item.json.minute_key }}", 120, [1024, -112], "008"),
    codeNode(code, "Evaluar límite por minuto WF-020", `const context = $('Preparar ventana por minuto WF-020').item.json;
const minuteUsed = Number($json[context.minute_key] ?? 0);
const milliseconds = Date.now() % 60000;
const retryAfter = Math.max(2, Math.ceil((60000 - milliseconds) / 1000) + (context.request_id.length % 3));
return [{ json: { ...context, minute_used: minuteUsed, minute_allowed: minuteUsed <= context.rpm_limit, retry_after_seconds: retryAfter } }];`, [1264, -112], "009"),
    ifTrueNode(code, "¿Hay cupo por minuto WF-020?", "={{ $json.minute_allowed === true }}", [1504, -112], "010"),
    postgresNode(code, "Registrar reserva concedida WF-020", `WITH logged AS (
  INSERT INTO ops.ai_quota_events
    (provider, model_name, workflow_code, request_id, organization_id, n8n_execution_id,
     outcome, minute_used, minute_limit, daily_used, daily_limit, retry_after_seconds, metadata)
  VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, '')::UUID, NULLIF($6, ''),
          'granted', $7::INTEGER, $8::INTEGER, $9::INTEGER, $10::INTEGER, 0,
          jsonb_build_object('quota_day', $11::TEXT, 'controller', 'redis_atomic_incr_v1',
                             'policy_source', $12::TEXT))
  RETURNING id
)
SELECT id AS quota_event_id FROM logged;`, "={{ [ $json.provider, $json.model_name, $json.workflow_code, $json.request_id, $json.organization_id, $json.n8n_execution_id, Number($json.minute_used), Number($json.rpm_limit), Number($json.daily_used), Number($json.rpd_limit), $json.quota_day, String($json.quota_policy_source ?? 'safe_default') ] }}", [1744, -208], "011"),
    codeNode(code, "Conceder llamada Gemini WF-020", `const context = $('Evaluar límite por minuto WF-020').item.json;
let payload = {};
try { payload = JSON.parse(context.quota_payload_json || '{}'); } catch {}
return [{ json: { ...payload, quota_granted: true, quota_reason: 'granted', quota_provider: context.provider,
  quota_model: context.model_name, quota_minute_used: context.minute_used, quota_minute_limit: context.rpm_limit,
  quota_daily_used: context.daily_used, quota_daily_limit: context.rpd_limit,
  quota_policy_source: context.quota_policy_source, quota_request_id: context.request_id } }];`, [1984, -208], "012"),
    postgresNode(code, "Registrar espera de cuota WF-020", `WITH logged AS (
  INSERT INTO ops.ai_quota_events
    (provider, model_name, workflow_code, request_id, organization_id, n8n_execution_id,
     outcome, minute_used, minute_limit, daily_used, daily_limit, retry_after_seconds, metadata)
  VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, '')::UUID, NULLIF($6, ''),
          'minute_wait', $7::INTEGER, $8::INTEGER, $9::INTEGER, $10::INTEGER, $11::INTEGER,
          jsonb_build_object('wait_attempt', $12::INTEGER, 'controller', 'redis_atomic_incr_v1',
                             'policy_source', $13::TEXT))
  RETURNING id
)
SELECT id AS quota_event_id, $11::INTEGER AS retry_after_seconds, ($12::INTEGER + 1) AS wait_attempts FROM logged;`, "={{ [ $json.provider, $json.model_name, $json.workflow_code, $json.request_id, $json.organization_id, $json.n8n_execution_id, Number($json.minute_used), Number($json.rpm_limit), Number($json.daily_used), Number($json.rpd_limit), Number($json.retry_after_seconds), Number($json.wait_attempts ?? 0), String($json.quota_policy_source ?? 'safe_default') ] }}", [1744, 16], "013"),
    {
      parameters: { resume: "timeInterval", amount: "={{ Math.max(1, Number($json.retry_after_seconds ?? 5)) }}", unit: "seconds" },
      type: "n8n-nodes-base.wait",
      typeVersion: 1.1,
      position: [1984, 16],
      id: "02000000-0000-4000-8000-000000000014",
      name: "Esperar próxima ventana WF-020",
      webhookId: "02000000-0000-4000-8000-000000000114",
    },
    postgresNode(code, "Registrar límite diario WF-020", `WITH logged AS (
  INSERT INTO ops.ai_quota_events
    (provider, model_name, workflow_code, request_id, organization_id, n8n_execution_id,
     outcome, minute_used, minute_limit, daily_used, daily_limit, retry_after_seconds, metadata)
  VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, '')::UUID, NULLIF($6, ''),
          'daily_limit', NULL, $7::INTEGER, $8::INTEGER, $9::INTEGER, NULL,
          jsonb_build_object('quota_day', $10::TEXT, 'controller', 'redis_atomic_incr_v1',
                             'policy_source', $11::TEXT))
  RETURNING id
)
SELECT id AS quota_event_id FROM logged;`, "={{ [ $json.provider, $json.model_name, $json.workflow_code, $json.request_id, $json.organization_id, $json.n8n_execution_id, Number($json.rpm_limit), Number($json.daily_used), Number($json.rpd_limit), $json.quota_day, String($json.quota_policy_source ?? 'safe_default') ] }}", [784, 176], "015"),
    codeNode(code, "Denegar llamada por límite diario WF-020", `const context = $('Evaluar límite diario WF-020').first().json;
let payload = {};
try { payload = JSON.parse(context.quota_payload_json || '{}'); } catch {}
return [{ json: { ...payload, quota_granted: false, quota_reason: 'daily_limit', quota_provider: context.provider,
  quota_model: context.model_name, quota_daily_used: context.daily_used, quota_daily_limit: context.rpd_limit,
  quota_reset_timezone: 'America/Los_Angeles', quota_policy_source: context.quota_policy_source,
  quota_request_id: context.request_id } }];`, [1024, 176], "016"),
  ];
  const workflow = baseWorkflow(code, "Control de cuota Gemini con Redis", WORKFLOW_IDS[code], nodes, {});
  setMain(workflow, `Inicio Manual ${code}`, [["Normalizar solicitud de cuota WF-020"]]);
  setMain(workflow, `Entrada desde otro workflow ${code}`, [["Normalizar solicitud de cuota WF-020"]]);
  setMain(workflow, "Normalizar solicitud de cuota WF-020", [["Cargar política de cuota WF-020"]]);
  setMain(workflow, "Cargar política de cuota WF-020", [["Aplicar política de cuota WF-020"]]);
  setMain(workflow, "Aplicar política de cuota WF-020", [["Reservar cupo diario Redis WF-020"]]);
  setMain(workflow, "Reservar cupo diario Redis WF-020", [["Evaluar límite diario WF-020"]]);
  setMain(workflow, "Evaluar límite diario WF-020", [["¿Hay cupo diario WF-020?"]]);
  setMain(workflow, "¿Hay cupo diario WF-020?", [["Preparar ventana por minuto WF-020"], ["Registrar límite diario WF-020"]]);
  setMain(workflow, "Preparar ventana por minuto WF-020", [["Reservar cupo minuto Redis WF-020"]]);
  setMain(workflow, "Reservar cupo minuto Redis WF-020", [["Evaluar límite por minuto WF-020"]]);
  setMain(workflow, "Evaluar límite por minuto WF-020", [["¿Hay cupo por minuto WF-020?"]]);
  setMain(workflow, "¿Hay cupo por minuto WF-020?", [["Registrar reserva concedida WF-020"], ["Registrar espera de cuota WF-020"]]);
  setMain(workflow, "Registrar reserva concedida WF-020", [["Conceder llamada Gemini WF-020"]]);
  setMain(workflow, "Registrar espera de cuota WF-020", [["Esperar próxima ventana WF-020"]]);
  setMain(workflow, "Esperar próxima ventana WF-020", [["Preparar ventana por minuto WF-020"]]);
  setMain(workflow, "Registrar límite diario WF-020", [["Denegar llamada por límite diario WF-020"]]);
  return workflow;
}

function patchWorkflow008(workflow) {
  const code = "WF-008";
  const removable = new Set([
    "Reservar cuota Gemini WF-008",
    "¿Cuota Gemini concedida WF-008?",
    "Liberar análisis por cuota WF-008",
  ]);
  workflow.nodes = workflow.nodes.filter((node) => !removable.has(node.name));
  removable.forEach((name) => delete workflow.connections[name]);

  const model = workflow.nodes.find((node) => node.type === "@n8n/n8n-nodes-langchain.lmChatGoogleGemini");
  const agent = workflow.nodes.find((node) => node.name === "Analizar oportunidad AI Agent WF-008");
  const think = workflow.nodes.find((node) => node.type === "@n8n/n8n-nodes-langchain.toolThink");
  if (!model || !agent) throw new Error("WF-008 no contiene el modelo y agente esperados.");
  if (think) {
    workflow.nodes = workflow.nodes.filter((node) => node !== think);
    delete workflow.connections[think.name];
  }
  const oldModelName = model.name;
  model.name = "Gemini controlado WF-008";
  workflow.connections[model.name] = workflow.connections[oldModelName];
  if (oldModelName !== model.name) delete workflow.connections[oldModelName];
  agent.parameters.options = {
    ...(agent.parameters.options ?? {}),
    maxIterations: 1,
    returnIntermediateSteps: false,
    systemMessage: String(agent.parameters.options?.systemMessage ?? "")
      .replace(/9\. Utiliza el Think Tool[^\n]*\n?/i, "9. Realiza una única evaluación cuidadosa y conserva la incertidumbre cuando falte evidencia.\n")
      .replace("10. Devuelve", "10. Devuelve"),
  };
  agent.retryOnFail = false;
  agent.maxTries = 1;

  const quota = quotaCall(code, [688, 160], "020");
  const decision = ifTrueNode(code, "¿Cuota Gemini concedida WF-008?", "={{ $json.quota_granted === true }}", [912, 160], "021");
  const release = postgresNode(code, "Liberar análisis por cuota WF-008", `UPDATE saas.opportunity_ai_analyses
SET analysis_status = 'queued', error_message = 'Análisis aplazado: se alcanzó la cuota diaria configurada para Gemini.',
    analysis_result = COALESCE(analysis_result, '{}'::JSONB) || jsonb_build_object(
      'quota_deferred_at', NOW(), 'quota_reason', $2::TEXT, 'quota_daily_limit', $3::INTEGER),
    updated_at = NOW()
WHERE id = $1::UUID AND analysis_status = 'running'
RETURNING id AS analysis_id, organization_id, process_id, analysis_status;`, "={{ [ String($json.analysis_id ?? ''), String($json.quota_reason ?? 'daily_limit'), Number($json.quota_daily_limit ?? 0) ] }}", [1136, 288], "022");
  workflow.nodes.push(quota, decision, release);
  setMain(workflow, "Preparar entrada IA WF-008", [[quota.name]]);
  setMain(workflow, quota.name, [[decision.name]]);
  setMain(workflow, decision.name, [[agent.name], [release.name]]);
  setMain(workflow, release.name, [["Finalizar WF-008"]]);
  return workflow;
}

function patchWorkflow015(workflow) {
  const code = "WF-015";
  const removable = new Set([
    "Reservar cuota Gemini WF-015",
    "¿Cuota Gemini concedida WF-015?",
    "Liberar documento por cuota WF-015",
  ]);
  workflow.nodes = workflow.nodes.filter((node) => !removable.has(node.name));
  removable.forEach((name) => delete workflow.connections[name]);
  const agent = workflow.nodes.find((node) => node.name === "Analizar requisitos con IA WF-015");
  if (!agent) throw new Error("WF-015 no contiene el agente esperado.");
  agent.parameters.options = { ...(agent.parameters.options ?? {}), maxIterations: 1, returnIntermediateSteps: false };
  agent.retryOnFail = false;
  agent.maxTries = 1;

  const quota = quotaCall(code, [1280, -672], "020");
  const decision = ifTrueNode(code, "¿Cuota Gemini concedida WF-015?", "={{ $json.quota_granted === true }}", [1504, -672], "021");
  const release = postgresNode(code, "Liberar documento por cuota WF-015", `UPDATE saas.opportunity_documents
SET ai_requirement_status = 'queued',
    ai_requirement_attempt_count = GREATEST(COALESCE(ai_requirement_attempt_count, 1) - 1, 0),
    ai_requirement_error = 'Análisis aplazado: se alcanzó la cuota diaria configurada para Gemini.',
    metadata = (COALESCE(metadata, '{}'::JSONB) - 'active_requirement_execution_id' - 'active_requirement_started_at')
      || jsonb_build_object('quota_deferred_at', NOW(), 'quota_reason', $2::TEXT),
    updated_at = NOW()
WHERE id = $1::UUID AND ai_requirement_status = 'running'
RETURNING id AS opportunity_document_id, organization_id, process_id, ai_requirement_status;`, "={{ [ String($json.opportunity_document_id ?? ''), String($json.quota_reason ?? 'daily_limit') ] }}", [1728, -560], "022");
  workflow.nodes.push(quota, decision, release);
  setMain(workflow, "Preparar entrada IA WF-015", [[quota.name]]);
  setMain(workflow, quota.name, [[decision.name]]);
  setMain(workflow, decision.name, [[agent.name], [release.name]]);
  setMain(workflow, release.name, [["Finalizar ejecución exitosa WF-015"]]);
  return workflow;
}

function patchWorkflow011(workflow) {
  const code = "WF-011";
  const removable = new Set([
    "Reservar cuota Gemini WF-011",
    "¿Cuota Gemini concedida WF-011?",
    "Gemini fechas documentales WF-011",
    "Analizar identidad y fechas WF-011",
    "Normalizar fechas documentales WF-011",
    "Guardar clasificación y fechas WF-011",
    "Registrar IA documental diferida WF-011",
  ]);
  workflow.nodes = workflow.nodes.filter((node) => !removable.has(node.name));
  removable.forEach((name) => delete workflow.connections[name]);

  const saveExtraction = workflow.nodes.find((node) => node.name === "Guardar extracción WF-011");
  if (!saveExtraction) throw new Error("WF-011 no contiene Guardar extracción WF-011.");
  saveExtraction.parameters.query = `UPDATE saas.organization_documents
SET extraction_status = 'success', extracted_text = $3::TEXT, verification_status = 'review_required',
    ai_classification = COALESCE(ai_classification, '{}'::JSONB) || jsonb_build_object(
      'declared_document_type', document_type, 'character_count', $4::INTEGER,
      'classification_method', 'declared_type_and_pdf_text'),
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
      'wf011_text_extracted_at', NOW(), 'wf011_result', 'text_extracted'), updated_at = NOW()
WHERE id = $1::UUID AND organization_id = $2::UUID
RETURNING id AS organization_document_id, organization_id, document_type, document_name,
          extraction_status, verification_status, extracted_text, issue_date, expiration_date,
          policy_validity_days, alert_days_before, updated_at;`;

  const quota = quotaCall(code, [1184, -112], "020");
  const decision = ifTrueNode(code, "¿Cuota Gemini concedida WF-011?", "={{ $json.quota_granted === true }}", [1408, -112], "021");
  const model = {
    parameters: { modelName: "models/gemini-3.1-flash-lite", options: { maxOutputTokens: 1200, temperature: 0 } },
    type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
    typeVersion: 1.1,
    position: [1600, 128],
    id: "01100000-0000-4000-8000-000000000022",
    name: "Gemini fechas documentales WF-011",
    credentials: CREDENTIALS.gemini,
  };
  const agent = {
    parameters: {
      promptType: "define",
      text: `=Analiza este documento empresarial colombiano usando únicamente el texto suministrado.\n\nTipo declarado: {{ $json.document_type }}\nNombre: {{ $json.document_name }}\nTexto:\n{{ String($json.extracted_text ?? '').slice(0, 30000) }}`,
      options: {
        systemMessage: `Extrae metadatos verificables de un documento empresarial colombiano. No inventes fechas ni datos. Devuelve solamente JSON válido con: detected_document_type, detected_organization_type, organization_type_confidence, issue_date, expiration_date, issuing_entity, document_number, confidence, evidence, warnings. detected_organization_type solo puede ser legal_entity, natural_person, consortium, temporary_union, nonprofit, other o unconfirmed. Las fechas deben ser YYYY-MM-DD o cadena vacía. confidence y organization_type_confidence deben estar entre 0 y 1. Si un dato no aparece explícitamente, usa cadena vacía o unconfirmed. No emitas concepto jurídico y no uses markdown.`,
        maxIterations: 1,
        returnIntermediateSteps: false,
      },
    },
    type: "@n8n/n8n-nodes-langchain.agent",
    typeVersion: 3.1,
    position: [1632, -208],
    id: "01100000-0000-4000-8000-000000000023",
    name: "Analizar identidad y fechas WF-011",
    retryOnFail: false,
    maxTries: 1,
    onError: "continueErrorOutput",
  };
  const normalize = codeNode(code, "Normalizar fechas documentales WF-011", `const context = $('Guardar extracción WF-011').item.json;
const raw = $json.output ?? $json.text ?? $json.response ?? '';
let parsed = {};
try {
  if (raw && typeof raw === 'object') parsed = raw;
  else {
    const text = String(raw ?? '').replace(/^\\s*\`\`\`(?:json)?/i, '').replace(/\`\`\`\\s*$/i, '').trim();
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  }
} catch { parsed = {}; }
const isoDate = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return '';
  const date = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : '';
};
const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0) || 0));
const allowedOrganizationTypes = new Set(['legal_entity', 'natural_person', 'consortium', 'temporary_union', 'nonprofit', 'other']);
const rawOrganizationType = String(parsed.detected_organization_type ?? '').trim().toLowerCase();
const detectedOrganizationType = allowedOrganizationTypes.has(rawOrganizationType) ? rawOrganizationType : 'unconfirmed';
const organizationTypeConfidence = Math.max(0, Math.min(1, Number(parsed.organization_type_confidence ?? 0) || 0));
let issueDate = isoDate(parsed.issue_date);
let expirationDate = isoDate(parsed.expiration_date);
if (issueDate && new Date(issueDate + 'T00:00:00Z').getTime() > Date.now() + 7 * 86400000) issueDate = '';
if (issueDate && expirationDate && expirationDate < issueDate) expirationDate = '';
if (!expirationDate && issueDate && Number(context.policy_validity_days) > 0) {
  const calculated = new Date(issueDate + 'T00:00:00Z');
  calculated.setUTCDate(calculated.getUTCDate() + Number(context.policy_validity_days));
  expirationDate = calculated.toISOString().slice(0, 10);
}
const classification = {
  detected_document_type: String(parsed.detected_document_type ?? '').slice(0, 120),
  detected_organization_type: organizationTypeConfidence >= 0.75 ? detectedOrganizationType : 'unconfirmed',
  organization_type_confidence: organizationTypeConfidence,
  issue_date: issueDate || null, expiration_date: expirationDate || null,
  issuing_entity: String(parsed.issuing_entity ?? '').slice(0, 240),
  document_number: String(parsed.document_number ?? '').slice(0, 160), confidence,
  evidence: String(parsed.evidence ?? '').slice(0, 500),
  warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).slice(0, 10) : [],
  source: 'gemini_guarded_by_wf020', reviewed_by_human: false
};
return [{ json: { ...context, detected_issue_date: confidence >= 0.75 ? issueDate : '',
  detected_expiration_date: confidence >= 0.75 ? expirationDate : '', confidence,
  classification, ai_response_valid: Boolean(Object.keys(parsed).length) } }];`, [1856, -208], "024");
  const update = postgresNode(code, "Guardar clasificación y fechas WF-011", `UPDATE saas.organization_documents
SET issue_date = COALESCE(issue_date, NULLIF($3, '')::DATE),
    expiration_date = COALESCE(expiration_date, NULLIF($4, '')::DATE),
    renewal_due_date = COALESCE(expiration_date, NULLIF($4, '')::DATE),
    alert_due_date = CASE
      WHEN COALESCE(expiration_date, NULLIF($4, '')::DATE) IS NULL THEN alert_due_date
      ELSE COALESCE(expiration_date, NULLIF($4, '')::DATE) - COALESCE(alert_days_before, 5)
    END,
    ai_classification = COALESCE(ai_classification, '{}'::JSONB) || $5::JSONB,
    verification_status = 'review_required',
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
      'wf011_ai_classified_at', NOW(), 'wf011_ai_confidence', $6::NUMERIC,
      'date_source', CASE WHEN NULLIF($3, '') IS NULL AND NULLIF($4, '') IS NULL THEN 'not_detected' ELSE 'ai_pending_human_review' END),
    updated_at = NOW()
WHERE id = $1::UUID AND organization_id = $2::UUID
RETURNING id AS organization_document_id, organization_id, document_type, document_name,
          issue_date, expiration_date, alert_due_date, extraction_status, verification_status, updated_at;`, "={{ [ String($json.organization_document_id), String($json.organization_id), String($json.detected_issue_date ?? ''), String($json.detected_expiration_date ?? ''), JSON.stringify($json.classification ?? {}), Number($json.confidence ?? 0) ] }}", [2080, -208], "025");
  const deferred = postgresNode(code, "Registrar IA documental diferida WF-011", `UPDATE saas.organization_documents
SET verification_status = 'review_required',
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
      'wf011_ai_deferred_at', NOW(), 'wf011_ai_reason', $3::TEXT), updated_at = NOW()
WHERE id = $1::UUID AND organization_id = $2::UUID
RETURNING id AS organization_document_id, organization_id, extraction_status, verification_status, updated_at;`, "={{ [ String($json.organization_document_id ?? ''), String($json.organization_id ?? ''), String($json.quota_reason ?? $json.error?.message ?? 'model_unavailable') ] }}", [1856, 16], "026");
  workflow.nodes.push(quota, decision, model, agent, normalize, update, deferred);
  setMain(workflow, "Guardar extracción WF-011", [[quota.name]]);
  setMain(workflow, quota.name, [[decision.name]]);
  setMain(workflow, decision.name, [[agent.name], [deferred.name]]);
  workflow.connections[model.name] = { ai_languageModel: [[edge(agent.name, "ai_languageModel")]] };
  workflow.connections[agent.name] = { main: [[edge(normalize.name)], [edge(deferred.name)]] };
  setMain(workflow, normalize.name, [[update.name]]);
  setMain(workflow, update.name, [["Finalizar WF-011"]]);
  setMain(workflow, deferred.name, [["Finalizar WF-011"]]);
  return workflow;
}

function buildWorkflow021() {
  const code = "WF-021";
  const schedule = {
    parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 7 * * *" }] } },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.3,
    position: [-880, -160],
    id: "02100000-0000-4000-8000-000000000001",
    name: "Cada día 07:00 Bogotá WF-021",
  };
  const trigger = executeTriggerNode(code, ["organization_id"], [-880, 32], "002");
  const manual = manualNode(code, [-880, 208], "003");
  const materialize = postgresNode(code, "Materializar alertas documentales WF-021", `WITH candidates AS (
  SELECT document.organization_id, document.id AS organization_document_id,
         CASE
           WHEN document.expiration_date < CURRENT_DATE THEN 'expired'
           WHEN document.expiration_date <= CURRENT_DATE + COALESCE(document.alert_days_before, 5) THEN 'expiring'
           WHEN document.verification_status = 'review_required' THEN 'review_required'
           ELSE 'missing_date'
         END AS alert_type,
         CASE
           WHEN document.expiration_date < CURRENT_DATE THEN 'critical'
           WHEN document.expiration_date <= CURRENT_DATE + 3 THEN 'critical'
           WHEN document.expiration_date IS NOT NULL THEN 'warning'
           ELSE 'info'
         END AS severity,
         CASE
           WHEN document.expiration_date < CURRENT_DATE THEN 'Documento vencido: ' || document.document_name
           WHEN document.expiration_date IS NOT NULL THEN 'Documento próximo a vencer: ' || document.document_name
           WHEN document.verification_status = 'review_required' THEN 'Documento pendiente de revisión: ' || document.document_name
           ELSE 'Fecha documental pendiente: ' || document.document_name
         END AS title,
         CASE
           WHEN document.expiration_date < CURRENT_DATE THEN 'Venció el ' || TO_CHAR(document.expiration_date, 'DD/MM/YYYY') || '. Sustituye el archivo antes de usarlo en una propuesta.'
           WHEN document.expiration_date IS NOT NULL THEN 'Vence el ' || TO_CHAR(document.expiration_date, 'DD/MM/YYYY') || '. Inicia su renovación con anticipación.'
           WHEN document.verification_status = 'review_required' THEN 'Confirma el tipo, las fechas y los datos extraídos antes de utilizar este documento.'
           ELSE 'No se encontró una fecha de expedición o vencimiento confiable. Completa la información manualmente.'
         END AS message,
         document.expiration_date AS due_date,
         'document:' || document.id::TEXT || ':' || CASE
           WHEN document.expiration_date < CURRENT_DATE THEN 'expired'
           WHEN document.expiration_date <= CURRENT_DATE + COALESCE(document.alert_days_before, 5) THEN 'expiring'
           WHEN document.verification_status = 'review_required' THEN 'review_required'
           ELSE 'missing_date'
         END AS dedupe_key,
         jsonb_build_object('document_name', document.document_name, 'document_type', document.document_type,
           'issue_date', document.issue_date, 'expiration_date', document.expiration_date,
           'verification_status', document.verification_status, 'evaluated_at', NOW()) AS source_snapshot
  FROM saas.organization_documents document
  WHERE document.document_status <> 'deleted'
    AND (NULLIF($1::TEXT, '') IS NULL OR document.organization_id = NULLIF($1::TEXT, '')::UUID)
    AND (
      document.expiration_date <= CURRENT_DATE + COALESCE(document.alert_days_before, 5)
      OR document.verification_status = 'review_required'
      OR (document.expiration_date IS NULL AND document.extraction_status NOT IN ('not_requested', 'processing'))
    )
), upserted AS (
  INSERT INTO saas.document_alerts
    (organization_id, organization_document_id, alert_type, severity, status, title, message,
     due_date, dedupe_key, source_snapshot, first_triggered_at, last_triggered_at, updated_at)
  SELECT organization_id, organization_document_id, alert_type, severity, 'open', title, message,
         due_date, dedupe_key, source_snapshot, NOW(), NOW(), NOW()
  FROM candidates
  ON CONFLICT (organization_id, dedupe_key) DO UPDATE SET
    severity = EXCLUDED.severity, status = CASE WHEN saas.document_alerts.status = 'dismissed' THEN 'dismissed' ELSE 'open' END,
    title = EXCLUDED.title, message = EXCLUDED.message, due_date = EXCLUDED.due_date,
    source_snapshot = EXCLUDED.source_snapshot, last_triggered_at = NOW(), resolved_at = NULL, updated_at = NOW()
  RETURNING id
), resolved AS (
  UPDATE saas.document_alerts alert
  SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
  WHERE alert.status IN ('open', 'read')
    AND (NULLIF($1::TEXT, '') IS NULL OR alert.organization_id = NULLIF($1::TEXT, '')::UUID)
    AND NOT EXISTS (
      SELECT 1 FROM candidates candidate
      WHERE candidate.organization_id = alert.organization_id
        AND candidate.organization_document_id = alert.organization_document_id
        AND candidate.dedupe_key = alert.dedupe_key
    )
  RETURNING id
), alert_sets AS (
  SELECT organization.id AS organization_id, organization.name AS organization_name,
         COALESCE(settings.daily_digest, TRUE) AS daily_digest,
         COUNT(alert.id)::INTEGER AS open_alert_count,
         COUNT(alert.id) FILTER (WHERE alert.severity = 'critical')::INTEGER AS critical_count,
         COUNT(alert.id) FILTER (WHERE alert.severity = 'warning')::INTEGER AS warning_count,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', alert.id, 'title', alert.title, 'message', alert.message, 'severity', alert.severity,
           'alert_type', alert.alert_type, 'due_date', alert.due_date,
           'document_id', alert.organization_document_id
         ) ORDER BY alert.severity, alert.due_date NULLS LAST) FILTER (WHERE alert.id IS NOT NULL), '[]'::JSONB) AS alerts
  FROM saas.organizations organization
  LEFT JOIN saas.app_organization_settings settings ON settings.organization_id = organization.id
  LEFT JOIN saas.document_alerts alert ON alert.organization_id = organization.id AND alert.status IN ('open', 'read')
  WHERE organization.status = 'active'
    AND (NULLIF($1::TEXT, '') IS NULL OR organization.id = NULLIF($1::TEXT, '')::UUID)
  GROUP BY organization.id, organization.name, settings.daily_digest
)
SELECT organization_id, organization_name, daily_digest, open_alert_count, critical_count, warning_count,
       alerts, CURRENT_DATE AS digest_date, (SELECT COUNT(*) FROM upserted)::INTEGER AS alerts_refreshed,
       (SELECT COUNT(*) FROM resolved)::INTEGER AS alerts_resolved
FROM alert_sets
WHERE open_alert_count > 0 AND daily_digest = TRUE;`, "={{ [ String($json.organization_id ?? '') ] }}", [-608, 32], "004");
  const prepare = codeNode(code, "Preparar resumen diario WF-021", `const alerts = Array.isArray($json.alerts) ? $json.alerts.slice(0, 40) : [];
const snapshot = { organization_name: $json.organization_name, digest_date: $json.digest_date,
  open_alert_count: Number($json.open_alert_count ?? 0), critical_count: Number($json.critical_count ?? 0),
  warning_count: Number($json.warning_count ?? 0), alerts };
const aiPrompt = 'Genera un resumen ejecutivo breve de estas alertas documentales. Prioriza vencidos y próximos a vencer. ' +
  'No inventes fechas, obligaciones ni documentos. Devuelve únicamente JSON con headline, summary_text y recommended_actions (arreglo de hasta 5 acciones). Datos: ' + JSON.stringify(snapshot);
return [{ json: { ...$json, alert_snapshot: snapshot, ai_prompt: aiPrompt, model_name: 'models/gemini-3.1-flash-lite',
  request_id: 'digest-' + $json.organization_id + '-' + $json.digest_date } }];`, [-368, 32], "005");
  const quota = quotaCall(code, [-128, 32], "006");
  const decision = ifTrueNode(code, "¿Cuota para resumen WF-021?", "={{ $json.quota_granted === true }}", [112, 32], "007");
  const model = {
    parameters: { modelName: "models/gemini-3.1-flash-lite", options: { maxOutputTokens: 900, temperature: 0.1 } },
    type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini", typeVersion: 1.1,
    position: [320, -176], id: "02100000-0000-4000-8000-000000000008",
    name: "Gemini alertas WF-021", credentials: CREDENTIALS.gemini,
  };
  const agent = {
    parameters: {
      promptType: "define", text: "={{ $json.ai_prompt }}",
      options: { systemMessage: "Eres un asistente de gestión documental. Resume riesgos sin emitir conceptos jurídicos, sin inventar información y usando únicamente los datos recibidos. Devuelve solo JSON válido.", maxIterations: 1, returnIntermediateSteps: false },
    },
    type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 3.1,
    position: [352, -48], id: "02100000-0000-4000-8000-000000000009",
    name: "Redactar alerta inteligente WF-021", retryOnFail: false, maxTries: 1, onError: "continueErrorOutput",
  };
  const normalize = codeNode(code, "Normalizar resumen IA WF-021", `const context = $('Preparar resumen diario WF-021').item.json;
const raw = $json.output ?? $json.text ?? '';
let parsed = {};
try {
  if (raw && typeof raw === 'object') parsed = raw;
  else { const text = String(raw).replace(/^\\s*\`\`\`(?:json)?/i, '').replace(/\`\`\`\\s*$/i, '').trim(); parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
} catch {}
const actions = Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions.map(String).filter(Boolean).slice(0, 5) : [];
const fallbackHeadline = Number(context.critical_count) > 0 ? 'Hay documentos que requieren atención inmediata' : 'Documentos próximos a gestión';
return [{ json: { ...context, digest_status: Object.keys(parsed).length ? 'ready' : 'fallback',
  headline: String(parsed.headline ?? fallbackHeadline).slice(0, 240),
  summary_text: String(parsed.summary_text ?? ('Tienes ' + context.open_alert_count + ' alertas documentales abiertas. Revisa primero las de mayor severidad.')).slice(0, 2000),
  recommended_actions: actions.length ? actions : ['Revisar los documentos vencidos o por vencer', 'Confirmar fechas extraídas automáticamente', 'Cargar las renovaciones disponibles'] } }];`, [592, -48], "010");
  const fallback = codeNode(code, "Crear resumen sin IA WF-021", `const critical = Number($json.critical_count ?? 0);
return [{ json: { ...$json, digest_status: 'fallback',
  headline: critical > 0 ? 'Hay documentos que requieren atención inmediata' : 'Documentos próximos a gestión',
  summary_text: 'Tienes ' + Number($json.open_alert_count ?? 0) + ' alertas documentales abiertas. El resumen se generó sin IA porque la cuota diaria estaba agotada.',
  recommended_actions: ['Revisar documentos vencidos', 'Confirmar fechas y vigencias', 'Cargar renovaciones disponibles'] } }];`, [352, 144], "011");
  const upsert = postgresNode(code, "Guardar resumen de alertas WF-021", `INSERT INTO saas.alert_digests
  (organization_id, digest_date, status, headline, summary_text, recommended_actions,
   source_snapshot, model_provider, model_name, generated_at, updated_at)
VALUES ($1::UUID, $2::DATE, $3, $4, $5, $6::JSONB, $7::JSONB, 'google', $8, NOW(), NOW())
ON CONFLICT (organization_id, digest_date) DO UPDATE SET
  status = EXCLUDED.status, headline = EXCLUDED.headline, summary_text = EXCLUDED.summary_text,
  recommended_actions = EXCLUDED.recommended_actions, source_snapshot = EXCLUDED.source_snapshot,
  model_provider = EXCLUDED.model_provider, model_name = EXCLUDED.model_name,
  generated_at = NOW(), updated_at = NOW()
RETURNING id, organization_id, digest_date, status, headline, summary_text,
          recommended_actions, generated_at;`, "={{ [ String($json.organization_id), String($json.digest_date), String($json.digest_status ?? 'fallback'), String($json.headline), String($json.summary_text), JSON.stringify($json.recommended_actions ?? []), JSON.stringify($json.alert_snapshot ?? {}), String($json.model_name ?? 'models/gemini-3.1-flash-lite') ] }}", [832, 32], "012");
  const finish = codeNode(code, "Finalizar alertas WF-021", `return $input.all().map((item) => ({ json: { ...item.json, workflow_code: 'WF-021', workflow_status: 'success', finished_at: new Date().toISOString() } }));`, [1072, 32], "013");
  const workflow = baseWorkflow(code, "Alertas documentales inteligentes", WORKFLOW_IDS[code], [schedule, trigger, manual, materialize, prepare, quota, decision, model, agent, normalize, fallback, upsert, finish], {});
  setMain(workflow, schedule.name, [[materialize.name]]);
  setMain(workflow, trigger.name, [[materialize.name]]);
  setMain(workflow, manual.name, [[materialize.name]]);
  setMain(workflow, materialize.name, [[prepare.name]]);
  setMain(workflow, prepare.name, [[quota.name]]);
  setMain(workflow, quota.name, [[decision.name]]);
  setMain(workflow, decision.name, [[agent.name], [fallback.name]]);
  workflow.connections[model.name] = { ai_languageModel: [[edge(agent.name, "ai_languageModel")]] };
  workflow.connections[agent.name] = { main: [[edge(normalize.name)], [edge(normalize.name)]] };
  setMain(workflow, normalize.name, [[upsert.name]]);
  setMain(workflow, fallback.name, [[upsert.name]]);
  setMain(workflow, upsert.name, [[finish.name]]);
  return workflow;
}

function buildWorkflow022() {
  const code = "WF-022";
  const fields = ["organization_id", "process_id", "proposal_package_id", "requested_by_user_id"];
  const webhook = {
    parameters: { httpMethod: "POST", path: "cernoia/wf-022", authentication: "headerAuth", responseMode: "onReceived", options: {} },
    type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [-912, -144],
    id: "02200000-0000-4000-8000-000000000001", name: "Webhook seguro CernoIA WF-022",
    webhookId: "02200000-0000-4000-8000-000000000101", credentials: CREDENTIALS.header,
  };
  const trigger = executeTriggerNode(code, fields, [-912, 48], "002");
  const manual = manualNode(code, [-912, 224], "003");
  const validate = codeNode(code, "Validar solicitud WF-022", `const raw = $input.first()?.json ?? {};
const input = raw.body && typeof raw.body === 'object' ? raw.body : raw;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const field of ['organization_id', 'process_id', 'proposal_package_id']) {
  if (!uuid.test(String(input[field] ?? ''))) throw new Error(field + ' no es un UUID válido para WF-022');
}
return [{ json: { organization_id: String(input.organization_id), process_id: String(input.process_id),
  proposal_package_id: String(input.proposal_package_id),
  requested_by_user_id: uuid.test(String(input.requested_by_user_id ?? '')) ? String(input.requested_by_user_id) : '',
  n8n_execution_id: String($execution.id ?? ''), model_name: 'models/gemini-3.1-flash-lite' } }];`, [-656, 32], "004");
  const load = postgresNode(code, "Cargar contexto de propuesta WF-022", `WITH target_package AS (
  UPDATE saas.proposal_packages package
  SET status = 'drafting', started_at = COALESCE(started_at, NOW()), workflow_execution_id = $4::TEXT,
      error_message = NULL, updated_at = NOW()
  WHERE package.id = $1::UUID AND package.organization_id = $2::UUID AND package.process_id = $3::UUID
    AND package.status IN ('queued', 'failed', 'drafting')
  RETURNING package.*
), requirement_data AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', requirement.requirement_name, 'description', requirement.requirement_description,
    'category', requirement.requirement_category, 'mandatory', requirement.mandatory,
    'requires_signature', requirement.requires_signature,
    'requires_entity_template', requirement.requires_entity_template,
    'status', requirement.status, 'evidence', requirement.evidence_text,
    'organization_document', matched_document.document_name,
    'organization_document_expiration', matched_document.expiration_date
  ) ORDER BY requirement.mandatory DESC, requirement.created_at ASC) FILTER (WHERE requirement.id IS NOT NULL), '[]'::JSONB) AS requirements
  FROM target_package package
  LEFT JOIN saas.opportunity_requirements requirement
    ON requirement.organization_id = package.organization_id AND requirement.process_id = package.process_id
  LEFT JOIN LATERAL (
    SELECT document.document_name, document.expiration_date
    FROM saas.opportunity_requirement_documents relation
    JOIN saas.organization_documents document ON document.id = relation.organization_document_id
    WHERE relation.opportunity_requirement_id = requirement.id AND document.document_status <> 'deleted'
    ORDER BY relation.match_score DESC NULLS LAST LIMIT 1
  ) matched_document ON TRUE
)
SELECT package.id AS proposal_package_id, package.organization_id, package.process_id,
       package.title, package.include_electronic_signature, package.review_required,
       package.requested_instructions, package.generation_mode,
       organization.name AS organization_name, COALESCE(organization.legal_name, organization.name) AS legal_name,
       organization.tax_id, organization.city, organization.department, organization.organization_type,
       process.reference, process.secop_process_id, process.process_name, process.description AS process_description,
       process.entity_name, process.procurement_method, process.contract_type, process.base_price,
       process.response_deadline, process.process_url, requirement_data.requirements
FROM target_package package
JOIN saas.organizations organization ON organization.id = package.organization_id
JOIN secop.processes process ON process.id = package.process_id
CROSS JOIN requirement_data;`, "={{ [ String($json.proposal_package_id), String($json.organization_id), String($json.process_id), String($json.n8n_execution_id) ] }}", [-416, 32], "005");
  const prepare = codeNode(code, "Preparar borrador de propuesta WF-022", `const requirements = Array.isArray($json.requirements) ? $json.requirements.slice(0, 180) : [];
const snapshot = {
  company: { legal_name: $json.legal_name, tax_id: $json.tax_id, organization_type: $json.organization_type,
    city: $json.city, department: $json.department },
  opportunity: { reference: $json.reference || $json.secop_process_id, process_name: $json.process_name,
    description: $json.process_description, entity_name: $json.entity_name, procurement_method: $json.procurement_method,
    contract_type: $json.contract_type, base_price: $json.base_price, response_deadline: $json.response_deadline },
  requirements, user_instructions: $json.requested_instructions || ''
};
const aiPrompt = 'Prepara contenido para un paquete preliminar de propuesta de contratación pública colombiana. ' +
  'Usa exclusivamente los datos recibidos. No declares cumplimiento sin evidencia, no inventes experiencia, cifras, documentos, ' +
  'certificaciones ni facultades de firma. No sustituyas formatos oficiales. Devuelve solo JSON con cover_letter y declarations; ' +
  'declarations es un arreglo de máximo 8 objetos con title y text. Todo debe ser un borrador sujeto a revisión humana. Datos: ' + JSON.stringify(snapshot);
return [{ json: { ...$json, proposal_snapshot: snapshot, ai_prompt: aiPrompt, model_name: 'models/gemini-3.1-flash-lite',
  request_id: 'proposal-' + $json.proposal_package_id } }];`, [-176, 32], "006");
  const quota = quotaCall(code, [64, 32], "007");
  const decision = ifTrueNode(code, "¿Cuota para propuesta WF-022?", "={{ $json.quota_granted === true }}", [304, 32], "008");
  const model = {
    parameters: { modelName: "models/gemini-3.1-flash-lite", options: { maxOutputTokens: 2600, temperature: 0.1 } },
    type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini", typeVersion: 1.1,
    position: [512, -176], id: "02200000-0000-4000-8000-000000000009",
    name: "Gemini propuesta WF-022", credentials: CREDENTIALS.gemini,
  };
  const agent = {
    parameters: {
      promptType: "define", text: "={{ $json.ai_prompt }}",
      options: { systemMessage: "Eres un asistente de preparación documental para contratación pública colombiana. No inventes hechos ni certifiques cumplimiento. Redacta borradores claros, conservadores y trazables. Devuelve solamente JSON válido.", maxIterations: 1, returnIntermediateSteps: false },
    },
    type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 3.1,
    position: [544, -48], id: "02200000-0000-4000-8000-000000000010",
    name: "Redactar propuesta WF-022", retryOnFail: false, maxTries: 1, onError: "continueErrorOutput",
  };
  const normalize = codeNode(code, "Normalizar contenido propuesta WF-022", `const context = $('Preparar borrador de propuesta WF-022').first().json;
const raw = $json.output ?? $json.text ?? '';
let parsed = {};
try {
  if (raw && typeof raw === 'object') parsed = raw;
  else { const text = String(raw).replace(/^\\s*\`\`\`(?:json)?/i, '').replace(/\`\`\`\\s*$/i, '').trim(); parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
} catch {}
const declarations = Array.isArray(parsed.declarations) ? parsed.declarations.slice(0, 8).map((item) => ({
  title: String(item?.title ?? 'Declaración').slice(0, 180), text: String(item?.text ?? '').slice(0, 5000)
})).filter((item) => item.text) : [];
return [{ json: { ...context, content: { cover_letter: String(parsed.cover_letter ?? '').slice(0, 12000), declarations,
  generation_source: Object.keys(parsed).length ? 'gemini_guarded_by_wf020' : 'deterministic_fallback',
  human_review_required: true } } }];`, [784, -48], "011");
  const fallback = codeNode(code, "Usar paquete determinístico WF-022", `const context = $('Preparar borrador de propuesta WF-022').first().json;
return [{ json: { ...context, content: { cover_letter: '', declarations: [], generation_source: 'deterministic_fallback_quota',
  human_review_required: true, quota_reason: $json.quota_reason ?? 'daily_limit' } } }];`, [544, 144], "012");
  const render = {
    parameters: {
      method: "POST",
      url: "={{ 'http://127.0.0.1:4001/api/integrations/proposals/' + $json.proposal_package_id + '/render' }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ content: $json.content ?? {}, workflow_execution_id: $execution.id }) }}",
      options: { timeout: 120000 },
    },
    type: "n8n-nodes-base.httpRequest", typeVersion: 4.4,
    position: [1024, 32], id: "02200000-0000-4000-8000-000000000013",
    name: "Renderizar PDF privado WF-022", credentials: CREDENTIALS.header,
    onError: "continueErrorOutput",
  };
  const failed = postgresNode(code, "Registrar fallo de render WF-022", `UPDATE saas.proposal_packages
SET status = 'failed', error_message = LEFT($2::TEXT, 3000), completed_at = NOW(), updated_at = NOW()
WHERE id = $1::UUID AND status <> 'ready'
RETURNING id AS proposal_package_id, organization_id, process_id, status, error_message;`, "={{ [ String($('Validar solicitud WF-022').first().json.proposal_package_id), String($json.error?.message ?? $json.message ?? 'La API no pudo renderizar el paquete de propuesta.') ] }}", [1264, 144], "014");
  const finish = codeNode(code, "Finalizar propuesta WF-022", `return [{ json: { ...$json, workflow_code: 'WF-022', workflow_status: $json.status === 'failed' ? 'failed' : 'success', finished_at: new Date().toISOString() } }];`, [1504, 32], "015");
  const workflow = baseWorkflow(code, "Generación de paquete de propuesta", WORKFLOW_IDS[code], [webhook, trigger, manual, validate, load, prepare, quota, decision, model, agent, normalize, fallback, render, failed, finish], {});
  setMain(workflow, webhook.name, [[validate.name]]);
  setMain(workflow, trigger.name, [[validate.name]]);
  setMain(workflow, manual.name, [[validate.name]]);
  setMain(workflow, validate.name, [[load.name]]);
  setMain(workflow, load.name, [[prepare.name]]);
  setMain(workflow, prepare.name, [[quota.name]]);
  setMain(workflow, quota.name, [[decision.name]]);
  setMain(workflow, decision.name, [[agent.name], [fallback.name]]);
  workflow.connections[model.name] = { ai_languageModel: [[edge(agent.name, "ai_languageModel")]] };
  workflow.connections[agent.name] = { main: [[edge(normalize.name)], [edge(normalize.name)]] };
  setMain(workflow, normalize.name, [[render.name]]);
  setMain(workflow, fallback.name, [[render.name]]);
  workflow.connections[render.name] = { main: [[edge(finish.name)], [edge(failed.name)]] };
  setMain(workflow, failed.name, [[finish.name]]);
  return workflow;
}

async function readWorkflow(code) {
  return JSON.parse(await readFile(join(workflowDirectory, FILES[code]), "utf8"));
}

async function saveWorkflow(code, workflow) {
  await writeFile(join(workflowDirectory, FILES[code]), `${JSON.stringify(workflow, null, 2)}\n`);
}

const workflow008 = patchWorkflow008(await readWorkflow("WF-008"));
const workflow011 = patchWorkflow011(await readWorkflow("WF-011"));
const workflow015 = patchWorkflow015(await readWorkflow("WF-015"));
const workflow020 = buildWorkflow020();
const workflow021 = buildWorkflow021();
const workflow022 = buildWorkflow022();

await Promise.all([
  saveWorkflow("WF-008", workflow008),
  saveWorkflow("WF-011", workflow011),
  saveWorkflow("WF-015", workflow015),
  saveWorkflow("WF-020", workflow020),
  saveWorkflow("WF-021", workflow021),
  saveWorkflow("WF-022", workflow022),
]);

const manifestPath = join(projectRoot, "n8n/workflow-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.generated_at = new Date().toISOString();
manifest.activation_order = [
  "WF-007",
  "WF-020",
  "WF-001",
  "WF-002",
  "WF-003",
  "WF-005",
  "WF-008",
  "WF-011",
  "WF-012",
  "WF-013",
  "WF-014",
  "WF-015",
  "WF-016",
  "WF-017",
  "WF-018",
  "WF-021",
  "WF-022",
  "WF-019",
];
for (const code of ["WF-020", "WF-021", "WF-022"]) {
  manifest.workflows[code] = { id: WORKFLOW_IDS[code], file: FILES[code] };
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("Fase 2 generada: WF-020, WF-021, WF-022 e integración de cuota en WF-008/WF-011/WF-015.");
