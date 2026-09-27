#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = resolve(process.argv[2] ?? join(projectRoot, "n8n/workflows"));
const expectedCodes = ["WF-000", "WF-001", "WF-002", "WF-003", "WF-005", "WF-007", "WF-008", "WF-011", "WF-012", "WF-013", "WF-014", "WF-015", "WF-016", "WF-017", "WF-018", "WF-019", "WF-020", "WF-021", "WF-022", "WF-023", "WF-024", "WF-025", "WF-026"];
const expectedPipeline = ["WF-001", "WF-002", "WF-003", "WF-005", "WF-008", "WF-013", "WF-014", "WF-015", "WF-016", "WF-012", "WF-017", "WF-018"];
const triggerTypes = new Set([
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.errorTrigger",
]);

const failures = [];
const warnings = [];
const workflows = new Map();

function fail(code, message) {
  failures.push(`${code}: ${message}`);
}

function warn(code, message) {
  warnings.push(`${code}: ${message}`);
}

function walkStrings(value, visit, path = "root") {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.forEach((item, index) => walkStrings(item, visit, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkStrings(item, visit, `${path}.${key}`);
  }
}

for (const filename of (await readdir(workflowDirectory)).filter((name) => name.endsWith(".json")).sort()) {
  let workflow;
  try {
    workflow = JSON.parse(await readFile(join(workflowDirectory, filename), "utf8"));
  } catch (error) {
    fail(filename, `JSON inválido: ${error.message}`);
    continue;
  }
  const code = workflow.name?.match(/WF-\d{3}/)?.[0] ?? filename.match(/WF-\d{3}/)?.[0];
  if (!code) {
    fail(filename, "no tiene código WF-000 reconocible");
    continue;
  }
  if (workflows.has(code)) fail(code, "hay más de un archivo con el mismo código");
  workflows.set(code, workflow);

  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes ?? []) {
    if (names.has(node.name)) fail(code, `nombre de nodo duplicado: ${node.name}`);
    if (ids.has(node.id)) fail(code, `id de nodo duplicado: ${node.id}`);
    names.add(node.name);
    ids.add(node.id);
    for (const assignment of node.parameters?.assignments?.assignments ?? []) {
      if (String(assignment.name).startsWith("=")) fail(code, `campo inválido ${assignment.name} en ${node.name}`);
    }
    if (node.type === "n8n-nodes-base.executeCommand") fail(code, `Execute Command no permitido en paquete seguro: ${node.name}`);
    if (node.type === "n8n-nodes-base.postgres") {
      const query = String(node.parameters?.query ?? "");
      const replacement = node.parameters?.options?.queryReplacement;
      if (/^\+/m.test(query)) fail(code, `${node.name} contiene marcadores de parche dentro del SQL`);
      if (/'\$\d+'/.test(query)) fail(code, `${node.name} conserva un parámetro SQL entre comillas`);
      if (/\$\d+/.test(query) && (typeof replacement !== "string" || !replacement.trim().startsWith("={{"))) {
        fail(code, `${node.name} usa parámetros SQL sin queryReplacement válido`);
      }
      if (query.includes("{{")) warn(code, `${node.name} conserva interpolación heredada dentro del SQL`);
    }
  }

  walkStrings(workflow, (text, fieldPath) => {
    if (text.startsWith("=={{")) fail(code, `expresión con doble igual en ${fieldPath}`);
    if (/902\.050\.074|Victor Alfonso Camargo|Energética Nika|organizacion-piloto/i.test(text)) {
      fail(code, `contiene datos piloto o personales en ${fieldPath}`);
    }
  });

  for (const [source, groups] of Object.entries(workflow.connections ?? {})) {
    if (!names.has(source)) fail(code, `conexión desde nodo inexistente: ${source}`);
    for (const outputs of Object.values(groups)) {
      for (const output of outputs ?? []) {
        for (const edge of output ?? []) if (!names.has(edge.node)) fail(code, `conexión hacia nodo inexistente: ${edge.node}`);
      }
    }
  }

  if (!(workflow.nodes ?? []).some((node) => triggerTypes.has(node.type))) fail(code, "no tiene disparador");
  if (workflow.active !== false) fail(code, "debe entregarse inactivo para una importación sin duplicados");
}

for (const code of expectedCodes) if (!workflows.has(code)) fail(code, "workflow requerido ausente");

const orchestrator = workflows.get("WF-019");
if (orchestrator) {
  const webhook = orchestrator.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (!webhook) fail("WF-019", "falta webhook para el frontend");
  if (webhook?.parameters?.authentication !== "headerAuth") fail("WF-019", "el webhook no usa Header Auth");
  if (webhook?.parameters?.responseMode !== "onReceived") fail("WF-019", "el webhook no responde de inmediato");
  const actualPipeline = [];
  let current = orchestrator.connections["Registrar inicio WF-019"]?.main?.[0]?.[0]?.node;
  const visited = new Set();
  while (current?.startsWith("Ejecutar WF-") && !visited.has(current)) {
    visited.add(current);
    actualPipeline.push(current.replace("Ejecutar ", ""));
    current = orchestrator.connections[current]?.main?.[0]?.[0]?.node;
  }
  if (JSON.stringify(actualPipeline) !== JSON.stringify(expectedPipeline)) {
    fail("WF-019", `orden del pipeline incorrecto: ${actualPipeline.join(" -> ")}`);
  }
  for (const code of expectedPipeline) {
    const caller = orchestrator.nodes.find((node) => node.name === `Ejecutar ${code}`);
    if (!caller?.alwaysOutputData) fail("WF-019", `${caller?.name ?? code} puede cortar el pipeline cuando una etapa termina sin filas`);
  }
  const startQuery = orchestrator.nodes.find((node) => node.name === "Registrar inicio WF-019")?.parameters?.query ?? "";
  if (!startQuery.includes("organization_id")) fail("WF-019", "no registra organization_id en la trazabilidad");
}

for (const code of expectedPipeline) {
  const workflow = workflows.get(code);
  if (!workflow) continue;
  const trigger = workflow.nodes.find((node) => node.type === "n8n-nodes-base.executeWorkflowTrigger");
  const fields = trigger?.parameters?.workflowInputs?.values?.map((item) => item.name) ?? [];
  if (!trigger) fail(code, "no puede ser llamado como subworkflow");
  if (!fields.includes("organization_id") || !fields.includes("orchestration_execution_id")) {
    fail(code, "contrato de entrada del subworkflow incompleto");
  }
  if (workflow.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger")) {
    fail(code, "conserva un horario independiente y podría duplicar la ejecución del orquestador");
  }
}

const workflow008 = workflows.get("WF-008");
if (workflow008) {
  const successNext = workflow008.connections["Guardar análisis exitoso WF-008"]?.main?.[0]?.[0]?.node;
  const failureNext = workflow008.connections["Registrar fallo IA WF-008"]?.main?.[0]?.[0]?.node;
  const loopNext = workflow008.connections["Pausa entre análisis WF-008"]?.main?.[0]?.[0]?.node;
  if (successNext !== "Pausa entre análisis WF-008" || failureNext !== "Pausa entre análisis WF-008" || loopNext !== "Tomar lote para AI Agent WF-008") {
    fail("WF-008", "no vuelve a la cola después de procesar un análisis");
  }
}

const workflow011 = workflows.get("WF-011");
if (workflow011) {
  const webhook = workflow011.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (webhook?.parameters?.authentication !== "headerAuth" || webhook?.parameters?.responseMode !== "onReceived") {
    fail("WF-011", "el webhook documental no tiene autenticación/respuesta segura");
  }
  const failureNode = workflow011.nodes.find((node) => node.name === "Registrar extracción fallida WF-011");
  if (!failureNode) fail("WF-011", "no registra un PDF que falla durante descarga o extracción");
  for (const nodeName of ["Descargar documento privado WF-011", "Extraer texto PDF WF-011", "Normalizar extracción WF-011"]) {
    const node = workflow011.nodes.find((candidate) => candidate.name === nodeName);
    const errorTarget = workflow011.connections[nodeName]?.main?.[1]?.[0]?.node;
    if (node?.onError !== "continueErrorOutput" || errorTarget !== "Registrar extracción fallida WF-011") {
      fail("WF-011", `${nodeName} no deriva sus errores a revisión manual`);
    }
  }
}

const quotaWorkflow = workflows.get("WF-020");
if (quotaWorkflow) {
  const quotaPolicyNode = quotaWorkflow.nodes.find((node) => node.name === "Cargar política de cuota WF-020");
  if (
    quotaPolicyNode?.type !== "n8n-nodes-base.postgres"
    || !String(quotaPolicyNode.parameters?.query ?? "").includes("ops.ai_quota_policies")
  ) {
    fail("WF-020", "no carga la política central de cuotas desde PostgreSQL");
  }
  const redisCounters = quotaWorkflow.nodes.filter(
    (node) => node.type === "n8n-nodes-base.redis" && node.parameters?.operation === "incr",
  );
  if (redisCounters.length !== 2) fail("WF-020", "debe reservar exactamente una cuota diaria y una cuota por minuto con Redis INCR");
  for (const counter of redisCounters) {
    if (counter.parameters?.expire !== true || Number(counter.parameters?.ttl) < 60) {
      fail("WF-020", `${counter.name} no define una expiración segura`);
    }
    if (!counter.credentials?.redis) fail("WF-020", `${counter.name} no tiene credencial Redis`);
  }
  if (!redisCounters.some((node) => Number(node.parameters?.ttl) >= 86400)) fail("WF-020", "falta el contador diario");
  if (!redisCounters.some((node) => Number(node.parameters?.ttl) <= 300)) fail("WF-020", "falta el contador por minuto");
  const waitNode = quotaWorkflow.nodes.find((node) => node.type === "n8n-nodes-base.wait");
  if (waitNode?.parameters?.unit !== "seconds") fail("WF-020", "la espera por cuota debe medirse en segundos");
}

for (const code of ["WF-008", "WF-011", "WF-015", "WF-021", "WF-022", "WF-023"]) {
  const workflow = workflows.get(code);
  if (!workflow) continue;
  const quotaCaller = workflow.nodes.find(
    (node) => node.type === "n8n-nodes-base.executeWorkflow"
      && Boolean(quotaWorkflow?.id)
      && node.parameters?.workflowId?.value === quotaWorkflow.id,
  );
  if (!quotaCaller) fail(code, "llama a Gemini sin reservar cuota mediante WF-020");
  for (const agent of workflow.nodes.filter((node) => node.type === "@n8n/n8n-nodes-langchain.agent")) {
    if (Number(agent.parameters?.options?.maxIterations ?? 1) > 1) fail(code, `${agent.name} puede realizar múltiples llamadas por una sola reserva`);
    if (agent.retryOnFail === true || Number(agent.maxTries ?? 1) > 1) fail(code, `${agent.name} reintenta fuera del control Redis`);
  }
}

const chatWorkflow = workflows.get("WF-023");
if (chatWorkflow) {
  const webhook = chatWorkflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (webhook?.parameters?.authentication !== "headerAuth" || webhook?.parameters?.responseMode !== "lastNode") {
    fail("WF-023", "el chat no tiene autenticación de cabecera o no devuelve el resultado final");
  }
  const contextQuery = chatWorkflow.nodes.find((node) => node.name === "Cargar contexto autorizado WF-023");
  if (
    contextQuery?.type !== "n8n-nodes-base.postgres"
    || !String(contextQuery.parameters?.query ?? "").includes("$1::UUID")
    || !String(contextQuery.parameters?.options?.queryReplacement ?? "").startsWith("={{")
  ) {
    fail("WF-023", "no consulta el contexto empresarial con parámetros SQL seguros");
  }
  const agent = chatWorkflow.nodes.find((node) => node.type === "@n8n/n8n-nodes-langchain.agent");
  if (Number(agent?.parameters?.options?.maxIterations ?? 0) !== 1) {
    fail("WF-023", "el agente debe limitarse a una iteración por reserva de cuota");
  }
}

const documentOcrWorkflow = workflows.get("WF-024");
if (documentOcrWorkflow) {
  const webhook = documentOcrWorkflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (webhook?.parameters?.authentication !== "headerAuth" || webhook?.parameters?.responseMode !== "onReceived") {
    fail("WF-024", "el OCR no tiene webhook seguro con respuesta inmediata");
  }
  if (!documentOcrWorkflow.nodes.some((node) => node.type === "n8n-nodes-base.httpRequest"
    && String(node.parameters?.url ?? "").includes("/api/integrations/documents/"))) {
    fail("WF-024", "no llama al extractor documental privado");
  }
}

for (const [code, endpoint] of [
  ["WF-025", "/api/integrations/notifications/dispatch"],
  ["WF-026", "/api/integrations/billing/reconcile"],
]) {
  const scheduled = workflows.get(code);
  if (!scheduled) continue;
  if (!scheduled.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger")) {
    fail(code, "no tiene un disparador programado");
  }
  if (!scheduled.nodes.some((node) => node.type === "n8n-nodes-base.httpRequest"
    && String(node.parameters?.url ?? "").includes(endpoint))) {
    fail(code, `no llama al endpoint privado ${endpoint}`);
  }
}

const alertWorkflow = workflows.get("WF-021");
if (alertWorkflow) {
  if (!alertWorkflow.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger")) fail("WF-021", "no tiene ejecución diaria");
  if (!alertWorkflow.nodes.some((node) => String(node.parameters?.query ?? "").includes("saas.document_alerts"))) {
    fail("WF-021", "no materializa las alertas documentales");
  }
  if (!alertWorkflow.nodes.some((node) => String(node.parameters?.query ?? "").includes("saas.alert_digests"))) {
    fail("WF-021", "no persiste el resumen inteligente");
  }
}

const proposalWorkflow = workflows.get("WF-022");
if (proposalWorkflow) {
  const webhook = proposalWorkflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  if (webhook?.parameters?.authentication !== "headerAuth" || webhook?.parameters?.responseMode !== "onReceived") {
    fail("WF-022", "el webhook de propuestas no tiene autenticación/respuesta segura");
  }
  const renderer = proposalWorkflow.nodes.find((node) => node.name === "Renderizar PDF privado WF-022");
  if (renderer?.type !== "n8n-nodes-base.httpRequest" || !String(renderer.parameters?.url ?? "").includes("/api/integrations/proposals/")) {
    fail("WF-022", "no entrega el contenido al renderizador privado de la API");
  }
}

const manifest = JSON.parse(await readFile(join(workflowDirectory, "..", "workflow-manifest.json"), "utf8"));
if (JSON.stringify(manifest.orchestrated_stages) !== JSON.stringify(expectedPipeline)) fail("manifest", "el pipeline documentado no coincide con el auditado");
for (const code of expectedCodes.filter((value) => value !== "WF-000")) {
  if (!manifest.workflows?.[code]) fail("manifest", `no registra ${code}`);
}
if ((manifest.activation_order ?? []).indexOf("WF-020") > (manifest.activation_order ?? []).indexOf("WF-008")) {
  fail("manifest", "WF-020 debe activarse antes de los workflows que llaman a Gemini");
}

console.log(`Workflows revisados: ${workflows.size}`);
console.log(`Advertencias: ${warnings.length}`);
for (const message of warnings) console.log(`  AVISO ${message}`);
if (failures.length) {
  console.error(`Fallos: ${failures.length}`);
  for (const message of failures) console.error(`  ERROR ${message}`);
  process.exitCode = 1;
} else {
  console.log("Resultado: APROBADO");
}
