import { query, withTenantTransaction } from "../db.js";

const DEMO_REQUIRED_MESSAGE = "Tu demo ya se usó en otra oportunidad. Activa la membresía para continuar.";
function membershipIsActive(row) { return Boolean(row?.status === "active" && (!row.current_period_end || new Date(row.current_period_end).getTime() > Date.now())); }
async function readAccess(clientOrQuery, organizationId) {
  const result = await clientOrQuery.query(`SELECT organization.demo_enabled, organization.demo_postulation_process_id, organization.demo_postulation_started_at, subscription.status AS subscription_status, subscription.current_period_end FROM saas.organizations organization LEFT JOIN saas.subscriptions subscription ON subscription.organization_id = organization.id WHERE organization.id = $1 LIMIT 1`, [organizationId]);
  return result.rows[0] ?? null;
}
function accessPayload(row, processId = null) {
  const membershipActive = membershipIsActive({ status: row?.subscription_status, current_period_end: row?.current_period_end });
  const demoProcessId = row?.demo_postulation_process_id ?? null;
  const sameProcess = Boolean(processId && demoProcessId && String(processId) === String(demoProcessId));
  return { membership_active: membershipActive, demo_enabled: Boolean(row?.demo_enabled), demo_used: Boolean(demoProcessId), demo_process_id: demoProcessId, demo_remaining: row?.demo_enabled && !demoProcessId ? 1 : 0, allowed: membershipActive || (Boolean(row?.demo_enabled) && (!demoProcessId || sameProcess)) };
}
export async function getDemoAccess(organizationId, processId = null) { return accessPayload(await readAccess({ query }, organizationId), processId); }
export class DemoMembershipRequiredError extends Error { constructor(message = DEMO_REQUIRED_MESSAGE) { super(message); this.statusCode = 402; this.code = "DEMO_MEMBERSHIP_REQUIRED"; } }
export async function requireDemoProcessAccess(organizationId, processId) {
  return withTenantTransaction(organizationId, async (client) => {
    const current = accessPayload(await readAccess(client, organizationId), processId);
    if (current.membership_active || current.demo_process_id === String(processId)) return { ...current, demo_process_id: current.demo_process_id ?? String(processId) };
    if (!current.demo_enabled || current.demo_used) throw new DemoMembershipRequiredError();
    const claimed = await client.query(`UPDATE saas.organizations SET demo_postulation_process_id = $2, demo_postulation_started_at = COALESCE(demo_postulation_started_at, NOW()), updated_at = NOW() WHERE id = $1 AND demo_enabled = TRUE AND demo_postulation_process_id IS NULL RETURNING demo_postulation_process_id, demo_postulation_started_at`, [organizationId, processId]);
    if (!claimed.rowCount) throw new DemoMembershipRequiredError();
    return { ...current, demo_used: true, demo_remaining: 0, demo_process_id: claimed.rows[0].demo_postulation_process_id, allowed: true };
  });
}
export function demoMembershipRequiredMessage() { return DEMO_REQUIRED_MESSAGE; }
