import { createHash, createHmac } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../security.js";

export function verifyBoldSignature(rawBody, signature) {
  // Nunca aceptar una firma derivada de una llave vacía, ni siquiera en pruebas.
  // El entorno sandbox debe usar también una llave explícita.
  if (!config.boldSecretKey) return false;
  const encodedBody = Buffer.from(rawBody).toString("base64");
  const expected = createHmac("sha256", config.boldSecretKey).update(encodedBody).digest("hex");
  return safeEqual(expected.toLowerCase(), String(signature ?? "").trim().toLowerCase());
}

export function boldEventId(payload, rawBody) {
  const provided = payload?.id ?? payload?.event_id ?? payload?.eventId;
  return String(provided || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`).slice(0, 160);
}

export async function createBoldPaymentLink({ amountCop, reference, description, callbackUrl }) {
  if (!config.boldIdentityKey || !config.boldSecretKey) {
    const error = new Error("Las llaves de integración de Bold no están configuradas.");
    error.statusCode = 503;
    throw error;
  }
  const expiration = BigInt(Date.now() + config.boldCheckoutTtlMinutes * 60_000) * 1_000_000n;
  const response = await fetch(`${config.boldApiBaseUrl}/online/link/v1`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    headers: {
      authorization: `x-api-key ${config.boldIdentityKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount_type: "CLOSE",
      amount: { currency: "COP", total_amount: Number(amountCop) },
      reference,
      description: String(description).slice(0, 100),
      expiration_date: expiration.toString(),
      callback_url: callbackUrl,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`No fue posible crear el enlace de Bold (HTTP ${response.status}). Intenta nuevamente o contacta al administrador.`);
    error.statusCode = 502;
    error.providerResponse = data;
    throw error;
  }
  const payload = data?.payload ?? data?.data ?? data;
  const providerLinkId = payload?.payment_link ?? payload?.payment_link_id ?? payload?.id;
  const checkoutUrl = payload?.url ?? payload?.checkout_url ?? payload?.payment_url;
  if (!providerLinkId || !checkoutUrl) {
    const error = new Error("Bold no devolvió el enlace de pago esperado.");
    error.statusCode = 502;
    error.providerResponse = data;
    throw error;
  }
  const url = new URL(String(checkoutUrl));
  if (url.protocol !== "https:" || url.hostname !== "checkout.bold.co" || url.username || url.password || url.port) {
    const error = new Error("Bold devolvió una dirección de pago no válida.");
    error.statusCode = 502;
    throw error;
  }
  return { providerLinkId: String(providerLinkId), checkoutUrl: url.href, raw: data };
}

export function normalizeBoldEvent(payload) {
  const data = payload?.data ?? {};
  const metadata = data?.metadata ?? payload?.metadata ?? {};
  const amount = data?.amount ?? data?.payment?.amount ?? payload?.amount ?? {};
  return {
    type: String(payload?.type ?? payload?.event_type ?? payload?.eventType ?? "UNKNOWN").toUpperCase(),
    providerLinkId: String(
      data?.payment_link
      ?? data?.payment_link_id
      ?? payload?.payment_link
      ?? payload?.payment_link_id
      ?? metadata?.payment_link
      ?? metadata?.payment_link_id
      ?? "",
    ),
    merchantReference: String(
      data?.reference
      ?? metadata?.reference
      ?? metadata?.merchant_reference
      ?? payload?.reference
      ?? "",
    ),
    transactionId: String(data?.payment_id ?? data?.transaction_id ?? data?.id ?? payload?.transaction_id ?? ""),
    amountCop: Number(amount?.total_amount ?? amount?.total ?? data?.total_amount ?? payload?.total_amount ?? NaN),
    currency: String(amount?.currency ?? data?.currency ?? payload?.currency ?? "").toUpperCase(),
    payerEmail: String(data?.payer_email ?? data?.payer?.email ?? "").slice(0, 254),
    paymentMethod: String(data?.payment_method ?? data?.payment_method_type ?? "").slice(0, 120),
  };
}

// Las entregas repetidas y fuera de orden no deben extender un periodo dos veces.
export function boldOrderAction(order, event) {
  if (!["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED"].includes(event.type)) return "ignore";
  if ((event.merchantReference && event.merchantReference !== order.reference)
    || (event.providerLinkId && order.provider_link_id && event.providerLinkId !== order.provider_link_id)) {
    throw new Error("La referencia del webhook no coincide con la orden.");
  }
  if (event.type === "SALE_APPROVED" || event.type === "VOID_APPROVED") {
    if (!event.transactionId || !Number.isSafeInteger(event.amountCop)
      || event.amountCop !== Number(order.amount_cop) || event.currency !== "COP") {
      throw new Error("La transacción, el valor o la moneda del webhook no coincide con la orden.");
    }
  }
  if (order.status === "cancelled") return "ignore";
  if (event.type === "SALE_APPROVED") return order.status === "approved" ? "ignore" : "approve";
  if (event.type === "SALE_REJECTED") return order.status === "approved" ? "ignore" : "reject";
  if (order.provider_transaction_id && event.transactionId !== order.provider_transaction_id) {
    throw new Error("La anulación corresponde a otra transacción.");
  }
  return "cancel";
}

export async function fetchBoldLink(order) {
  if (!/^LNK_[a-z0-9_-]+$/i.test(order.provider_link_id ?? '')) throw new Error('Enlace de pago no válido.');
  const response = await fetch(`${config.boldApiBaseUrl}/online/link/v1/${encodeURIComponent(order.provider_link_id)}`, {
    headers: {authorization: `x-api-key ${config.boldIdentityKey}`}, redirect:'error', signal:AbortSignal.timeout(10_000),
  });
  if(!response.ok) throw new Error('No fue posible consultar el estado en Bold.');
  const raw=await response.json(); const data=raw.payload??raw.data??raw;
  if(data.id!==order.provider_link_id || data.reference!==order.reference || Number(data.total)!==Number(order.amount_cop)
    || data.currency!=='COP' || data.is_sandbox!==(config.boldEnvironment==='test')) throw new Error('Bold devolvió datos que requieren revisión de la orden.');
  return data;
}
