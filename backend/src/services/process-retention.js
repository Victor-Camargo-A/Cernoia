import { pool } from "../db.js";

const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';

// Se conservan todas las referencias de negocio, incluso una coincidencia automática.
export async function pruneOldProcesses({ dryRun = true, retentionDays = 180, batchSize = 100 } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 90 || retentionDays > 3650) throw new Error("Retención fuera del rango permitido.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("Lote fuera del rango permitido.");
  const client = await pool.connect();
  let runId;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('cernoia_process_retention')) AS acquired");
    if (!lock.rows[0].acquired) { await client.query("ROLLBACK"); return { skipped: true, reason: "already_running" }; }
    const references = await client.query(`SELECT ns.nspname AS schema_name, rel.relname AS table_name, attr.attname AS column_name
      FROM pg_constraint fk JOIN pg_class rel ON rel.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      JOIN pg_attribute attr ON attr.attrelid=fk.conrelid AND attr.attnum=fk.conkey[1]
      WHERE fk.contype='f' AND fk.confrelid='secop.processes'::regclass AND ns.nspname NOT IN ('secop','ops')`);
    if (!references.rows.some(row => row.table_name === "process_matches") || !references.rows.some(row => row.table_name === "app_opportunity_states")) throw new Error("No se pudo verificar la protección del historial empresarial.");
    const guards = references.rows.map(row => `NOT EXISTS (SELECT 1 FROM ${identifier(row.schema_name)}.${identifier(row.table_name)} protected WHERE protected.${identifier(row.column_name)}=p.id)`);
    const age = `COALESCE(p.response_deadline,p.publication_date) < NOW() - ($1::int * INTERVAL '1 day')
      AND (COALESCE(p.awarded,FALSE) OR p.response_deadline < NOW() OR lower(COALESCE(p.process_status,'')) ~ '(cancelad|adjudicad|terminad|cerrad)')`;
    const safe = guards.join(" AND ");
    const counts = (await client.query(`SELECT COUNT(*)::int AS old_closed,
      COUNT(*) FILTER (WHERE ${safe})::int AS candidates FROM secop.processes p WHERE ${age}`, [retentionDays])).rows[0];
    const result = { dry_run: dryRun, retention_days: retentionDays, candidates: counts.candidates, protected: counts.old_closed - counts.candidates, deleted: 0 };
    if (!dryRun) {
      const run = await client.query("INSERT INTO ops.process_retention_runs(retention_days,candidate_count,protected_count) VALUES($1,$2,$3) RETURNING id", [retentionDays,result.candidates,result.protected]);runId=run.rows[0].id;
      // El bloqueo del padre evita que una referencia concurrente se inserte durante su eliminación.
      const removed = await client.query(`WITH candidates AS (
        SELECT p.id FROM secop.processes p WHERE ${age} AND ${safe}
        ORDER BY COALESCE(p.response_deadline,p.publication_date),p.id LIMIT $2 FOR UPDATE OF p SKIP LOCKED
      ) DELETE FROM secop.processes p USING candidates c WHERE p.id=c.id RETURNING p.id`, [retentionDays,batchSize]);
      result.deleted=removed.rowCount;
      await client.query("UPDATE ops.process_retention_runs SET deleted_count=$2,status='success',finished_at=NOW() WHERE id=$1", [runId,result.deleted]);
    }
    await client.query("COMMIT");
    return result;
  } catch(error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
