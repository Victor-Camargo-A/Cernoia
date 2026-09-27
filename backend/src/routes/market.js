import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/subscription.js";

export const marketRouter = Router();
marketRouter.use(requireAuth, requireEntitlement("heatmap"));

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function marketPeriod(req, res) {
  const today = new Date();
  const defaultFrom = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
  const from = String(req.query.from ?? defaultFrom.toISOString().slice(0, 10));
  const to = String(req.query.to ?? today.toISOString().slice(0, 10));
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to) || new Date(from) > new Date(to)) {
    res.status(400).json({ error: "El rango de fechas no es válido." });
    return null;
  }
  const maximumRange = 365 * 6 * 24 * 60 * 60 * 1000;
  if (new Date(to).getTime() - new Date(from).getTime() > maximumRange) {
    res.status(400).json({ error: "El mapa permite consultar hasta seis años por vez." });
    return null;
  }
  return { from, to };
}

const amountExpression = "COALESCE(NULLIF(process.base_price, 0), NULLIF(process.total_awarded_value, 0), 0)";

// SECOP publica variantes como "Bogotá D.C.", "Bogota" o espacios dobles.
// Normalizamos para agrupar sin perder el nombre original mostrado al usuario.
function normalizedSql(column) {
  return `LOWER(TRIM(REGEXP_REPLACE(TRANSLATE(COALESCE(${column}, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'), '\\s+', ' ', 'g')))`;
}

const departmentKey = normalizedSql("process.department");
const cityKey = normalizedSql("process.city");
const payerKey = normalizedSql("process.entity_name");

marketRouter.get("/market/heatmap", async (req, res, next) => {
  const period = marketPeriod(req, res);
  if (!period) return;
  try {
    const [national, departments, trend, topPayers] = await Promise.all([
      query(
        `SELECT COUNT(*)::INTEGER AS processes,
                COALESCE(SUM(${amountExpression}), 0) AS amount_cop,
                COUNT(DISTINCT NULLIF(TRIM(process.entity_nit), ''))::INTEGER AS payers,
                COUNT(DISTINCT NULLIF(${departmentKey}, ''))::INTEGER AS departments
         FROM secop.processes process
         WHERE process.publication_date >= $1::DATE
           AND process.publication_date < $2::DATE + INTERVAL '1 day'`,
        [period.from, period.to],
      ),
      query(
        `SELECT COALESCE(MIN(NULLIF(TRIM(process.department), '')), 'Sin departamento') AS name,
                COUNT(*)::INTEGER AS processes,
                COALESCE(SUM(${amountExpression}), 0) AS amount_cop,
                COUNT(DISTINCT NULLIF(${cityKey}, ''))::INTEGER AS cities,
                COUNT(DISTINCT NULLIF(TRIM(process.entity_nit), ''))::INTEGER AS payers
         FROM secop.processes process
         WHERE process.publication_date >= $1::DATE
           AND process.publication_date < $2::DATE + INTERVAL '1 day'
         GROUP BY ${departmentKey}
         ORDER BY amount_cop DESC, processes DESC`,
        [period.from, period.to],
      ),
      query(
        `SELECT TO_CHAR(DATE_TRUNC('month', process.publication_date), 'YYYY-MM') AS month,
                COUNT(*)::INTEGER AS processes,
                COALESCE(SUM(${amountExpression}), 0) AS amount_cop
         FROM secop.processes process
         WHERE process.publication_date >= $1::DATE
           AND process.publication_date < $2::DATE + INTERVAL '1 day'
         GROUP BY DATE_TRUNC('month', process.publication_date)
         ORDER BY DATE_TRUNC('month', process.publication_date)`,
        [period.from, period.to],
      ),
      query(
        `SELECT COALESCE(NULLIF(TRIM(process.entity_name), ''), 'Pagaduría sin nombre') AS name,
                NULLIF(TRIM(process.entity_nit), '') AS nit,
                COUNT(*)::INTEGER AS processes,
                COALESCE(SUM(${amountExpression}), 0) AS amount_cop
         FROM secop.processes process
         WHERE process.publication_date >= $1::DATE
           AND process.publication_date < $2::DATE + INTERVAL '1 day'
         GROUP BY 1, 2
         ORDER BY amount_cop DESC, processes DESC
         LIMIT 12`,
        [period.from, period.to],
      ),
    ]);
    res.json({
      period,
      national: national.rows[0],
      departments: departments.rows,
      trend: trend.rows,
      top_payers: topPayers.rows,
      metric_definition: "Suma del presupuesto base reportado; si no existe, usa el valor adjudicado reportado.",
    });
  } catch (error) {
    next(error);
  }
});

marketRouter.get("/market/drilldown", async (req, res, next) => {
  const period = marketPeriod(req, res);
  if (!period) return;
  try {
    const department = String(req.query.department ?? "").trim().slice(0, 120);
    const city = String(req.query.city ?? "").trim().slice(0, 120);
    if (!department) return res.status(400).json({ error: "Selecciona un departamento." });
    const values = [period.from, period.to, department];
    let locationPredicate = `${departmentKey} = ${normalizedSql("$3")}`;
    if (city) {
      values.push(city);
      locationPredicate += ` AND ${cityKey} = ${normalizedSql("$4")}`;
    }
    const groupField = city
      ? "COALESCE(MIN(NULLIF(TRIM(process.entity_name), '')), 'Pagaduría sin nombre')"
      : "COALESCE(MIN(NULLIF(TRIM(process.city), '')), 'Municipio sin informar')";
    const groupKey = city ? payerKey : cityKey;
    const result = await query(
      `SELECT ${groupField} AS name,
              ${city ? "NULLIF(TRIM(process.entity_nit), '') AS nit," : ""}
              COUNT(*)::INTEGER AS processes,
              COALESCE(SUM(${amountExpression}), 0) AS amount_cop,
              COUNT(DISTINCT NULLIF(TRIM(process.entity_nit), ''))::INTEGER AS payers,
              MAX(process.publication_date) AS latest_publication
       FROM secop.processes process
       WHERE process.publication_date >= $1::DATE
         AND process.publication_date < $2::DATE + INTERVAL '1 day'
         AND ${locationPredicate}
       GROUP BY ${groupKey} ${city ? ", 2" : ""}
       ORDER BY amount_cop DESC, processes DESC
       LIMIT 500`,
      values,
    );
    res.json({
      period,
      level: city ? "payer" : "city",
      parent: { department, city: city || null },
      items: result.rows,
    });
  } catch (error) {
    next(error);
  }
});
