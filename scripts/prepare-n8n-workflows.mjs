#!/usr/bin/env node

import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(process.argv[2] ?? "");
const outputDirectory = join(projectRoot, "n8n/workflows");
const errorWorkflowId = "AVQTQyh3FwAMYgwW";
const postgresCredential = { id: "YdZl2oI4ndBEPoWO", name: "Postgres account" };
const webhookCredential = { id: "REPLACE_CERNOIA_HEADER_AUTH", name: "CernoIA Webhook Secret" };

if (!process.argv[2]) {
  throw new Error("Uso: node scripts/prepare-n8n-workflows.mjs <carpeta-con-json-originales>");
}

const filenames = {
  "WF-001": "WF-001-sincronizacion-incremental.json",
  "WF-002": "WF-002-historial-cambios.json",
  "WF-003": "WF-003-metadatos-documentos.json",
  "WF-005": "WF-005-motor-coincidencias.json",
  "WF-007": "WF-007-gestion-errores.json",
  "WF-008": "WF-008-preanalisis-ia.json",
  "WF-011": "WF-011-validacion-documento-empresarial.json",
  "WF-012": "WF-012-vigencias-documentales.json",
  "WF-013": "WF-013-matriz-documental.json",
  "WF-014": "WF-014-extraccion-documental.json",
  "WF-015": "WF-015-extraccion-ia-requisitos.json",
  "WF-016": "WF-016-consolidacion-requisitos.json",
  "WF-017": "WF-017-evaluacion-cumplimiento.json",
  "WF-018": "WF-018-plan-accion.json",
  "WF-019": "WF-019-orquestador-pipeline.json",
};

const workflowIds = {
  "WF-001": "v7JZgBNs6tZPRTxH",
  "WF-002": "vFuCgGX0p8L2R6NY",
  "WF-003": "TrChDApz7hYwoUSb",
  "WF-005": "Xy68vAlmdEjG5IMY",
  "WF-007": "AVQTQyh3FwAMYgwW",
  "WF-008": "Bi695dJWRLh3BTWJ",
  "WF-011": "CernoIAWF011Prod",
  "WF-012": "VTLSAkO4n3CGMNir",
  "WF-013": "YAXZRUlnl0QAdvnl",
  "WF-014": "JIYf2qDPciFfByHZ",
  "WF-015": "NiGXwf53YNU9VpNd",
  "WF-016": "IKSjTlAqrRi8Yff6",
  "WF-017": "vDj9rg3InymZJqk9",
  "WF-018": "x5TmE35QxZBAJ8ay",
  "WF-019": "vx0FsvD4Da3jA5ER",
};

const orchestratedStages = ["WF-001", "WF-002", "WF-003", "WF-005", "WF-008", "WF-013", "WF-014", "WF-015", "WF-016", "WF-012", "WF-017", "WF-018"];

const workflowInputValues = [
  { name: "organization_id" },
  { name: "requested_by_user_id" },
  { name: "process_id" },
  { name: "processing_mode" },
  { name: "orchestration_execution_id" },
];

const workflowInputSchema = workflowInputValues.map(({ name }) => ({
  id: name,
  displayName: name,
  required: false,
  defaultMatch: false,
  display: true,
  canBeUsedToMatch: true,
  type: "string",
  removed: false,
}));

function connection(node, index = 0) {
  return { node, type: "main", index };
}

function codeFromName(name) {
  return name.match(/WF-\d{3}/)?.[0] ?? null;
}

function setMain(workflow, source, outputs) {
  workflow.connections[source] = { main: outputs.map((nodes) => nodes.map((name) => connection(name))) };
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`No se encontró el nodo ${name} en ${workflow.name}.`);
  return node;
}

function normalizeWorkflow(workflow, code) {
  workflow.name = `[CernoIA PROD] ${workflow.name.replace(/^\[CernoIA PROD\]\s*/, "")}`;
  workflow.active = false;
  workflow.id = workflowIds[code] ?? workflow.id;
  workflow.pinData = {};
  workflow.settings = {
    ...(workflow.settings ?? {}),
    executionOrder: "v1",
    timezone: "America/Bogota",
    callerPolicy: "workflowsFromSameOwner",
  };
  if (!["WF-000", "WF-007"].includes(code)) workflow.settings.errorWorkflow = errorWorkflowId;
  delete workflow.meta?.instanceId;

  for (const node of workflow.nodes) {
    const replacement = node.parameters?.options?.queryReplacement;
    if (typeof replacement === "string" && replacement.startsWith("=={{")) {
      node.parameters.options.queryReplacement = replacement.slice(1);
    }
    for (const assignment of node.parameters?.assignments?.assignments ?? []) {
      assignment.name = String(assignment.name).replace(/^=+/, "");
    }
  }

  const repairExpressions = (value) => {
    if (typeof value === "string") return value.startsWith("=={{") ? value.slice(1) : value;
    if (Array.isArray(value)) return value.map(repairExpressions);
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) value[key] = repairExpressions(item);
    }
    return value;
  };
  repairExpressions(workflow);
}

function pruneUnreachable(workflow) {
  const triggerTypes = new Set([
    "n8n-nodes-base.manualTrigger",
    "n8n-nodes-base.scheduleTrigger",
    "n8n-nodes-base.executeWorkflowTrigger",
    "n8n-nodes-base.webhook",
    "n8n-nodes-base.errorTrigger",
  ]);
  const names = new Set(workflow.nodes.map((node) => node.name));
  const reachable = new Set(workflow.nodes.filter((node) => triggerTypes.has(node.type)).map((node) => node.name));
  const outgoing = new Map();

  for (const [source, groups] of Object.entries(workflow.connections ?? {})) {
    const targets = [];
    for (const outputs of Object.values(groups)) {
      for (const output of outputs ?? []) {
        for (const edge of output ?? []) targets.push({ target: edge.node, type: edge.type });
      }
    }
    outgoing.set(source, targets);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const source of [...reachable]) {
      for (const edge of outgoing.get(source) ?? []) {
        if (names.has(edge.target) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          changed = true;
        }
      }
    }
    for (const [source, edges] of outgoing) {
      if (reachable.has(source) || !names.has(source)) continue;
      if (edges.some((edge) => edge.type.startsWith("ai_") && reachable.has(edge.target))) {
        reachable.add(source);
        changed = true;
      }
    }
  }

  workflow.nodes = workflow.nodes.filter((node) => reachable.has(node.name) && node.type !== "n8n-nodes-base.stickyNote");
  const kept = new Set(workflow.nodes.map((node) => node.name));
  workflow.connections = Object.fromEntries(
    Object.entries(workflow.connections ?? {})
      .filter(([source]) => kept.has(source))
      .map(([source, groups]) => [
        source,
        Object.fromEntries(Object.entries(groups).map(([type, outputs]) => [
          type,
          (outputs ?? []).map((output) => (output ?? []).filter((edge) => kept.has(edge.node))),
        ])),
      ]),
  );
}

function ensureSubworkflowTrigger(workflow, targetName, position = [-600, 480]) {
  let trigger = workflow.nodes.find((node) => node.type === "n8n-nodes-base.executeWorkflowTrigger");
  if (!trigger) {
    trigger = {
      parameters: {},
      type: "n8n-nodes-base.executeWorkflowTrigger",
      typeVersion: 1.2,
      position,
      id: `c0000000-0000-4000-8000-${codeFromName(workflow.name)?.slice(-3) ?? "999"}000000001`,
      name: "Entrada desde WF-019",
    };
    workflow.nodes.push(trigger);
  }
  trigger.parameters = { workflowInputs: { values: workflowInputValues } };
  setMain(workflow, trigger.name, [[targetName]]);
}

function removeIndependentSchedules(workflow) {
  const scheduleNames = new Set(
    workflow.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger").map((node) => node.name),
  );
  workflow.nodes = workflow.nodes.filter((node) => !scheduleNames.has(node.name));
  for (const name of scheduleNames) delete workflow.connections[name];
}

function patchSetConfiguration(workflow, name, defaults) {
  const node = nodeByName(workflow, name);
  node.parameters.includeOtherFields = true;
  for (const assignment of node.parameters.assignments.assignments) {
    const fallback = defaults[assignment.name];
    if (fallback === undefined) continue;
    const serialized = typeof fallback === "string" ? `'${fallback}'` : String(fallback);
    assignment.value = `={{ $json.${assignment.name} ?? ${serialized} }}`;
  }
}

function patchCodeConfiguration(workflow, name, defaults) {
  const node = nodeByName(workflow, name);
  const fields = Object.entries(defaults)
    .map(([key, value]) => {
      const serialized = typeof value === "string" ? `'${value}'` : String(value);
      return `  ${key}: input.${key} ?? ${serialized},`;
    })
    .join("\n");
  node.parameters.jsCode = `const raw = $input.first()?.json ?? {};\nconst input = raw.body && typeof raw.body === 'object' ? raw.body : raw;\n\nreturn [{\n  json: {\n    ...input,\n${fields}\n    n8n_execution_id: String($execution.id ?? ''),\n    trigger_type: String($execution.mode ?? 'manual'),\n    configured_at: new Date().toISOString(),\n  },\n}];`;
}

function executeWorkflowNode(code, position) {
  const name = `Ejecutar ${code}`;
  return {
    parameters: {
      workflowId: {
        __rl: true,
        value: workflowIds[code],
        mode: "list",
        cachedResultUrl: `/workflow/${workflowIds[code]}`,
        cachedResultName: `[CernoIA PROD] ${code}`,
      },
      workflowInputs: {
        mappingMode: "defineBelow",
        value: {
          organization_id: "={{ $('Configurar orquestación WF-019').first().json.organization_id ?? '' }}",
          requested_by_user_id: "={{ $('Configurar orquestación WF-019').first().json.requested_by_user_id ?? '' }}",
          process_id: "={{ $('Configurar orquestación WF-019').first().json.process_id ?? '' }}",
          processing_mode: "={{ $('Configurar orquestación WF-019').first().json.processing_mode ?? 'all' }}",
          orchestration_execution_id: "={{ $('Configurar orquestación WF-019').first().json.n8n_execution_id ?? '' }}",
        },
        matchingColumns: [],
        schema: workflowInputSchema,
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: { waitForSubWorkflow: true },
    },
    type: "n8n-nodes-base.executeWorkflow",
    typeVersion: 1.3,
    position,
    id: `d0000000-0000-4000-8000-${code.slice(-3)}000000001`,
    name,
    alwaysOutputData: true,
  };
}

function patchWorkflow001(workflow) {
  ensureSubworkflowTrigger(workflow, "Adquirir bloqueo WF-001", [-640, 464]);
  const assignments = nodeByName(workflow, "Normalizar proceso SECOP").parameters.assignments.assignments;
  if (!assignments.some((field) => field.name === "response_deadline")) {
    assignments.push({
      id: "30a4c7f8-f4ca-49cf-b6af-89a0a42fe5c8",
      name: "response_deadline",
      value: "={{ $json.fecha_de_recepcion_de || null }}",
      type: "string",
    });
  }
}

function patchWorkflow008(workflow) {
  const manual = nodeByName(workflow, "WF-008 - Preanálisis IA de oportunidades SECOP II");
  const config = {
    parameters: {
      jsCode: `const raw = $input.first()?.json ?? {};\nconst input = raw.body && typeof raw.body === 'object' ? raw.body : raw;\nreturn [{ json: { ...input, organization_id: input.organization_id ?? '', process_id: input.process_id ?? '', processing_mode: input.processing_mode ?? 'all', max_analyses: Math.min(100, Math.max(1, Number(input.max_analyses ?? 100))), n8n_execution_id: String($execution.id ?? ''), trigger_type: String($execution.mode ?? 'manual') } }];`,
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [-32, -80],
    id: "80000000-0000-4000-8000-000000000008",
    name: "Configurar procesamiento WF-008",
  };
  workflow.nodes.push(config);
  setMain(workflow, manual.name, [[config.name]]);
  ensureSubworkflowTrigger(workflow, config.name, [-240, -240]);
  setMain(workflow, config.name, [["Encolar coincidencias WF-008"]]);

  const enqueue = nodeByName(workflow, "Encolar coincidencias WF-008");
  enqueue.parameters.query = enqueue.parameters.query.replace(
    "WHERE match.match_status =\n        'new'",
    "WHERE match.match_status =\n        'new'\n\n      AND (NULLIF($1::TEXT, '') IS NULL OR match.organization_id = NULLIF($1::TEXT, '')::UUID)\n      AND (NULLIF($2::TEXT, '') IS NULL OR match.process_id = NULLIF($2::TEXT, '')::UUID)",
  ).replace("LIMIT 100", "LIMIT GREATEST(1, LEAST($3::INTEGER, 100))");
  enqueue.parameters.options.queryReplacement = "={{ [ $('Configurar procesamiento WF-008').first().json.organization_id ?? '', $('Configurar procesamiento WF-008').first().json.process_id ?? '', Number($('Configurar procesamiento WF-008').first().json.max_analyses ?? 100) ] }}";

  const claim = nodeByName(workflow, "Tomar lote para AI Agent WF-008");
  claim.parameters.query = claim.parameters.query.replace(
    "AND capability.is_active =\n        TRUE",
    "AND capability.is_active =\n        TRUE\n\n      AND (NULLIF($1::TEXT, '') IS NULL OR analysis.organization_id = NULLIF($1::TEXT, '')::UUID)\n      AND (NULLIF($2::TEXT, '') IS NULL OR analysis.process_id = NULLIF($2::TEXT, '')::UUID)",
  );
  claim.parameters.options.queryReplacement = "={{ [ $('Configurar procesamiento WF-008').first().json.organization_id ?? '', $('Configurar procesamiento WF-008').first().json.process_id ?? '' ] }}";

  const success = nodeByName(workflow, "Guardar análisis exitoso WF-008");
  success.parameters.query = `UPDATE saas.opportunity_ai_analyses\nSET analysis_status = 'success', model_provider = 'google', model_name = 'gemini',\n    compatibility_score = $2::NUMERIC, confidence_score = $3::NUMERIC, decision = $4::TEXT,\n    executive_summary = $5::TEXT, analysis_result = $6::JSONB, raw_model_output = $7::JSONB,\n    error_message = NULL, finished_at = NOW(), review_status = 'pending', updated_at = NOW()\nWHERE id = $1::UUID AND analysis_status = 'running'\nRETURNING id AS analysis_id, organization_id, process_match_id, process_id, analysis_status,\n          compatibility_score, confidence_score, decision, executive_summary, finished_at;`;
  success.parameters.options.queryReplacement = "={{ [ String($json.analysis_id ?? ''), Number($json.compatibility_score ?? 0), Number($json.confidence_score ?? 0), String($json.decision ?? 'informacion_insuficiente'), String($json.executive_summary ?? ''), JSON.stringify($json.ai_result ?? {}), JSON.stringify($json.raw_model_output ?? {}) ] }}";

  const failure = nodeByName(workflow, "Registrar fallo IA WF-008");
  failure.parameters.query = `UPDATE saas.opportunity_ai_analyses\nSET analysis_status = 'failed', error_message = $2::TEXT, raw_model_output = $3::JSONB,\n    finished_at = NOW(), updated_at = NOW()\nWHERE id = $1::UUID AND analysis_status = 'running'\nRETURNING id AS analysis_id, organization_id, process_match_id, process_id, analysis_status, error_message, finished_at;`;
  failure.parameters.options.queryReplacement = "={{ [ String($json.analysis_id ?? ''), String($json.ai_error_message ?? 'Error desconocido del AI Agent'), JSON.stringify($json.raw_model_output ?? {}) ] }}";

  const pause = {
    parameters: {},
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position: [1440, -256],
    id: "80000000-0000-4000-8000-000000000009",
    name: "Pausa entre análisis WF-008",
    webhookId: "80000000-0000-4000-8000-000000000010",
  };
  const finish = {
    parameters: {
      jsCode: "const config = $('Configurar procesamiento WF-008').first().json; return [{ json: { ...config, workflow_code: 'WF-008', workflow_status: 'success', completion_reason: 'queue_drained', finished_at: new Date().toISOString() } }];",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [672, 352],
    id: "80000000-0000-4000-8000-000000000011",
    name: "Finalizar WF-008",
  };
  workflow.nodes.push(pause, finish);
  setMain(workflow, success.name, [[pause.name]]);
  setMain(workflow, failure.name, [[pause.name]]);
  setMain(workflow, pause.name, [[claim.name]]);
  const ready = workflow.connections["¿Hay oportunidades listas para IA?"]?.main ?? [[]];
  ready[1] = [connection(finish.name)];
  workflow.connections["¿Hay oportunidades listas para IA?"] = { main: ready };
}

function patchWorkflow013(workflow) {
  patchSetConfiguration(workflow, "Configurar procesamiento WF-013", {
    max_documents_per_opportunity: 30,
    max_opportunities_per_organization: 5,
    processing_scope: "requested_organization_or_all",
  });
  ensureSubworkflowTrigger(workflow, "Configurar procesamiento WF-013", [160, 336]);

  const select = nodeByName(workflow, "Seleccionar oportunidades objetivo WF-013");
  select.parameters.query = select.parameters.query.replace(
    "AND analysis.analysis_status =\n        'success'",
    "AND analysis.analysis_status =\n        'success'\n\n      AND (NULLIF($3::TEXT, '') IS NULL OR analysis.organization_id = NULLIF($3::TEXT, '')::UUID)\n      AND (NULLIF($4::TEXT, '') IS NULL OR analysis.process_id = NULLIF($4::TEXT, '')::UUID)",
  );
  select.parameters.options.queryReplacement = "={{ [ Number($json.max_opportunities_per_organization ?? 5), Number($json.max_documents_per_opportunity ?? 30), String($json.organization_id ?? ''), String($json.process_id ?? '') ] }}";

  const finish = {
    parameters: {
      jsCode: "const config = $('Configurar procesamiento WF-013').first().json; return [{ json: { ...config, workflow_code: 'WF-013', workflow_status: 'success', completion_reason: 'no_eligible_opportunities', finished_at: new Date().toISOString() } }];",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [848, 176],
    id: "13000000-0000-4000-8000-000000000013",
    name: "Finalizar sin oportunidades WF-013",
  };
  workflow.nodes.push(finish);
  const decision = workflow.connections["¿Hay oportunidades objetivo WF-013?"]?.main ?? [[]];
  decision[1] = [connection(finish.name)];
  workflow.connections["¿Hay oportunidades objetivo WF-013?"] = { main: decision };
}

function patchWorkflow014(workflow) {
  patchSetConfiguration(workflow, "Configurar procesamiento WF-014", { processing_mode: "all", max_documents: 5 });
  const switchConnections = workflow.connections["Clasificar formato de extracción WF-014"]?.main;
  if (switchConnections) {
    switchConnections[1] = [connection("Registrar formato pendiente WF-014")];
    switchConnections[2] = [connection("Registrar formato pendiente WF-014")];
  }
  const loopConnections = workflow.connections["Procesar extracciones una a una WF-014"]?.main;
  if (loopConnections) loopConnections[0] = [connection("Liberar bloqueo WF-14")];
  for (const node of workflow.nodes) {
    if (["n8n-nodes-base.executeCommand", "n8n-nodes-base.readWriteFile"].includes(node.type)) node.disabled = true;
  }
}

function patchWorkflow018(workflow) {
  const finish = nodeByName(workflow, "Finalizar ejecución WF-018");
  finish.parameters.options.queryReplacement = "={{ [ String($execution.id ?? '') ] }}";
}

function patchWorkflow019(workflow) {
  const config = nodeByName(workflow, "Configurar orquestación WF-019");
  config.parameters.jsCode = `const raw = $input.first()?.json ?? {};\nconst input = raw.body && typeof raw.body === 'object' ? raw.body : raw;\nconst uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\nconst organizationId = uuid.test(String(input.organization_id ?? '')) ? String(input.organization_id) : '';\nconst userId = uuid.test(String(input.requested_by_user_id ?? '')) ? String(input.requested_by_user_id) : '';\nconst processId = uuid.test(String(input.process_id ?? '')) ? String(input.process_id) : '';\nreturn [{ json: { workflow_code: 'WF-019', source_code: 'SECOP_PIPELINE_ORCHESTRATION', orchestration_version: 2, orchestration_method: 'sequential_v2', lock_minutes: 60, stale_lock_minutes: 90, organization_id: organizationId, requested_by_user_id: userId, process_id: processId, processing_mode: String(input.processing_mode ?? 'all'), frontend_triggered: Boolean(organizationId), n8n_execution_id: String($execution.id ?? ''), trigger_type: String($execution.mode ?? 'manual'), configured_at: new Date().toISOString() } }];`;

  const webhook = {
    parameters: {
      httpMethod: "POST",
      path: "cernoia/wf-019",
      authentication: "headerAuth",
      responseMode: "onReceived",
      options: {},
    },
    type: "n8n-nodes-base.webhook",
    typeVersion: 2.1,
    position: [-240, -176],
    id: "19000000-0000-4000-8000-000000000019",
    name: "Webhook seguro CernoIA WF-019",
    webhookId: "19000000-0000-4000-8000-000000000020",
    credentials: { httpHeaderAuth: webhookCredential },
  };
  workflow.nodes.push(webhook);
  setMain(workflow, webhook.name, [[config.name]]);

  const start = nodeByName(workflow, "Registrar inicio WF-019");
  start.parameters.query = `INSERT INTO ops.workflow_runs\n  (workflow_code, source_code, n8n_execution_id, trigger_type, status, started_at, error_details, metadata, created_at, updated_at)\nVALUES\n  ('WF-019', 'SECOP_PIPELINE_ORCHESTRATION', $1::TEXT, $2::TEXT, 'running', NOW(), '{}'::JSONB,\n   jsonb_strip_nulls(jsonb_build_object('workflow_code', 'WF-019', 'organization_id', NULLIF($3::TEXT, ''),\n     'requested_by_user_id', NULLIF($4::TEXT, ''), 'process_id', NULLIF($5::TEXT, ''),\n     'processing_mode', $6::TEXT, 'orchestration_version', 2, 'started_at', NOW())), NOW(), NOW())\nON CONFLICT (n8n_execution_id) DO UPDATE SET\n  status = 'running', started_at = NOW(), finished_at = NULL, completion_reason = NULL,\n  error_node = NULL, error_message = NULL, error_details = '{}'::JSONB,\n  metadata = COALESCE(ops.workflow_runs.metadata, '{}'::JSONB) || EXCLUDED.metadata, updated_at = NOW()\nRETURNING id AS workflow_run_id, workflow_code, n8n_execution_id, status AS workflow_run_status, started_at;`;
  start.parameters.options.queryReplacement = "={{ [ String($execution.id ?? ''), String($('Configurar orquestación WF-019').first().json.trigger_type ?? 'manual'), String($('Configurar orquestación WF-019').first().json.organization_id ?? ''), String($('Configurar orquestación WF-019').first().json.requested_by_user_id ?? ''), String($('Configurar orquestación WF-019').first().json.process_id ?? ''), String($('Configurar orquestación WF-019').first().json.processing_mode ?? 'all') ] }}";

  const stages = orchestratedStages;
  workflow.nodes = workflow.nodes.filter((node) => node.type !== "n8n-nodes-base.executeWorkflow");
  stages.forEach((stage, index) => workflow.nodes.push(executeWorkflowNode(stage, [208 + index * 192, -240])));

  const finish = nodeByName(workflow, "Finalizar orquestación WF-019");
  finish.position = [208 + stages.length * 192, -240];
  finish.parameters.query = `UPDATE ops.workflow_runs\nSET status = 'success', finished_at = NOW(), completion_reason = 'pipeline_completed',\n    error_node = NULL, error_message = NULL,\n    error_details = COALESCE(error_details, '{}'::JSONB) || jsonb_build_object(\n      'pipeline_completed', TRUE, 'orchestration_version', 2, 'last_stage', 'WF-018',\n      'completed_stages', $2::JSONB, 'completed_at', NOW()),\n    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(\n      'pipeline_status', 'READY_FOR_FRONTEND', 'last_successful_stage', 'WF-018',\n      'ready_for_frontend', TRUE, 'orchestration_completed_at', NOW()), updated_at = NOW()\nWHERE workflow_code = 'WF-019' AND n8n_execution_id = $1::TEXT AND status = 'running'\nRETURNING id AS workflow_run_id, workflow_code, n8n_execution_id, status AS workflow_run_status,\n          started_at, finished_at, completion_reason, metadata ->> 'pipeline_status' AS pipeline_status, TRUE AS orchestration_finalized;`;
  finish.parameters.options.queryReplacement = `={{ [ String($execution.id ?? ''), JSON.stringify(${JSON.stringify(stages)}) ] }}`;

  setMain(workflow, start.name, [[`Ejecutar ${stages[0]}`]]);
  stages.forEach((stage, index) => {
    const next = stages[index + 1] ? `Ejecutar ${stages[index + 1]}` : finish.name;
    setMain(workflow, `Ejecutar ${stage}`, [[next]]);
  });
}

function makeWorkflow016() {
  const nodes = [
    {
      parameters: {}, type: "n8n-nodes-base.manualTrigger", typeVersion: 1,
      position: [-640, 0], id: "16000000-0000-4000-8000-000000000001", name: "Inicio Manual WF-016",
    },
    {
      parameters: { workflowInputs: { values: workflowInputValues } }, type: "n8n-nodes-base.executeWorkflowTrigger", typeVersion: 1.2,
      position: [-640, -176], id: "16000000-0000-4000-8000-000000000002", name: "Entrada desde WF-019",
    },
    {
      parameters: { jsCode: "const input = $input.first()?.json ?? {}; return [{ json: { ...input, organization_id: input.organization_id ?? '', process_id: input.process_id ?? '', max_opportunities: Math.min(25, Math.max(1, Number(input.max_opportunities ?? 10))), n8n_execution_id: String($execution.id ?? '') } }];" },
      type: "n8n-nodes-base.code", typeVersion: 2, position: [-400, -80], id: "16000000-0000-4000-8000-000000000003", name: "Configurar procesamiento WF-016",
    },
    {
      parameters: {
        operation: "executeQuery",
        query: `WITH grouped AS (\n  SELECT r.organization_id, r.opportunity_analysis_id, r.process_id, MAX(p.reference) AS process_reference,\n         COUNT(DISTINCT r.opportunity_document_id)::INTEGER AS source_document_count, COUNT(*)::INTEGER AS source_requirement_count,\n         ENCODE(DIGEST(CONVERT_TO(STRING_AGG(CONCAT_WS('|', r.id::TEXT, r.requirement_hash_sha256::TEXT, r.updated_at::TEXT), '|' ORDER BY r.id), 'UTF8'), 'sha256'), 'hex') AS input_hash_sha256\n  FROM saas.opportunity_requirements r JOIN secop.processes p ON p.id = r.process_id\n  WHERE r.status IN ('active', 'review_required')\n    AND (NULLIF($1::TEXT, '') IS NULL OR r.organization_id = NULLIF($1::TEXT, '')::UUID)\n    AND (NULLIF($2::TEXT, '') IS NULL OR r.process_id = NULLIF($2::TEXT, '')::UUID)\n  GROUP BY r.organization_id, r.opportunity_analysis_id, r.process_id\n), pending AS (\n  SELECT g.* FROM grouped g\n  WHERE NOT EXISTS (SELECT 1 FROM saas.opportunity_requirement_matrices m\n    WHERE m.organization_id = g.organization_id AND m.opportunity_analysis_id = g.opportunity_analysis_id\n      AND m.input_hash_sha256 = g.input_hash_sha256::CHAR(64) AND m.consolidation_version = 1 AND m.matrix_status = 'completed')\n  ORDER BY g.source_requirement_count DESC, g.opportunity_analysis_id LIMIT GREATEST(1, LEAST($3::INTEGER, 25))\n) SELECT * FROM pending;`,
        options: { queryReplacement: "={{ [ String($json.organization_id ?? ''), String($json.process_id ?? ''), Number($json.max_opportunities ?? 10) ] }}" },
      },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [-160, -80], id: "16000000-0000-4000-8000-000000000004", name: "Tomar oportunidades pendientes WF-016", alwaysOutputData: true, credentials: { postgres: postgresCredential },
    },
    {
      parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict", version: 3 }, conditions: [{ id: "16000000-0000-4000-8000-000000000005", leftValue: "={{ Boolean($json.opportunity_analysis_id) }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, options: {} },
      type: "n8n-nodes-base.if", typeVersion: 2.3, position: [80, -80], id: "16000000-0000-4000-8000-000000000006", name: "¿Hay oportunidades para consolidar?",
    },
    {
      parameters: { options: {} }, type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [320, -160], id: "16000000-0000-4000-8000-000000000007", name: "Consolidar una a una WF-016",
    },
    {
      parameters: {
        operation: "executeQuery",
        query: `SELECT * FROM saas.consolidate_opportunity_requirement_matrix_v1(\n  $1::UUID, $2::UUID, $3::UUID, $4::TEXT, $5::TEXT, $6::INTEGER, $7::INTEGER, 1, 'deterministic_v1', $8::TEXT\n);`,
        options: { queryReplacement: "={{ [ String($json.organization_id), String($json.opportunity_analysis_id), String($json.process_id), String($json.process_reference ?? ''), String($json.input_hash_sha256), Number($json.source_document_count ?? 0), Number($json.source_requirement_count ?? 0), String($execution.id ?? '') ] }}" },
      },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [560, -64], id: "16000000-0000-4000-8000-000000000008", name: "Consolidar matriz WF-016", credentials: { postgres: postgresCredential },
    },
    {
      parameters: { jsCode: "const config = $('Configurar procesamiento WF-016').first().json; return [{ json: { ...config, workflow_code: 'WF-016', workflow_status: 'success', completion_reason: 'queue_drained', finished_at: new Date().toISOString() } }];" },
      type: "n8n-nodes-base.code", typeVersion: 2, position: [560, -272], id: "16000000-0000-4000-8000-000000000009", name: "Finalizar WF-016",
    },
  ];
  const connections = {};
  const workflow = { name: "[CernoIA PROD] WF-016 — Consolidación de requisitos por oportunidad", nodes, connections, pinData: {}, active: false, settings: { executionOrder: "v1", timezone: "America/Bogota", callerPolicy: "workflowsFromSameOwner", errorWorkflow: errorWorkflowId }, versionId: "16000000-0000-4000-8000-000000000010", id: workflowIds["WF-016"], tags: [] };
  setMain(workflow, "Inicio Manual WF-016", [["Configurar procesamiento WF-016"]]);
  setMain(workflow, "Entrada desde WF-019", [["Configurar procesamiento WF-016"]]);
  setMain(workflow, "Configurar procesamiento WF-016", [["Tomar oportunidades pendientes WF-016"]]);
  setMain(workflow, "Tomar oportunidades pendientes WF-016", [["¿Hay oportunidades para consolidar?"]]);
  setMain(workflow, "¿Hay oportunidades para consolidar?", [["Consolidar una a una WF-016"], ["Finalizar WF-016"]]);
  setMain(workflow, "Consolidar una a una WF-016", [["Finalizar WF-016"], ["Consolidar matriz WF-016"]]);
  setMain(workflow, "Consolidar matriz WF-016", [["Consolidar una a una WF-016"]]);
  return workflow;
}

function makeWorkflow011() {
  const nodes = [
    {
      parameters: { httpMethod: "POST", path: "cernoia/wf-011", authentication: "headerAuth", responseMode: "onReceived", options: {} },
      type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [-720, 0], id: "11000000-0000-4000-8000-000000000001", name: "Webhook seguro CernoIA WF-011", webhookId: "11000000-0000-4000-8000-000000000002", credentials: { httpHeaderAuth: webhookCredential },
    },
    {
      parameters: { jsCode: `const raw = $input.first()?.json ?? {};\nconst input = raw.body && typeof raw.body === 'object' ? raw.body : raw;\nconst uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\nif (!uuid.test(String(input.organization_id ?? '')) || !uuid.test(String(input.organization_document_id ?? ''))) throw new Error('Identificadores inválidos para WF-011');\nconst url = new URL(String(input.download_url ?? ''));\nif (!['127.0.0.1', 'localhost', 'agentglobal.online', 'www.agentglobal.online'].includes(url.hostname) || !url.pathname.startsWith('/api/integrations/documents/')) throw new Error('URL de descarga no autorizada');\nreturn [{ json: { ...input, organization_id: String(input.organization_id), organization_document_id: String(input.organization_document_id), mime_type: String(input.mime_type ?? ''), download_url: url.toString(), n8n_execution_id: String($execution.id ?? '') } }];` },
      type: "n8n-nodes-base.code", typeVersion: 2, position: [-480, 0], id: "11000000-0000-4000-8000-000000000003", name: "Validar solicitud WF-011",
    },
    {
      parameters: { operation: "executeQuery", query: `UPDATE saas.organization_documents\nSET extraction_status = 'processing', verification_status = 'pending',\n    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('wf011_execution_id', $3::TEXT, 'wf011_started_at', NOW()), updated_at = NOW()\nWHERE id = $1::UUID AND organization_id = $2::UUID AND document_status <> 'deleted'\nRETURNING id AS organization_document_id, organization_id, document_type, document_name, original_filename, mime_type, $4::TEXT AS download_url;`, options: { queryReplacement: "={{ [ String($json.organization_document_id), String($json.organization_id), String($execution.id ?? ''), String($json.download_url) ] }}" } },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [-240, 0], id: "11000000-0000-4000-8000-000000000004", name: "Marcar documento en proceso WF-011", credentials: { postgres: postgresCredential },
    },
    {
      parameters: { conditions: { options: { caseSensitive: false, typeValidation: "strict", version: 3 }, conditions: [{ id: "11000000-0000-4000-8000-000000000005", leftValue: "={{ $json.mime_type }}", rightValue: "application/pdf", operator: { type: "string", operation: "equals" } }], combinator: "and" }, options: {} },
      type: "n8n-nodes-base.if", typeVersion: 2.3, position: [0, 0], id: "11000000-0000-4000-8000-000000000006", name: "¿Es PDF extraíble?",
    },
    {
      parameters: { url: "={{ $('Marcar documento en proceso WF-011').first().json.download_url }}", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", options: { response: { response: { responseFormat: "file" } }, timeout: 60000 } },
      type: "n8n-nodes-base.httpRequest", typeVersion: 4.4, position: [240, -112], id: "11000000-0000-4000-8000-000000000007", name: "Descargar documento privado WF-011", credentials: { httpHeaderAuth: webhookCredential }, onError: "continueErrorOutput",
    },
    {
      parameters: { operation: "pdf", options: {} }, type: "n8n-nodes-base.extractFromFile", typeVersion: 1.1, position: [480, -112], id: "11000000-0000-4000-8000-000000000008", name: "Extraer texto PDF WF-011", onError: "continueErrorOutput",
    },
    {
      parameters: { jsCode: "const source = $('Marcar documento en proceso WF-011').first().json; const text = String($json.text ?? $json.data ?? '').trim(); if (text.length < 20) throw new Error('El PDF no contiene texto suficiente; requiere OCR o revisión manual.'); return [{ json: { ...source, extracted_text: text.slice(0, 1000000), character_count: text.length } }];" },
      type: "n8n-nodes-base.code", typeVersion: 2, position: [720, -112], id: "11000000-0000-4000-8000-000000000009", name: "Normalizar extracción WF-011", onError: "continueErrorOutput",
    },
    {
      parameters: { operation: "executeQuery", query: `UPDATE saas.organization_documents\nSET extraction_status = 'success', extracted_text = $3::TEXT, verification_status = 'review_required',\n    ai_classification = jsonb_build_object('document_type', document_type, 'character_count', $4::INTEGER, 'classification_method', 'declared_type_and_pdf_text'),\n    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('wf011_finished_at', NOW(), 'wf011_result', 'text_extracted'), updated_at = NOW()\nWHERE id = $1::UUID AND organization_id = $2::UUID\nRETURNING id AS organization_document_id, extraction_status, verification_status, updated_at;`, options: { queryReplacement: "={{ [ String($json.organization_document_id), String($json.organization_id), String($json.extracted_text), Number($json.character_count ?? 0) ] }}" } },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [960, -112], id: "11000000-0000-4000-8000-000000000010", name: "Guardar extracción WF-011", credentials: { postgres: postgresCredential },
    },
    {
      parameters: { operation: "executeQuery", query: `UPDATE saas.organization_documents\nSET extraction_status = 'not_requested', verification_status = 'review_required',\n    ai_classification = jsonb_build_object('document_type', document_type, 'classification_method', 'declared_type', 'automatic_text_extraction', FALSE),\n    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('wf011_finished_at', NOW(), 'wf011_result', 'manual_review_required', 'wf011_note', 'La extracción automática inicial admite PDF con texto.'), updated_at = NOW()\nWHERE id = $1::UUID AND organization_id = $2::UUID\nRETURNING id AS organization_document_id, extraction_status, verification_status, updated_at;`, options: { queryReplacement: "={{ [ String($json.organization_document_id), String($json.organization_id) ] }}" } },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [240, 112], id: "11000000-0000-4000-8000-000000000011", name: "Solicitar revisión manual WF-011", credentials: { postgres: postgresCredential },
    },
    {
      parameters: { operation: "executeQuery", query: `UPDATE saas.organization_documents\nSET extraction_status = 'failed', verification_status = 'review_required',\n    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(\n      'wf011_finished_at', NOW(), 'wf011_result', 'extraction_failed', 'wf011_error', LEFT($3::TEXT, 2000),\n      'wf011_note', 'El archivo requiere OCR, conversión o revisión manual.'), updated_at = NOW()\nWHERE id = $1::UUID AND organization_id = $2::UUID\nRETURNING id AS organization_document_id, extraction_status, verification_status, updated_at;`, options: { queryReplacement: "={{ [ String($('Marcar documento en proceso WF-011').first().json.organization_document_id), String($('Marcar documento en proceso WF-011').first().json.organization_id), String($json.error?.message ?? $json.message ?? 'No fue posible descargar o extraer texto del PDF') ] }}" } },
      type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [720, 112], id: "11000000-0000-4000-8000-000000000014", name: "Registrar extracción fallida WF-011", credentials: { postgres: postgresCredential },
    },
    {
      parameters: { jsCode: "return [{ json: { ...$json, workflow_code: 'WF-011', workflow_status: $json.extraction_status === 'failed' ? 'partial' : 'success', finished_at: new Date().toISOString() } }];" },
      type: "n8n-nodes-base.code", typeVersion: 2, position: [1200, 0], id: "11000000-0000-4000-8000-000000000012", name: "Finalizar WF-011",
    },
  ];
  const workflow = { name: "[CernoIA PROD] WF-011 — Validación de documento empresarial", nodes, connections: {}, pinData: {}, active: false, settings: { executionOrder: "v1", timezone: "America/Bogota", callerPolicy: "workflowsFromSameOwner", errorWorkflow: errorWorkflowId }, versionId: "11000000-0000-4000-8000-000000000013", id: workflowIds["WF-011"], tags: [] };
  setMain(workflow, "Webhook seguro CernoIA WF-011", [["Validar solicitud WF-011"]]);
  setMain(workflow, "Validar solicitud WF-011", [["Marcar documento en proceso WF-011"]]);
  setMain(workflow, "Marcar documento en proceso WF-011", [["¿Es PDF extraíble?"]]);
  setMain(workflow, "¿Es PDF extraíble?", [["Descargar documento privado WF-011"], ["Solicitar revisión manual WF-011"]]);
  setMain(workflow, "Descargar documento privado WF-011", [["Extraer texto PDF WF-011"], ["Registrar extracción fallida WF-011"]]);
  setMain(workflow, "Extraer texto PDF WF-011", [["Normalizar extracción WF-011"], ["Registrar extracción fallida WF-011"]]);
  setMain(workflow, "Normalizar extracción WF-011", [["Guardar extracción WF-011"], ["Registrar extracción fallida WF-011"]]);
  setMain(workflow, "Guardar extracción WF-011", [["Finalizar WF-011"]]);
  setMain(workflow, "Solicitar revisión manual WF-011", [["Finalizar WF-011"]]);
  setMain(workflow, "Registrar extracción fallida WF-011", [["Finalizar WF-011"]]);
  return workflow;
}

async function makeWorkflow000() {
  const migrations = ["000_core_runtime.sql", "001_frontend_auth.sql", "002_product_frontend.sql", "003_workflow_engines.sql"];
  const sql = (await Promise.all(migrations.map((filename) => readFile(join(projectRoot, "backend/sql", filename), "utf8")))).join("\n\n");
  const workflow = {
    name: "[CernoIA PROD] WF-000 — Inicialización segura de base de datos",
    nodes: [
      { parameters: {}, type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-240, 0], id: "00000000-0000-4000-8000-000000000001", name: "Inicio manual seguro WF-000" },
      { parameters: { operation: "executeQuery", query: sql, options: {} }, type: "n8n-nodes-base.postgres", typeVersion: 2.6, position: [0, 0], id: "00000000-0000-4000-8000-000000000002", name: "Aplicar esquema idempotente CernoIA", credentials: { postgres: postgresCredential } },
    ],
    connections: { "Inicio manual seguro WF-000": { main: [[connection("Aplicar esquema idempotente CernoIA")]] } },
    pinData: {}, active: false, settings: { executionOrder: "v1", timezone: "America/Bogota" }, versionId: "00000000-0000-4000-8000-000000000003", id: "dapv3NF1XuPsKKtj", tags: [],
  };
  return workflow;
}

const sourceFiles = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".json"));
const workflows = new Map();
for (const filename of sourceFiles) {
  const code = filename.match(/WF-\d{3}/)?.[0];
  if (!code || code === "WF-000") continue;
  const workflow = JSON.parse(await readFile(join(sourceDirectory, filename), "utf8"));
  normalizeWorkflow(workflow, code);
  workflows.set(code, workflow);
}

patchWorkflow001(workflows.get("WF-001"));
ensureSubworkflowTrigger(workflows.get("WF-002"), "Adquirir bloqueo WF-002", [-592, 432]);
ensureSubworkflowTrigger(workflows.get("WF-003"), "Adquirir bloqueo WF-003", [-544, 448]);
ensureSubworkflowTrigger(workflows.get("WF-005"), "Adquirir bloqueo WF-005");
patchWorkflow008(workflows.get("WF-008"));

patchCodeConfiguration(workflows.get("WF-012"), "Configurar procesamiento WF-012", {
  workflow_code: "WF-012", source_code: "SECOP_ORGANIZATION_DOCUMENT_VALIDITY", processing_mode: "all",
  max_documents: 10, calculation_version: 1, lock_minutes: 30, stale_lock_minutes: 45,
});
ensureSubworkflowTrigger(workflows.get("WF-012"), "Configurar procesamiento WF-012");
patchWorkflow013(workflows.get("WF-013"));
patchWorkflow014(workflows.get("WF-014"));
ensureSubworkflowTrigger(workflows.get("WF-014"), "Configurar procesamiento WF-014");
patchSetConfiguration(workflows.get("WF-015"), "Configurar procesamiento WF-015", { processing_mode: "all", max_documents: 2, minimum_characters: 100, model_name: "models/gemini-3.1-flash-lite", prompt_version: 2 });
ensureSubworkflowTrigger(workflows.get("WF-015"), "Configurar procesamiento WF-015");
patchCodeConfiguration(workflows.get("WF-017"), "Configurar procesamiento WF-017", {
  workflow_code: "WF-017", source_code: "SECOP_OPPORTUNITY_COMPLIANCE_EVALUATION", processing_mode: "all",
  max_matrices: 10, evaluation_version: 3, evaluation_method: "deterministic_v3", lock_minutes: 30, stale_lock_minutes: 45,
});
ensureSubworkflowTrigger(workflows.get("WF-017"), "Configurar procesamiento WF-017");
patchCodeConfiguration(workflows.get("WF-018"), "Configurar procesamiento WF-018", {
  workflow_code: "WF-018", source_code: "SECOP_OPPORTUNITY_ACTION_PLAN_GENERATION", processing_mode: "all",
  max_evaluations: 10, plan_version: 1, generation_method: "deterministic_v1", lock_minutes: 30, stale_lock_minutes: 45,
});
ensureSubworkflowTrigger(workflows.get("WF-018"), "Configurar procesamiento WF-018");
patchWorkflow018(workflows.get("WF-018"));
patchWorkflow019(workflows.get("WF-019"));

workflows.set("WF-011", makeWorkflow011());
workflows.set("WF-016", makeWorkflow016());

for (const code of orchestratedStages) removeIndependentSchedules(workflows.get(code));
for (const workflow of workflows.values()) pruneUnreachable(workflow);

for (const filename of await readdir(outputDirectory)) {
  if (filename.endsWith(".json")) await unlink(join(outputDirectory, filename));
}

await writeFile(join(outputDirectory, "WF-000-inicializacion-segura.json"), `${JSON.stringify(await makeWorkflow000(), null, 2)}\n`, "utf8");
for (const [code, workflow] of [...workflows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const filename = filenames[code];
  if (!filename) continue;
  await writeFile(join(outputDirectory, filename), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
}

const manifest = {
  generated_at: new Date().toISOString(),
  import_safety: "Todos los workflows se entregan inactivos para evitar ejecuciones duplicadas al importarlos.",
  activation_order: ["WF-007", "WF-001", "WF-002", "WF-003", "WF-005", "WF-008", "WF-011", "WF-012", "WF-013", "WF-014", "WF-015", "WF-016", "WF-017", "WF-018", "WF-019"],
  orchestrated_stages: orchestratedStages,
  workflows: Object.fromEntries(Object.entries(workflowIds).map(([code, id]) => [code, { id, file: code === "WF-000" ? "WF-000-inicializacion-segura.json" : filenames[code] }])),
};
await writeFile(join(outputDirectory, "..", "workflow-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Paquete n8n generado en ${outputDirectory}`);
