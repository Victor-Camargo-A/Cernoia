const recipients = ['cvictor121@gmail.com', 'anakathe335@gmail.com'];
export async function enqueueOwnerSale(client, order, event) {
  const subject = `[CernoIA] Venta confirmada — ${order.reference}`;
  const body = `Nueva venta confirmada en https://cernoia.energeticanika.com\n\nReferencia: ${order.reference}\nPlan: ${order.plan_code}\nImporte: ${Number(order.amount_cop).toLocaleString('es-CO')} COP\nEstado: pago aprobado por Bold\nMedio de pago: ${event.paymentMethod || 'Bold'}\n\nConsulta el detalle en el panel de administración de CernoIA.`;
  for (const recipient of recipients) {
    await client.query(`INSERT INTO saas.notification_outbox
      (organization_id, channel_type, event_type, recipient, subject, body_text, payload, idempotency_key, scheduled_at)
      VALUES ($1, 'email', 'owner_sale_confirmed', $2, $3, $4, $5::jsonb, $6, NOW())
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [order.organization_id, recipient, subject, body, JSON.stringify({billing_order_id:order.id}), `owner-sale:${order.id}:${recipient}`]);
  }
}
