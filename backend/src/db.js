import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "cernoia-api",
});

// Authentication retains capacity even when dashboard/report queries are busy.
export const authPool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000, application_name: "cernoia-auth",
});
authPool.on("error", error => console.error("Error de conexión de autenticación:", error.message));

const tenantStorage = new AsyncLocalStorage();

export function runWithTenantContext(organizationId, callback) {
  return tenantStorage.run({ organizationId: String(organizationId) }, callback);
}

export function currentTenantId() {
  return tenantStorage.getStore()?.organizationId ?? null;
}

pool.on("error", (error) => {
  console.error("Error inesperado en PostgreSQL:", error.message);
});

export function query(text, values = []) { return executeQuery(pool, text, values); }
export function authQuery(text, values = []) { return executeQuery(authPool, text, values); }
export function boundedQuery(text, values = []) { return executeQuery(pool, text, values, 15000); }

function executeQuery(selectedPool, text, values = [], timeoutMs = 0) {
  const organizationId = currentTenantId();
  if (!organizationId && !timeoutMs) return selectedPool.query(text, values);

  return (async () => {
    const client = await selectedPool.connect();
    try {
      await client.query("BEGIN");
      if (organizationId) await client.query("SELECT set_config('app.organization_id', $1, TRUE)", [organizationId]);
      if (timeoutMs) await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [String(timeoutMs)]);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  })();
}

export async function withTenantTransaction(organizationId, callback) {
  if (!/^[0-9a-f-]{36}$/i.test(String(organizationId ?? ""))) {
    throw new Error("La organización requerida para la transacción no es válida.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, TRUE)", [organizationId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
