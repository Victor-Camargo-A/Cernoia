import { config } from "../config.js";
import { signWebhookPayload } from "../security.js";

export async function checkN8nHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(config.n8nHealthUrl, { signal: controller.signal });
    return { online: response.ok, status: response.status };
  } catch (error) {
    return { online: false, error: error.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectN8nWorkflows() {
  if (!config.n8nApiKey) {
    return { available: false, reason: "api_key_not_configured", workflows: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.n8nBaseUrl}/api/v1/workflows?limit=250`, {
      headers: { "X-N8N-API-KEY": config.n8nApiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { available: false, reason: `n8n_api_${response.status}`, workflows: [] };
    }
    const payload = await response.json();
    const records = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return {
      available: true,
      workflows: records.map((workflow) => ({
        id: String(workflow.id ?? ""),
        name: String(workflow.name ?? ""),
        active: Boolean(workflow.active),
      })),
    };
  } catch (error) {
    return { available: false, reason: error.name === "AbortError" ? "timeout" : "unreachable", workflows: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorkflow(code, input, { timeoutMs = config.n8nTimeoutMs } = {}) {
  const url = config.workflowUrls[code];
  if (!url) {
    const error = new Error(`El webhook de ${code} no está configurado.`);
    error.statusCode = 503;
    throw error;
  }
  if (!config.n8nWebhookSecret) {
    const error = new Error("N8N_WEBHOOK_SECRET no está configurado.");
    error.statusCode = 503;
    throw error;
  }

  const body = JSON.stringify({
    ...input,
    workflow_code: code,
    requested_at: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.n8nWebhookSecret}`,
        "x-cernoia-signature": signWebhookPayload(body, config.n8nWebhookSecret),
      },
      body,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { message: await response.text() };
    if (!response.ok) {
      const error = new Error(data?.message || `n8n respondió ${response.status}.`);
      error.statusCode = 502;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("n8n superó el tiempo máximo de respuesta.");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
