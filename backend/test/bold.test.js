import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.BOLD_IDENTITY_KEY = "test-identity-placeholder";
process.env.BOLD_SECRET_KEY = "test-webhook-placeholder";
const { boldOrderAction, createBoldPaymentLink } = await import("../src/services/bold.js");
const order = { id: "order-1", reference: "CERNOIA-1", amount_cop: "250000", provider_link_id: "LNK_1", status: "link_created" };
const event = { type: "SALE_APPROVED", merchantReference: "CERNOIA-1", providerLinkId: "LNK_1", transactionId: "PAY-1", amountCop: 250000, currency: "COP" };
test("un pago aprobado activa una sola vez y un rechazo tardío no desactiva", () => {
  assert.equal(boldOrderAction(order, event), "approve");
  assert.equal(boldOrderAction({ ...order, status: "approved" }, event), "ignore");
  assert.equal(boldOrderAction({ ...order, status: "approved" }, { ...event, type: "SALE_REJECTED" }), "ignore");
  assert.equal(boldOrderAction(order, { ...event, type: "SALE_REJECTED" }), "reject");
});
test("rechaza importes, monedas, referencias y transacciones incompatibles", () => {
  for (const change of [{ amountCop: 1 }, { amountCop: NaN }, { currency: "USD" }, { transactionId: "" }, { merchantReference: "CERNOIA-2" }, { providerLinkId: "LNK_2" }]) {
    assert.throws(() => boldOrderAction(order, { ...event, ...change }));
  }
});
test("una anulación rechazada no equivale a un pago rechazado", () => {
  assert.equal(boldOrderAction(order, { ...event, type: "VOID_REJECTED" }), "ignore");
});
test("una anulación repetida no cancela otra vez ni un aprobado tardío reactiva", () => {
  const approved = { ...order, status: "approved", provider_transaction_id: "PAY-1" };
  assert.equal(boldOrderAction(approved, { ...event, type: "VOID_APPROVED" }), "cancel");
  assert.throws(() => boldOrderAction(approved, { ...event, type: "VOID_APPROVED", transactionId: "PAY-2" }));
  assert.equal(boldOrderAction({ ...order, status: "cancelled" }, event), "ignore");
  assert.equal(boldOrderAction({ ...order, status: "cancelled" }, { ...event, type: "VOID_APPROVED" }), "ignore");
});
test("la API acepta el formato oficial de enlace y rechaza redirecciones ajenas", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.amount.total_amount, 250000);
    assert.equal(body.reference, "CERNOIA-1");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return Response.json({ payload: { payment_link: "LNK_1", url: "https://checkout.bold.co/LNK_1" }, errors: [] });
  });
  const args = { amountCop: 250000, reference: "CERNOIA-1", description: "Plan mensual", callbackUrl: "https://cernoia.secretbloom.tech/acceso?billing=return" };
  assert.equal((await createBoldPaymentLink(args)).checkoutUrl, "https://checkout.bold.co/LNK_1");
  fetchMock.mock.mockImplementation(async () => Response.json({ payload: { payment_link: "LNK_1", url: "https://example.com/payment" } }));
  await assert.rejects(createBoldPaymentLink(args), /dirección de pago no válida/);
  fetchMock.mock.mockImplementation(async () => Response.json({ message: "SENSITIVE-PROVIDER-CONTENT" }, { status: 401 }));
  await assert.rejects(createBoldPaymentLink(args), error => error.statusCode === 502 && !error.message.includes("SENSITIVE"));
});
