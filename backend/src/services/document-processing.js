import { query } from "../db.js";
import { extractDocumentText } from "./document-extractor.js";
import { readStoredDocument } from "./document-storage.js";

import { inferDocumentMetadata } from "./document-metadata.js";

export async function processOrganizationDocument(documentId, organizationId) {
  const result = await query(
    `SELECT id, organization_id, document_type, document_name, original_filename,
            mime_type, storage_key, issue_date, expiration_date
     FROM saas.organization_documents
     WHERE id = $1 AND organization_id = $2 AND document_status <> 'deleted'
     LIMIT 1`,
    [documentId, organizationId],
  );
  if (!result.rowCount) {
    const error = new Error("Documento no encontrado.");
    error.statusCode = 404;
    throw error;
  }
  const document = result.rows[0];
  try {
    await query(
      `UPDATE saas.organization_documents
       SET extraction_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [document.id],
    );
    const buffer = await readStoredDocument(document.storage_key);
    if (!buffer) throw new Error("Archivo privado no disponible.");
    const extraction = await extractDocumentText(buffer, {
      mimeType: document.mime_type,
      filename: document.original_filename,
    });
    const proposedValues = inferDocumentMetadata(extraction.text, document);
    const hasUsefulText = extraction.text.length >= 40;
    const requiresReview = !hasUsefulText || proposedValues.requires_review || Boolean(extraction.warning) || extraction.ocrStatus === "partial" || (extraction.confidence != null && extraction.confidence < 0.85);
    const persisted = await query(
      `UPDATE saas.organization_documents
       SET extracted_text = $2,
           extraction_status = $3,
           extraction_confidence = $4,
           ocr_status = $5,
           ocr_provider = $6,
           review_status = CASE WHEN review_status IN ('corrected','rejected') THEN review_status WHEN $8 THEN 'pending' ELSE 'approved' END,
           document_type = CASE WHEN review_status IN ('corrected','rejected') THEN document_type ELSE $9 END, document_name = CASE WHEN review_status IN ('corrected','rejected') THEN document_name ELSE COALESCE($10, document_name) END,
           issue_date = CASE WHEN review_status IN ('corrected','rejected') THEN issue_date ELSE $11::DATE END, expiration_date = CASE WHEN review_status IN ('corrected','rejected') THEN expiration_date ELSE $12::DATE END,
           renewal_due_date = CASE WHEN review_status IN ('corrected','rejected') THEN renewal_due_date ELSE $12::DATE END,
           alert_due_date = CASE WHEN review_status IN ('corrected','rejected') THEN alert_due_date ELSE $12::DATE - COALESCE(alert_days_before, 5) END,
           ai_classification = COALESCE(ai_classification, '{}'::JSONB)
             || jsonb_build_object(
                  'organization_type', $7::TEXT,
                  'confidence', $4::NUMERIC,
                  'extraction_method', $6::TEXT,
                  'requires_human_review', $8::BOOLEAN, 'metadata_source', 'automatic_extraction', 'metadata_status', 'queued', 'metadata_attempts', 0
                ),
           updated_at = NOW()
       WHERE id = $1 AND document_status <> 'deleted' RETURNING review_status`,
      [
        document.id,
        extraction.text,
        hasUsefulText ? "extracted" : "needs_review",
        extraction.confidence,
        extraction.ocrStatus,
        extraction.method,
        proposedValues.organization_type,
        requiresReview, proposedValues.document_type, proposedValues.document_name,
        proposedValues.issue_date, proposedValues.expiration_date,
      ],
    );
    if (!persisted.rowCount) return { document_id: document.id, deleted: true };
    await query(
      `INSERT INTO saas.document_extraction_reviews (
         organization_id, organization_document_id, status, proposed_values,
         confidence, evidence
       ) VALUES ($1, $2, $6, $3::JSONB, $4, $5::JSONB)
       ON CONFLICT (organization_document_id) DO UPDATE SET
         status = EXCLUDED.status, proposed_values = EXCLUDED.proposed_values,
         confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
         reviewed_by_user_id = NULL, reviewed_at = NULL, updated_at = NOW()
       WHERE saas.document_extraction_reviews.status NOT IN ('corrected', 'rejected')`,
      [
        organizationId,
        document.id,
        JSON.stringify(proposedValues),
        extraction.confidence,
        JSON.stringify({
          method: extraction.method,
          ocr_status: extraction.ocrStatus,
          character_count: extraction.text.length,
          warning: extraction.warning ?? null,
          automatic: !requiresReview,
        }),
        persisted.rows[0].review_status,
      ],
    );
    return { document_id: document.id, extraction, proposed_values: proposedValues };
  } catch (error) {
    await query(
      `UPDATE saas.organization_documents
       SET extraction_status = 'needs_review', review_status = CASE WHEN review_status IN ('corrected','rejected') THEN review_status ELSE 'pending' END,
           ocr_status = CASE WHEN ocr_status = 'not_requested' THEN 'failed' ELSE ocr_status END,
           metadata = COALESCE(metadata, '{}'::JSONB)
             || jsonb_build_object('extraction_error', LEFT($2, 1000)),
           updated_at = NOW()
       WHERE id = $1`,
      [document.id, error.message],
    ).catch(() => undefined);
    throw error;
  }
}
