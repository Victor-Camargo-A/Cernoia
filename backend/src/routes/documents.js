import { Router, raw } from "express";
import { config } from "../config.js";
import { query } from "../db.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { runWorkflow } from "../services/n8n.js";
import { processOrganizationDocument } from "../services/document-processing.js";
import { scanForMalware } from "../services/malware-scanner.js";
import {
  fileSha256,
  removeStoredDocument,
  storeDocument,
  streamStoredDocument,
  validateUploadedFile,
} from "../services/document-storage.js";
import { safeEqual } from "../security.js";

export const documentsRouter = Router();

const DOCUMENT_TYPE_PATTERN = /^[a-z0-9_]{2,80}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_DEFAULTS = Object.freeze({
  chamber_of_commerce: { validityDays: 45, alertDays: 5 },
  fiscal_background: { validityDays: 30, alertDays: 5 },
  disciplinary_background: { validityDays: 30, alertDays: 5 },
  police_background: { validityDays: 30, alertDays: 5 },
  judicial_measures: { validityDays: 30, alertDays: 5 },
});

function isValidDate(value) {
  if (!value) return true;
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(dateText, days) {
  if (!dateText || !days) return null;
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

async function documentPolicy(organizationId, documentType) {
  const result = await query(
    `SELECT validity_days, alert_days_before
     FROM saas.document_type_policies
     WHERE (organization_id = $1 OR organization_id IS NULL)
       AND document_type = $2 AND is_active = TRUE
     ORDER BY organization_id IS NOT NULL DESC, updated_at DESC
     LIMIT 1`,
    [organizationId, documentType],
  );
  const fallback = POLICY_DEFAULTS[documentType] ?? { validityDays: null, alertDays: 5 };
  return {
    validityDays: result.rows[0]?.validity_days ?? fallback.validityDays,
    alertDays: result.rows[0]?.alert_days_before ?? fallback.alertDays,
  };
}

function setDownloadHeaders(res, document) {
  const fallbackName = String(document.document_name ?? "documento")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  const encodedName = encodeURIComponent(document.original_filename || document.document_name || "documento");
  res.set("Content-Type", document.mime_type || "application/octet-stream");
  res.set("Content-Disposition", `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, no-store");
}

documentsRouter.get("/integrations/documents/:documentId/file", async (req, res, next) => {
  try {
    const authorization = String(req.get("authorization") ?? "");
    if (!config.n8nWebhookSecret || !safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`)) {
      return res.status(401).json({ error: "Integración no autorizada." });
    }
    const result = await query(
      `SELECT document_name, original_filename, mime_type, storage_key
       FROM saas.organization_documents
       WHERE id = $1 AND document_status <> 'deleted' AND storage_provider = 'local'
       LIMIT 1`,
      [req.params.documentId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Documento no encontrado." });
    const stream = streamStoredDocument(result.rows[0].storage_key);
    if (!stream) return res.status(404).json({ error: "Archivo no disponible." });
    setDownloadHeaders(res, result.rows[0]);
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

documentsRouter.post(
  "/documents/upload",
  requireAuth,
  requireRole("owner", "admin", "analyst"),
  raw({ type: () => true, limit: config.documentUploadMaxBytes }),
  async (req, res, next) => {
    let stored = null;
    let documentPersisted = false;
    try {
      const originalFilename = String(req.query.filename ?? "").trim().slice(0, 255);
      const documentName = String(req.query.name ?? originalFilename).trim().slice(0, 180);
      const documentType = String(req.query.type ?? "").trim().toLowerCase();
      const description = String(req.query.description ?? "").trim().slice(0, 1000);
      const issueDate = String(req.query.issueDate ?? "").trim();
      const requestedExpiryDate = String(req.query.expiryDate ?? "").trim();

      if (!originalFilename || !documentName) return res.status(400).json({ error: "El nombre del documento es obligatorio." });
      if (!DOCUMENT_TYPE_PATTERN.test(documentType)) return res.status(400).json({ error: "Selecciona un tipo documental válido." });
      if (!isValidDate(issueDate) || !isValidDate(requestedExpiryDate)) return res.status(400).json({ error: "La fecha indicada no es válida." });

      const fileValidation = validateUploadedFile(req.body, originalFilename);
      if (!fileValidation.valid) return res.status(415).json({ error: fileValidation.error });
      const malwareScan = await scanForMalware(req.body);
      const fileHash = fileSha256(req.body);
      const duplicate = await query(
        `SELECT id, document_name
         FROM saas.organization_documents
         WHERE organization_id = $1 AND file_hash_sha256 = $2 AND document_status <> 'deleted'
         LIMIT 1`,
        [req.user.organization_id, fileHash],
      );
      if (duplicate.rowCount) {
        return res.status(409).json({ error: `Este archivo ya fue cargado como “${duplicate.rows[0].document_name}”.` });
      }

      const policy = await documentPolicy(req.user.organization_id, documentType);
      const expirationDate = requestedExpiryDate || addDays(issueDate, policy.validityDays);
      const alertDueDate = expirationDate ? addDays(expirationDate, -Math.abs(Number(policy.alertDays ?? 5))) : null;
      stored = await storeDocument({
        organizationId: req.user.organization_id,
        extension: fileValidation.extension,
        buffer: req.body,
      });

      const result = await query(
        `INSERT INTO saas.organization_documents (
           id, organization_id, document_type, document_name, original_filename, description,
           storage_provider, storage_bucket, storage_key, storage_url, mime_type,
           file_size_bytes, file_hash_sha256, issue_date, expiration_date,
           policy_validity_days, alert_days_before, renewal_due_date, alert_due_date,
           document_status, verification_status, extraction_status, review_status,
           malware_scan_status, malware_scanned_at, encryption_version, encrypted_at, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, NULLIF($6, ''),
           'local', 'cernoia-documents', $7, $8, $9,
           $10, $11, NULLIF($12, '')::DATE, NULLIF($13, '')::DATE,
           $14, $15, NULLIF($13, '')::DATE, NULLIF($16, '')::DATE,
           'uploaded', 'pending', 'not_requested', 'pending',
           $17, CASE WHEN $17 = 'clean' THEN NOW() END, $18, NOW(), $19::JSONB
         )
         RETURNING id, document_type, document_name, original_filename, description, storage_url,
                   mime_type, file_size_bytes, issue_date, expiration_date AS expiry_date,
                   document_status AS status, verification_status, extraction_status,
                   review_status, malware_scan_status, encryption_version,
                   policy_validity_days, alert_days_before, created_at`,
        [
          stored.documentId,
          req.user.organization_id,
          documentType,
          documentName,
          originalFilename,
          description,
          stored.relativeKey,
          `/api/documents/${stored.documentId}/file`,
          fileValidation.mime,
          req.body.length,
          fileHash,
          issueDate,
          expirationDate ?? "",
          policy.validityDays,
          policy.alertDays,
          alertDueDate ?? "",
          malwareScan.status,
          stored.encryptionVersion,
          JSON.stringify({ source: "cernoia_frontend", app_user_id: req.user.id }),
        ],
      );

      documentPersisted = true;
      const workflowCode = "WF-024";
      const workflowConfigured = Boolean(config.workflowUrls[workflowCode]);
      if (workflowConfigured) {
        void runWorkflow(workflowCode, {
          organization_id: req.user.organization_id,
          requested_by_user_id: req.user.id,
          organization_document_id: stored.documentId,
          document_type: documentType,
          document_name: documentName,
          mime_type: fileValidation.mime,
          file_sha256: fileHash,
          download_url: `${config.internalApiBaseUrl}/api/integrations/documents/${stored.documentId}/file`,
        }).catch((error) => {
          console.error(`${workflowCode} no aceptó el documento; se usa extracción local:`, error.message);
          return processOrganizationDocument(stored.documentId, req.user.organization_id)
            .catch((fallbackError) => console.error("Extracción documental local:", fallbackError.message));
        });
      } else {
        void processOrganizationDocument(stored.documentId, req.user.organization_id)
          .catch((error) => console.error("Extracción documental local:", error.message));
      }

      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "document.uploaded",
        entityType: "organization_document",
        entityId: stored.documentId,
        metadata: {
          document_type: documentType,
          workflow_requested: workflowConfigured,
          workflow_code: workflowConfigured ? workflowCode : null,
          malware_scan_status: malwareScan.status,
          encryption_version: stored.encryptionVersion,
        },
        req,
      });
      res.status(201).json({ document: result.rows[0], automation_queued: workflowConfigured });
    } catch (error) {
      if (!documentPersisted && stored?.relativeKey) await removeStoredDocument(stored.relativeKey).catch(() => {});
      if (error.type === "entity.too.large") return res.status(413).json({ error: "El archivo supera el límite permitido." });
      next(error);
    }
  },
);

documentsRouter.get("/documents/:documentId/file", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT document_name, original_filename, mime_type, storage_key
       FROM saas.organization_documents
       WHERE id = $1 AND organization_id = $2
         AND document_status <> 'deleted' AND storage_provider = 'local'
       LIMIT 1`,
      [req.params.documentId, req.user.organization_id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Documento no encontrado." });
    const stream = streamStoredDocument(result.rows[0].storage_key);
    if (!stream) return res.status(404).json({ error: "Archivo no disponible." });
    setDownloadHeaders(res, result.rows[0]);
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

documentsRouter.post("/integrations/documents/:documentId/extract", async (req, res, next) => {
  try {
    const authorization = String(req.get("authorization") ?? "");
    if (!config.n8nWebhookSecret || !safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`)) {
      return res.status(401).json({ error: "Integración no autorizada." });
    }
    const organizationId = String(req.body?.organization_id ?? "");
    const result = await processOrganizationDocument(req.params.documentId, organizationId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

documentsRouter.get("/documents/reviews", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT review.id, review.organization_document_id, review.status,
              review.proposed_values, review.confirmed_values, review.confidence,
              review.evidence, review.reviewed_at, review.created_at, review.updated_at,
              document.document_name, document.document_type, document.original_filename,
              document.issue_date, document.expiration_date, document.extraction_status,
              document.ocr_status, document.ocr_provider, document.review_status,
              document.ai_classification->>'document_type_label' AS document_type_label,
              document.ai_classification->>'metadata_status' AS metadata_status,
              document.ai_classification->>'expiration_source' AS expiration_source
       FROM saas.document_extraction_reviews review
       JOIN saas.organization_documents document ON document.id = review.organization_document_id
       WHERE review.organization_id = $1 AND document.document_status <> 'deleted'
       ORDER BY (review.status = 'pending') DESC, review.created_at DESC`,
      [req.user.organization_id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

documentsRouter.patch("/documents/:documentId/metadata", requireAuth, requireRole("owner", "admin", "analyst"), async (req, res, next) => {
  try {
    const name = String(req.body?.document_name ?? "").trim();
    const type = String(req.body?.document_type ?? "").trim();
    const issue = String(req.body?.issue_date ?? "").trim();
    const expiry = String(req.body?.expiration_date ?? "").trim();
    if (!name || name.length > 180 || !DOCUMENT_TYPE_PATTERN.test(type) || type === 'auto_detect') return res.status(400).json({error:"Nombre o tipo documental no válido."});
    if (!isValidDate(issue) || !isValidDate(expiry) || (issue && expiry && expiry < issue)) return res.status(400).json({error:"Revisa las fechas de expedición y vencimiento."});
    const result = await query(`UPDATE saas.organization_documents SET document_name=$3, document_type=$4,
      issue_date=NULLIF($5,'')::DATE, expiration_date=NULLIF($6,'')::DATE,
      renewal_due_date=NULLIF($6,'')::DATE, alert_due_date=NULLIF($6,'')::DATE-COALESCE(alert_days_before,5),
      metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('manual_metadata_fields',
        COALESCE(metadata->'manual_metadata_fields','[]'::jsonb)
        ||CASE WHEN document_name IS DISTINCT FROM $3 THEN '["document_name"]'::jsonb ELSE '[]'::jsonb END
        ||CASE WHEN document_type IS DISTINCT FROM $4 THEN '["document_type"]'::jsonb ELSE '[]'::jsonb END
        ||CASE WHEN issue_date IS DISTINCT FROM NULLIF($5,'')::date THEN '["issue_date"]'::jsonb ELSE '[]'::jsonb END
        ||CASE WHEN expiration_date IS DISTINCT FROM NULLIF($6,'')::date THEN '["expiration_date"]'::jsonb ELSE '[]'::jsonb END),
      ai_classification=COALESCE(ai_classification,'{}'::jsonb)
        ||CASE WHEN document_type IS DISTINCT FROM $4 THEN '{"document_type_label":null}'::jsonb ELSE '{}'::jsonb END
        ||CASE WHEN expiration_date IS DISTINCT FROM NULLIF($6,'')::date THEN '{"expiration_source":"manual"}'::jsonb ELSE '{}'::jsonb END,
      review_status='corrected', updated_at=NOW()
      WHERE id=$1 AND organization_id=$2 AND document_status <> 'deleted' RETURNING id`,
      [req.params.documentId, req.user.organization_id, name, type, issue, expiry]);
    if (!result.rowCount) return res.status(404).json({error:"Documento no encontrado."});
    await query(`UPDATE saas.document_extraction_reviews SET status='corrected', confirmed_values=$3::JSONB,
      reviewed_by_user_id=$4, reviewed_at=NOW(), updated_at=NOW() WHERE organization_document_id=$1 AND organization_id=$2`,
      [req.params.documentId,req.user.organization_id,JSON.stringify({document_name:name,document_type:type,issue_date:issue||null,expiration_date:expiry||null}),req.user.id]);
    await writeAudit({userId:req.user.id,organizationId:req.user.organization_id,action:"document.metadata_updated",entityType:"organization_document",entityId:req.params.documentId,req});
    res.json({document:result.rows[0]});
  } catch(error) {next(error);}
});

documentsRouter.patch(
  "/documents/:documentId/review",
  requireAuth,
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? "approved");
      const documentType = String(req.body?.document_type ?? "").trim().toLowerCase();
      const issueDate = String(req.body?.issue_date ?? "").trim();
      const expirationDate = String(req.body?.expiration_date ?? "").trim();
      const organizationType = String(req.body?.organization_type ?? "").trim();
      if (!['approved', 'corrected', 'rejected'].includes(status)) return res.status(400).json({ error: "Estado de revisión no válido." });
      if (documentType && !DOCUMENT_TYPE_PATTERN.test(documentType)) return res.status(400).json({ error: "Tipo documental no válido." });
      if (!isValidDate(issueDate) || !isValidDate(expirationDate) || (issueDate && expirationDate && expirationDate < issueDate)) return res.status(400).json({ error: "Fecha no válida." });
      const allowedOrganizationTypes = new Set(['legal_entity', 'natural_person', 'consortium', 'temporary_union', 'nonprofit', 'other']);
      if (organizationType && !allowedOrganizationTypes.has(organizationType)) {
        return res.status(400).json({ error: "Tipo de empresa no válido." });
      }
      const confirmed = {
        document_type: documentType || null,
        issue_date: issueDate || null,
        expiration_date: expirationDate || null,
        organization_type: organizationType || null,
      };
      const result = await query(
        `UPDATE saas.document_extraction_reviews review
         SET status = $4, confirmed_values = $5::JSONB, reviewed_by_user_id = $3,
             reviewed_at = NOW(), updated_at = NOW()
         FROM saas.organization_documents document
         WHERE review.organization_document_id = document.id
           AND document.id = $1 AND review.organization_id = $2
         RETURNING review.*`,
        [req.params.documentId, req.user.organization_id, req.user.id, status, JSON.stringify(confirmed)],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Revisión no encontrada." });
      if (status !== "rejected") {
        await query(
          `UPDATE saas.organization_documents
           SET document_type = COALESCE(NULLIF($3, ''), document_type),
               issue_date = NULLIF($4, '')::DATE,
               expiration_date = NULLIF($5, '')::DATE,
               renewal_due_date = NULLIF($5, '')::DATE,
               alert_due_date = NULLIF($5, '')::DATE-COALESCE(alert_days_before,5),
               ai_classification=COALESCE(ai_classification,'{}'::jsonb)
                 ||CASE WHEN document_type IS DISTINCT FROM COALESCE(NULLIF($3,''),document_type) THEN '{"document_type_label":null}'::jsonb ELSE '{}'::jsonb END
                 ||CASE WHEN expiration_date IS DISTINCT FROM NULLIF($5,'')::date THEN '{"expiration_source":"manual"}'::jsonb ELSE '{}'::jsonb END,
               metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('manual_metadata_fields',
                 COALESCE(metadata->'manual_metadata_fields','[]'::jsonb)
                 ||CASE WHEN document_type IS DISTINCT FROM NULLIF($3,'') THEN '["document_type"]'::jsonb ELSE '[]'::jsonb END
                 ||CASE WHEN issue_date IS DISTINCT FROM NULLIF($4,'')::date THEN '["issue_date"]'::jsonb ELSE '[]'::jsonb END
                 ||CASE WHEN expiration_date IS DISTINCT FROM NULLIF($5,'')::date THEN '["expiration_date"]'::jsonb ELSE '[]'::jsonb END),
               review_status = $6, verification_status = 'verified',
               verified_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND organization_id = $2`,
          [req.params.documentId, req.user.organization_id, documentType, issueDate, expirationDate, status],
        );
        if (organizationType) {
          await query(
            `UPDATE saas.organizations SET organization_type = $2, updated_at = NOW() WHERE id = $1`,
            [req.user.organization_id, organizationType],
          );
        }
      } else {
        await query(
          `UPDATE saas.organization_documents
           SET review_status = 'rejected', verification_status = 'rejected', updated_at = NOW()
           WHERE id = $1 AND organization_id = $2`,
          [req.params.documentId, req.user.organization_id],
        );
      }
      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "document.extraction_reviewed",
        entityType: "organization_document",
        entityId: req.params.documentId,
        metadata: { status, organization_type: organizationType || null },
        req,
      });
      res.json({ review: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

documentsRouter.get("/document-policies", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT DISTINCT ON (document_type)
              id, document_type, policy_name, validity_days, alert_days_before,
              renewal_frequency, automation_candidate, alert_schedule_days,
              require_human_review, is_active, organization_id, updated_at
       FROM saas.document_type_policies
       WHERE organization_id = $1 OR organization_id IS NULL
       ORDER BY document_type, (organization_id IS NOT NULL) DESC, updated_at DESC`,
      [req.user.organization_id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

documentsRouter.put(
  "/document-policies/:documentType",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const documentType = String(req.params.documentType ?? "").toLowerCase();
      const validityDays = req.body?.validity_days == null || req.body.validity_days === ""
        ? null
        : Number(req.body.validity_days);
      const schedule = Array.isArray(req.body?.alert_schedule_days)
        ? [...new Set(req.body.alert_schedule_days.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 365))]
            .sort((a, b) => b - a)
            .slice(0, 12)
        : [30, 15, 5, 2, 1];
      if (!DOCUMENT_TYPE_PATTERN.test(documentType)) return res.status(400).json({ error: "Tipo documental no válido." });
      if (validityDays != null && (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650)) {
        return res.status(400).json({ error: "La vigencia debe estar entre 1 y 3650 días." });
      }
      if (!schedule.length) return res.status(400).json({ error: "Configura al menos un aviso de vencimiento." });
      const result = await query(
        `INSERT INTO saas.document_type_policies (
           organization_id, document_type, policy_name, validity_days, alert_days_before,
           renewal_frequency, automation_candidate, alert_schedule_days,
           require_human_review, is_active, updated_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, TRUE, $10)
         ON CONFLICT (organization_id, document_type) WHERE organization_id IS NOT NULL DO UPDATE SET
           policy_name = EXCLUDED.policy_name, validity_days = EXCLUDED.validity_days,
           alert_days_before = EXCLUDED.alert_days_before,
           renewal_frequency = EXCLUDED.renewal_frequency,
           automation_candidate = EXCLUDED.automation_candidate,
           alert_schedule_days = EXCLUDED.alert_schedule_days,
           require_human_review = EXCLUDED.require_human_review,
           updated_by_user_id = EXCLUDED.updated_by_user_id, is_active = TRUE, updated_at = NOW()
         RETURNING *`,
        [
          req.user.organization_id,
          documentType,
          String(req.body?.policy_name ?? documentType).trim().slice(0, 180),
          validityDays,
          Math.max(...schedule),
          String(req.body?.renewal_frequency ?? "on_demand").slice(0, 80),
          Boolean(req.body?.automation_candidate),
          JSON.stringify(schedule),
          req.body?.require_human_review !== false,
          req.user.id,
        ],
      );
      if (req.body?.apply_existing === true) {
        await query(
          `UPDATE saas.organization_documents
           SET policy_validity_days = $3, alert_days_before = $4,
               expiration_date = CASE WHEN issue_date IS NOT NULL AND $3::INTEGER IS NOT NULL
                 THEN issue_date + $3::INTEGER ELSE expiration_date END,
               alert_due_date = CASE WHEN issue_date IS NOT NULL AND $3::INTEGER IS NOT NULL
                 THEN issue_date + $3::INTEGER - $4::INTEGER ELSE alert_due_date END,
               updated_at = NOW()
           WHERE organization_id = $1 AND document_type = $2 AND document_status <> 'deleted'`,
          [req.user.organization_id, documentType, validityDays, Math.max(...schedule)],
        );
      }
      res.json({ policy: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

documentsRouter.delete("/documents/:documentId", requireAuth, requireRole("owner", "admin", "analyst"), async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE saas.organization_documents
       SET document_status = 'deleted', updated_at = NOW(),
           metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('deleted_by_app_user_id', $3::TEXT, 'deleted_at', NOW())
       WHERE id = $1 AND organization_id = $2 AND document_status <> 'deleted'
       RETURNING id`,
      [req.params.documentId, req.user.organization_id, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Documento no encontrado." });
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "document.deleted",
      entityType: "organization_document",
      entityId: req.params.documentId,
      req,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
