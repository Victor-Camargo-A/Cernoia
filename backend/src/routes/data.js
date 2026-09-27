import {refreshProcessScores} from '../services/effective-capabilities.js';
import {findReference} from '../services/opportunity-reference.js';
import rateLimit from 'express-rate-limit';
import {listOpportunitySourceDocuments} from '../services/opportunity-source-documents.js';
import { Router } from "express";
import { withProcessSchedule } from "../services/process-schedule.js";
import { opportunityQuery as query, latestMatchesCte } from "../services/opportunity-query.js";
import { documentReadiness } from "../services/document-readiness.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const dataRouter = Router();
dataRouter.use(requireAuth);

const OPPORTUNITY_STAGES = new Set(["watching", "reviewing", "preparing", "submitted", "dismissed"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function boundedScore(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : fallback;
}

function requireProcessId(req, res) {
  if (!UUID_PATTERN.test(String(req.params.processId ?? ""))) {
    res.status(400).json({ error: "El identificador de la oportunidad no es válido." });
    return false;
  }
  return true;
}


const opportunitySelect = `
  SELECT lm.id, lm.process_id, lm.search_profile_id, lm.match_score, lm.match_status,
         lm.matched_reasons, lm.first_matched_at, lm.last_matched_at, lm.viewed_at,
         p.secop_process_id, p.reference, p.entity_name, p.entity_nit, p.department, p.city,
         p.process_name, p.description, p.procurement_method, p.contract_type, p.base_price,
         p.publication_date, p.response_deadline, p.process_status, p.awarded,
         p.phase, p.summary_status,
         jsonb_build_object('fecha_de_recepcion_de',p.raw_json->'fecha_de_recepcion_de',
           'fecha_de_apertura_de_respuesta',p.raw_json->'fecha_de_apertura_de_respuesta',
           'fecha_de_apertura_efectiva',p.raw_json->'fecha_de_apertura_efectiva',
           'fecha_adjudicacion',p.raw_json->'fecha_adjudicacion',
           'urlproceso',p.raw_json->'urlproceso') AS schedule_source,
         p.main_category_code, p.process_url, p.source_updated_at,
         lm.matched_reasons -> 'compatibility' AS compatibility,
         ai.compatibility_score AS ai_compatibility_score, ai.decision AS ai_decision,
         COALESCE(os.stage, 'watching') AS stage,
         COALESCE(os.is_favorite, FALSE) AS is_favorite,
         os.notes, os.updated_at AS state_updated_at
  FROM latest_matches lm
  JOIN secop.processes p ON p.id = lm.process_id
  LEFT JOIN saas.app_opportunity_states os
    ON os.organization_id = lm.organization_id AND os.process_id = lm.process_id
  LEFT JOIN LATERAL (
    SELECT compatibility_score, decision FROM saas.opportunity_ai_analyses a
    WHERE a.organization_id=lm.organization_id AND a.process_id=lm.process_id AND a.analysis_status='success'
    ORDER BY a.finished_at DESC NULLS LAST LIMIT 1
  ) ai ON TRUE`;

dataRouter.get("/dashboard/summary", async (req, res, next) => {
  try {
    const organizationId = req.user.organization_id;
    const [summaryResult, recentResult, departmentsResult, documentResult, catalogResult] = await Promise.all([
      query(
        `${latestMatchesCte}
         SELECT COUNT(*)::INTEGER AS total_matches,
                COUNT(*) FILTER (WHERE lm.match_status = 'new')::INTEGER AS new_matches,
                COUNT(*) FILTER (
                  WHERE (NOT secop.deadline_passed(p.response_deadline,p.raw_json->>'fecha_de_recepcion_de'))
                    AND COALESCE(os.stage, 'watching') <> 'dismissed'
                    AND NOT COALESCE(p.awarded,FALSE)
                    AND saas.match_text(concat_ws(' ',p.process_status,p.summary_status)) !~ '(evaluaci|seleccionad|adjudicad|cancelad|terminad|cerrad|desiert|liquidad)'
                )::INTEGER AS open_matches,
                COALESCE(ROUND(AVG(lm.match_score)::NUMERIC, 1), 0) AS average_score,
                COALESCE(SUM(p.base_price) FILTER (
                  WHERE (NOT secop.deadline_passed(p.response_deadline,p.raw_json->>'fecha_de_recepcion_de'))
                    AND COALESCE(os.stage, 'watching') <> 'dismissed'
                    AND NOT COALESCE(p.awarded,FALSE)
                    AND saas.match_text(concat_ws(' ',p.process_status,p.summary_status)) !~ '(evaluaci|seleccionad|adjudicad|cancelad|terminad|cerrad|desiert|liquidad)'
                ), 0) AS open_value,
                COUNT(*) FILTER (
                  WHERE p.response_deadline IS NOT NULL AND NOT secop.deadline_passed(p.response_deadline,p.raw_json->>'fecha_de_recepcion_de')
                    AND p.response_deadline < NOW() + INTERVAL '7 days'
                    AND COALESCE(os.stage, 'watching') <> 'dismissed'
                    AND NOT COALESCE(p.awarded,FALSE)
                    AND saas.match_text(concat_ws(' ',p.process_status,p.summary_status)) !~ '(evaluaci|seleccionad|adjudicad|cancelad|terminad|cerrad|desiert|liquidad)'
                )::INTEGER AS closing_soon,
                COUNT(*) FILTER (WHERE COALESCE(os.is_favorite, FALSE))::INTEGER AS favorites
         FROM latest_matches lm
         JOIN secop.processes p ON p.id = lm.process_id
         LEFT JOIN saas.app_opportunity_states os
           ON os.organization_id = lm.organization_id AND os.process_id = lm.process_id`,
        [organizationId],
      ),
      query(
        `${latestMatchesCte}
         ${opportunitySelect}
         ORDER BY lm.last_matched_at DESC NULLS LAST, lm.match_score DESC NULLS LAST
         LIMIT 6`,
        [organizationId],
      ),
      query(
        `${latestMatchesCte}
         SELECT COALESCE(NULLIF(TRIM(p.department), ''), 'Sin departamento') AS department,
                COUNT(*)::INTEGER AS total
         FROM latest_matches lm
         JOIN secop.processes p ON p.id = lm.process_id
         GROUP BY 1
         ORDER BY total DESC, department ASC
         LIMIT 8`,
        [organizationId],
      ),
      query(
        `SELECT COUNT(*)::INTEGER AS total,
                COUNT(*) FILTER (WHERE expiration_date < CURRENT_DATE)::INTEGER AS expired,
                COUNT(*) FILTER (
                  WHERE expiration_date >= CURRENT_DATE
                    AND expiration_date <= CURRENT_DATE + COALESCE(alert_days_before, 30)
                )::INTEGER AS expiring
         FROM saas.organization_documents
         WHERE organization_id = $1 AND document_status <> 'deleted'`,
        [organizationId],
      ),
      query(`SELECT COUNT(*)::INTEGER AS total_processes, TO_CHAR(MAX(source_updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS source_updated_through FROM secop.processes`),
    ]);

    res.json({
      summary: { ...summaryResult.rows[0], ...catalogResult.rows[0] },
      recent: recentResult.rows.map(withProcessSchedule),
      departments: departmentsResult.rows,
      documents: documentResult.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

dataRouter.get("/market/sync-status", async (_req, res, next) => {
  try {
    const result = await query(`SELECT TO_CHAR(GREATEST(cursor_timestamp, NULLIF(metadata->>'source_high_watermark','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS source_updated_through, last_success_at AS last_sync_at,
      status, active_execution_id IS NOT NULL AS running FROM ops.sync_cursors WHERE source_code='SECOP_II_PROCESSES'`);
    const catalog = await query("SELECT COUNT(*)::INTEGER AS total_processes FROM secop.processes");
    res.json({ ...(result.rows[0] ?? { status: "unknown" }), ...catalog.rows[0] });
  } catch (error) { next(error); }
});

dataRouter.get("/opportunities", async (req, res, next) => {
  try {
    const page = boundedInteger(req.query.page, 1, 1, 100000);
    const limit = boundedInteger(req.query.limit, 20, 1, 100);
    const offset = (page - 1) * limit;
    const q = String(req.query.q ?? "").trim().slice(0, 160);
    const department = String(req.query.department ?? "").trim().slice(0, 100);
    const stage = String(req.query.stage ?? "").trim().toLowerCase();
    const matchStatus = String(req.query.status ?? "").trim().toLowerCase();
    const favorite = String(req.query.favorite ?? "").toLowerCase();
    const preference = await query("SELECT minimum_match_score FROM saas.app_organization_settings WHERE organization_id=$1", [req.user.organization_id]);
    const configuredMinimum = Number(preference.rows[0]?.minimum_match_score ?? 60);
    const minimumScore = req.query.minScore === undefined ? configuredMinimum : boundedScore(req.query.minScore, configuredMinimum);
    const values = [req.user.organization_id];
    const predicates = ["lm.match_score >= $2"];
    if (req.query.includeClosed !== "true") predicates.push("(lm.match_status <> 'archived' OR COALESCE(os.stage, 'watching') IN ('reviewing','preparing','submitted') OR COALESCE(os.is_favorite,FALSE))");
    if (req.query.includeClosed !== "true") predicates.push("(COALESCE(os.stage, 'watching') IN ('reviewing','preparing','submitted') OR COALESCE(os.is_favorite,FALSE) OR (COALESCE(p.awarded,FALSE)=FALSE AND (NOT secop.deadline_passed(p.response_deadline,p.raw_json->>'fecha_de_recepcion_de')) AND lower(COALESCE(p.process_status,'')) !~ '(cancelad|adjudicad|terminad|cerrad)'))");
    values.push(minimumScore);

    if (q) {
      values.push(`%${q}%`);
      predicates.push(`(
        p.process_name ILIKE $${values.length}
        OR p.description ILIKE $${values.length}
        OR p.entity_name ILIKE $${values.length}
        OR p.reference ILIKE $${values.length}
        OR p.secop_process_id ILIKE $${values.length}
      )`);
    }
    if (department && department !== "all") {
      values.push(department);
      predicates.push(`p.department = $${values.length}`);
    }
    if (stage && stage !== "all" && OPPORTUNITY_STAGES.has(stage)) {
      values.push(stage);
      predicates.push(`COALESCE(os.stage, 'watching') = $${values.length}`);
    }
    if (matchStatus && matchStatus !== "all") {
      values.push(matchStatus);
      predicates.push(`lm.match_status = $${values.length}`);
    }
    if (favorite === "true") predicates.push("COALESCE(os.is_favorite, FALSE) = TRUE");

    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    values.push(limit, offset);
    const limitParameter = `$${values.length - 1}`;
    const offsetParameter = `$${values.length}`;

    const result = await query(
      `${latestMatchesCte}, filtered AS (
         ${opportunitySelect}
         ${where}
       )
       SELECT filtered.*, COUNT(*) OVER()::INTEGER AS total_count
       FROM filtered
       ORDER BY is_favorite DESC, match_score DESC NULLS LAST, response_deadline ASC NULLS LAST, process_id ASC
       LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      values,
    );

    const total = result.rows[0]?.total_count ?? 0;
    res.json({
      items: result.rows.map((row) => {
        const item = { ...row };
        delete item.total_count;
        return withProcessSchedule(item);
      }),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      total,
      minimum_match_score: configuredMinimum,
      applied_minimum_score: minimumScore,
    });
  } catch (error) {
    next(error);
  }
});

const referenceLimiter=rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false});
const linkedMatchesCte=`WITH latest_matches AS (SELECT DISTINCT ON(pm.process_id) pm.* FROM saas.process_matches pm WHERE pm.organization_id=$1 ORDER BY pm.process_id,pm.match_score DESC NULLS LAST,pm.last_matched_at DESC NULLS LAST)`;
dataRouter.post('/opportunities/lookup',referenceLimiter,async(req,res,next)=>{try{
 const ids=await findReference(req.user.organization_id,req.body?.reference);
 const result=ids.length?await query(`${linkedMatchesCte} ${opportunitySelect} WHERE lm.process_id=ANY($2::uuid[])`,[req.user.organization_id,ids]):{rows:[]};
 const preferences=await query('SELECT minimum_match_score FROM saas.app_organization_settings WHERE organization_id=$1',[req.user.organization_id]);
 res.json({items:result.rows.map(withProcessSchedule),pagination:{total:result.rows.length,pages:1},minimum_match_score:Number(preferences.rows[0]?.minimum_match_score??0),reference_lookup:true,lookup_message:'Búsqueda exacta en el catálogo y la fuente oficial, sin aplicar filtros de modalidad, estado o afinidad. El estado y las fechas de datos abiertos pueden estar pendientes de actualización; verifica el portal de SECOP.'});
}catch(e){next(e);}});

dataRouter.get("/opportunities/:processId", async (req, res, next) => {
  if (!requireProcessId(req, res)) return;
  try {
    await refreshProcessScores(req.user.organization_id,[req.params.processId]);
    const result = await query(
      `${linkedMatchesCte}
       ${opportunitySelect}
       WHERE lm.process_id = $2
       LIMIT 1`,
      [req.user.organization_id, req.params.processId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Oportunidad no encontrada." });

    const [analysisResult, countResult, readiness] = await Promise.all([
      query(
        `SELECT id, analysis_status, priority, compatibility_score, confidence_score, decision,
                executive_summary, analysis_result, review_status, human_decision, human_notes,
                started_at, queued_at, finished_at, updated_at,
                analysis_result->>'quota_deferred_at' AS quota_deferred_at,
                saas.analysis_matrix_metadata(capability_snapshot,organization_id) AS company_matrix,
                capability_snapshot->'company_matrix'->'facts' AS company_matrix_facts
         FROM saas.opportunity_ai_analyses
         WHERE organization_id = $1 AND process_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [req.user.organization_id, req.params.processId],
      ),
      query(
        `SELECT
           (SELECT COUNT(*) FROM saas.opportunity_requirements
            WHERE organization_id = $1 AND process_id = $2)::INTEGER AS requirements,
           (SELECT COUNT(*) FROM secop.process_documents WHERE process_id = $2)::INTEGER AS source_documents,
           EXISTS(SELECT 1 FROM saas.opportunity_ai_analyses WHERE organization_id=$1 AND process_id=$2 AND analysis_status='success') AS has_successful_analysis`,
        [req.user.organization_id, req.params.processId],
      ),
      documentReadiness(req.user.organization_id),
    ]);

    res.json({ opportunity: withProcessSchedule(result.rows[0]), analysis: analysisResult.rows[0] ?? null, counts: countResult.rows[0], has_successful_analysis: countResult.rows[0].has_successful_analysis, document_readiness: readiness });
  } catch (error) {
    next(error);
  }
});

dataRouter.get("/opportunities/:processId/requirements", async (req, res, next) => {
  if (!requireProcessId(req, res)) return;
  try {
    const relation = await query("SELECT to_regclass('saas.opportunity_requirement_documents') AS name");
    const hasDocumentMatches = Boolean(relation.rows[0]?.name);
    const documentJoin = hasDocumentMatches
      ? `LEFT JOIN LATERAL (
           SELECT rd.organization_document_id, rd.match_status AS document_match_status,
                  rd.match_score AS document_match_score, rd.match_reason AS document_match_reason,
                  od.document_name AS organization_document_name,
                  od.expiration_date AS organization_document_expiry
           FROM saas.opportunity_requirement_documents rd
           JOIN saas.organization_documents od
             ON od.id = rd.organization_document_id
            AND od.organization_id = r.organization_id
            AND od.document_status <> 'deleted'
           WHERE rd.opportunity_requirement_id = r.id
           ORDER BY rd.match_score DESC NULLS LAST, rd.updated_at DESC
           LIMIT 1
         ) dm ON TRUE`
      : "";
    const documentFields = hasDocumentMatches
      ? `dm.organization_document_id, dm.organization_document_name,
         dm.document_match_status, dm.document_match_score, dm.document_match_reason,
         dm.organization_document_expiry`
      : `NULL::UUID AS organization_document_id, NULL::TEXT AS organization_document_name,
         NULL::TEXT AS document_match_status, NULL::NUMERIC AS document_match_score,
         NULL::TEXT AS document_match_reason, NULL::DATE AS organization_document_expiry`;

    const result = await query(
      `SELECT r.id, r.requirement_code,
              COALESCE(r.requirement_category, r.category, 'general') AS requirement_category,
              r.requirement_name, r.normalized_document_type, r.requirement_description,
              r.mandatory, r.condition_text, r.maximum_age_days, r.requires_signature,
              r.requires_entity_template, r.requires_original, r.requires_notarization,
              r.requires_translation, r.applies_to, r.source_page, r.source_section,
              r.evidence_text, r.confidence_score,
              COALESCE(r.status, r.requirement_status, 'pending') AS status,
              r.risk_level, r.due_at, r.requirement_stage, r.is_bid_requirement,
              r.source_document_name AS document_name, ${documentFields}
       FROM saas.opportunity_requirements r
       ${documentJoin}
       WHERE r.organization_id = $1 AND r.process_id = $2 AND r.status<>'superseded'
       ORDER BY r.mandatory DESC, r.risk_level DESC NULLS LAST, r.created_at ASC`,
      [req.user.organization_id, req.params.processId],
    );
    res.json({ items: result.rows, document_matching_available: hasDocumentMatches });
  } catch (error) {
    next(error);
  }
});

dataRouter.get("/opportunities/:processId/documents", async (req, res, next) => {
  if (!requireProcessId(req, res)) return;
  try {
    res.json({items:await listOpportunitySourceDocuments(req.user.organization_id,req.params.processId)});
  } catch (error) {
    next(error);
  }
});

dataRouter.patch(
  "/opportunities/:processId/state",
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    if (!requireProcessId(req, res)) return;
    try {
      const stage = String(req.body?.stage ?? "watching").toLowerCase();
      const notes = req.body?.notes == null ? null : String(req.body.notes).trim();
      const isFavorite = Boolean(req.body?.is_favorite);
      if (!OPPORTUNITY_STAGES.has(stage)) return res.status(400).json({ error: "Etapa de oportunidad no válida." });
      if (notes && notes.length > 4000) return res.status(400).json({ error: "Las notas no pueden superar 4.000 caracteres." });

      const match = await query(
        `SELECT 1 FROM saas.process_matches
         WHERE organization_id = $1 AND process_id = $2
         LIMIT 1`,
        [req.user.organization_id, req.params.processId],
      );
      if (!match.rowCount) return res.status(404).json({ error: "Oportunidad no encontrada." });

      const result = await query(
        `INSERT INTO saas.app_opportunity_states
           (organization_id, process_id, stage, is_favorite, notes, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, process_id) DO UPDATE SET
           stage = EXCLUDED.stage,
           is_favorite = EXCLUDED.is_favorite,
           notes = EXCLUDED.notes,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = NOW()
         RETURNING process_id, stage, is_favorite, notes, updated_at`,
        [req.user.organization_id, req.params.processId, stage, isFavorite, notes, req.user.id],
      );
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "opportunity.state_updated",
        entityType: "process",
        entityId: req.params.processId,
        metadata: { stage, is_favorite: isFavorite },
        req,
      });
      res.json({ state: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

dataRouter.get("/documents", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, document_type, document_name, original_filename, description, storage_url,
              ai_classification->>'document_type_label' AS document_type_label,
              ai_classification->>'metadata_status' AS metadata_status,
              ai_classification->>'expiration_source' AS expiration_source,
              ai_classification->'metadata_issues' AS metadata_issues,
              mime_type, file_size_bytes, issue_date, expiration_date AS expiry_date,
              document_status AS status, verification_status, extraction_status,
              review_status, extraction_confidence, ocr_status, ocr_provider,
              malware_scan_status, encryption_version,
              policy_validity_days, alert_days_before, renewal_status, created_at, updated_at,
              CASE
                WHEN expiration_date IS NULL THEN 'unknown'
                WHEN expiration_date < CURRENT_DATE THEN 'expired'
                WHEN expiration_date <= CURRENT_DATE + COALESCE(alert_days_before, 30) THEN 'expiring'
                ELSE 'valid'
              END AS validity_status
       FROM saas.organization_documents
       WHERE organization_id = $1 AND document_status <> 'deleted'
       ORDER BY
         CASE
           WHEN expiration_date IS NULL THEN 3
           WHEN expiration_date < CURRENT_DATE THEN 0
           WHEN expiration_date <= CURRENT_DATE + COALESCE(alert_days_before, 30) THEN 1
           ELSE 2
         END,
         expiration_date ASC NULLS LAST, created_at DESC`,
      [req.user.organization_id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

dataRouter.get("/alerts", async (req, res, next) => {
  try {
    const [opportunities, documents, documentAlerts, digest] = await Promise.all([
      query(
        `${latestMatchesCte}
         ${opportunitySelect}
         WHERE p.response_deadline IS NOT NULL AND NOT secop.deadline_passed(p.response_deadline,p.raw_json->>'fecha_de_recepcion_de')
           AND p.response_deadline <= NOW() + INTERVAL '30 days'
           AND COALESCE(os.stage, 'watching') <> 'dismissed'
                    AND NOT COALESCE(p.awarded,FALSE)
                    AND saas.match_text(concat_ws(' ',p.process_status,p.summary_status)) !~ '(evaluaci|seleccionad|adjudicad|cancelad|terminad|cerrad|desiert|liquidad)'
         ORDER BY p.response_deadline ASC
         LIMIT 50`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id, document_name, document_type, expiration_date AS expiry_date,
                CASE WHEN expiration_date < CURRENT_DATE THEN 'expired' ELSE 'expiring' END AS validity_status
         FROM saas.organization_documents
         WHERE organization_id = $1 AND document_status <> 'deleted'
           AND expiration_date IS NOT NULL
           AND expiration_date <= CURRENT_DATE + COALESCE(alert_days_before, 30)
         ORDER BY expiration_date ASC
         LIMIT 50`,
        [req.user.organization_id],
      ),
      query(
        `SELECT alert.id, alert.organization_document_id, alert.alert_type, alert.severity,
                alert.status, alert.title, alert.message, alert.due_date,
                alert.first_triggered_at, alert.last_triggered_at, alert.read_at,
                document.document_name, document.document_type,
                document.issue_date, document.expiration_date AS expiry_date
         FROM saas.document_alerts alert
         JOIN saas.organization_documents document
           ON document.id = alert.organization_document_id
          AND document.organization_id = alert.organization_id
         WHERE alert.organization_id = $1
           AND alert.status IN ('open', 'read')
           AND document.document_status <> 'deleted'
         ORDER BY
           CASE alert.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           alert.due_date ASC NULLS LAST, alert.last_triggered_at DESC
         LIMIT 100`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id, digest_date, status, headline, summary_text,
                recommended_actions, source_snapshot, model_provider, model_name, generated_at
         FROM saas.alert_digests
         WHERE organization_id = $1
         ORDER BY digest_date DESC, generated_at DESC
         LIMIT 1`,
        [req.user.organization_id],
      ),
    ]);
    res.json({
      opportunities: opportunities.rows.map(withProcessSchedule),
      documents: documents.rows,
      document_alerts: documentAlerts.rows,
      digest: digest.rows[0] ?? null,
    });
  } catch (error) {
    next(error);
  }
});

dataRouter.patch(
  "/alerts/:alertId/read",
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    try {
      if (!UUID_PATTERN.test(String(req.params.alertId ?? ""))) {
        return res.status(400).json({ error: "El identificador de la alerta no es válido." });
      }
      const result = await query(
        `UPDATE saas.document_alerts
         SET status = 'read', read_at = COALESCE(read_at, NOW()), updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND status = 'open'
         RETURNING id, status, read_at, updated_at`,
        [req.params.alertId, req.user.organization_id],
      );
      if (!result.rowCount) return res.status(404).json({ error: "La alerta no está disponible." });
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "document_alert.read",
        entityType: "document_alert",
        entityId: req.params.alertId,
        req,
      });
      res.json({ alert: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

dataRouter.patch(
  "/alerts/:alertId/dismiss",
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    try {
      if (!UUID_PATTERN.test(String(req.params.alertId ?? ""))) {
        return res.status(400).json({ error: "El identificador de la alerta no es válido." });
      }
      const result = await query(
        `UPDATE saas.document_alerts
         SET status = 'dismissed', read_at = COALESCE(read_at, NOW()), updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND status IN ('open', 'read')
         RETURNING id, status, read_at, updated_at`,
        [req.params.alertId, req.user.organization_id],
      );
      if (!result.rowCount) return res.status(404).json({ error: "La alerta no está disponible." });
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "document_alert.dismissed",
        entityType: "document_alert",
        entityId: req.params.alertId,
        req,
      });
      res.json({ alert: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

dataRouter.get("/workflow-runs", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, workflow_code, source_code, n8n_execution_id, trigger_type, status,
              started_at, finished_at, batches_processed, records_read, records_written,
              completion_reason, error_message, created_at
       FROM ops.workflow_runs
       WHERE metadata ->> 'organization_id' = $1::TEXT
       ORDER BY started_at DESC NULLS LAST, created_at DESC
       LIMIT 100`,
      [req.user.organization_id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

dataRouter.get("/filters", async (req, res, next) => {
  try {
    const result = await query(
      `${latestMatchesCte}
       SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(TRIM(p.department), '') ORDER BY NULLIF(TRIM(p.department), '')), NULL) AS departments,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(TRIM(p.procurement_method), '') ORDER BY NULLIF(TRIM(p.procurement_method), '')), NULL) AS procurement_methods
       FROM latest_matches lm
       JOIN secop.processes p ON p.id = lm.process_id`,
      [req.user.organization_id],
    );
    res.json({ departments: result.rows[0]?.departments ?? [], procurement_methods: result.rows[0]?.procurement_methods ?? [] });
  } catch (error) {
    next(error);
  }
});
