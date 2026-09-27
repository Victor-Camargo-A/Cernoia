import { query } from "./db.js";

export async function writeAudit({ userId = null, organizationId = null, action, entityType = null, entityId = null, metadata = {}, req = null }) {
  try {
    await query(
      `INSERT INTO saas.app_audit_log
        (user_id, organization_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        userId,
        organizationId,
        action,
        entityType,
        entityId,
        req?.ip ?? null,
        req?.get?.("user-agent") ?? null,
        JSON.stringify(metadata),
      ],
    );
  } catch (error) {
    console.error("No se pudo escribir auditoría:", error.message);
  }
}
