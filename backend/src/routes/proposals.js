import { Router, raw } from "express";
import { config } from "../config.js";
import { pool, query } from "../db.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/subscription.js";
import { safeEqual } from "../security.js";
import {
  fileSha256,
  removeStoredDocument,
  storeDocument,
  streamStoredDocument,
  validateUploadedFile,
} from "../services/document-storage.js";
import { runWorkflow } from "../services/n8n.js";
import { renderProposalPackage, requestFingerprint } from "../services/proposal-renderer.js";

export const proposalsRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_CONSENT_VERSION = "cernoia-electronic-signature-v1";
const SIGNATURE_CONSENT = "Autorizo el almacenamiento privado de esta firma y su uso solo en los paquetes que confirme desde mi sesión. Entiendo que debo revisar cada documento y que este mecanismo no equivale por sí solo a una firma digital certificada.";
const PACKAGE_SIGNATURE_CONFIRMATION_VERSION = "cernoia-package-signature-confirmation-v1";

function requireUuid(value, message) {
  const normalized = String(value ?? "").trim();
  if (!UUID_PATTERN.test(normalized)) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function setPrivateDownloadHeaders(res, filename, mimeType = "application/octet-stream", disposition = "attachment") {
  const safeName = String(filename ?? "archivo")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 140);
  const encodedName = encodeURIComponent(String(filename ?? "archivo"));
  res.set("Content-Type", mimeType);
  res.set("Content-Disposition", `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, no-store");
}

async function activeSignature(user) {
  const result = await query(
    `SELECT id, signer_name, signer_role, signature_kind, mime_type, file_size_bytes,
            file_hash_sha256, consent_version, consented_at, created_at, updated_at,
            '/api/signature-profile/file'::TEXT AS preview_url
     FROM saas.app_signature_profiles
     WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.organization_id, user.id],
  );
  return result.rows[0] ?? null;
}

proposalsRouter.get("/signature-profile", requireAuth, async (req, res, next) => {
  try {
    res.json({ signature: await activeSignature(req.user) });
  } catch (error) {
    next(error);
  }
});

proposalsRouter.get("/signature-profile/file", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT storage_key, mime_type, signature_kind
       FROM saas.app_signature_profiles
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.organization_id, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "No hay una firma electrónica activa." });
    const stream = streamStoredDocument(result.rows[0].storage_key);
    if (!stream) return res.status(404).json({ error: "La imagen de firma no está disponible." });
    const extension = result.rows[0].mime_type === "image/jpeg" ? "jpg" : "png";
    setPrivateDownloadHeaders(res, `firma-${result.rows[0].signature_kind}.${extension}`, result.rows[0].mime_type, "inline");
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

proposalsRouter.post(
  "/signature-profile",
  requireAuth,
  requireRole("owner", "admin", "analyst"),
  raw({ type: () => true, limit: config.signatureUploadMaxBytes }),
  async (req, res, next) => {
    let stored = null;
    try {
      const filename = String(req.query.filename ?? "firma.png").trim().slice(0, 255);
      const signerName = String(req.query.signerName ?? req.user.full_name ?? "").trim().slice(0, 180);
      const signerRole = String(req.query.signerRole ?? "").trim().slice(0, 160);
      const signatureKind = String(req.query.kind ?? "drawn").toLowerCase() === "uploaded" ? "uploaded" : "drawn";
      const consent = String(req.query.consent ?? "").toLowerCase() === "true";
      if (signerName.length < 3) return res.status(400).json({ error: "Indica el nombre completo de la persona firmante." });
      if (!signerRole) return res.status(400).json({ error: "Indica el cargo o calidad de la persona firmante." });
      if (!consent) return res.status(400).json({ error: "Debes aceptar el consentimiento de firma electrónica." });

      const validation = validateUploadedFile(req.body, filename);
      if (!validation.valid || !["image/png", "image/jpeg"].includes(validation.mime)) {
        return res.status(415).json({ error: "La firma debe ser una imagen PNG o JPG válida." });
      }
      const hash = fileSha256(req.body);
      stored = await storeDocument({
        organizationId: req.user.organization_id,
        extension: validation.extension,
        buffer: req.body,
      });

      const client = await pool.connect();
      let result;
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE saas.app_signature_profiles
           SET revoked_at = NOW(), updated_at = NOW()
           WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [req.user.organization_id, req.user.id],
        );
        result = await client.query(
          `INSERT INTO saas.app_signature_profiles (
             organization_id, user_id, signer_name, signer_role, signature_kind,
             storage_provider, storage_key, mime_type, file_size_bytes, file_hash_sha256,
             consent_version, consent_statement, consented_at
           ) VALUES ($1, $2, $3, $4, $5, 'local', $6, $7, $8, $9, $10, $11, NOW())
           RETURNING id, signer_name, signer_role, signature_kind, mime_type, file_size_bytes,
                     file_hash_sha256, consent_version, consented_at, created_at, updated_at,
                     '/api/signature-profile/file'::TEXT AS preview_url`,
          [
            req.user.organization_id,
            req.user.id,
            signerName,
            signerRole,
            signatureKind,
            stored.relativeKey,
            validation.mime,
            req.body.length,
            hash,
            SIGNATURE_CONSENT_VERSION,
            SIGNATURE_CONSENT,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "signature_profile.created",
        entityType: "signature_profile",
        entityId: result.rows[0].id,
        metadata: { signature_kind: signatureKind, consent_version: SIGNATURE_CONSENT_VERSION },
        req,
      });
      res.status(201).json({ signature: result.rows[0] });
    } catch (error) {
      if (stored?.relativeKey) await removeStoredDocument(stored.relativeKey).catch(() => {});
      next(error);
    }
  },
);

proposalsRouter.delete("/signature-profile", requireAuth, requireRole("owner", "admin", "analyst"), async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE saas.app_signature_profiles
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.user.organization_id, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "No hay una firma electrónica activa." });
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "signature_profile.revoked",
      entityType: "signature_profile",
      entityId: result.rows[0].id,
      req,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

proposalsRouter.get("/opportunities/:processId/proposals", requireAuth, async (req, res, next) => {
  try {
    const processId = requireUuid(req.params.processId, "El identificador de la oportunidad no es válido.");
    const result = await query(
      `SELECT package.id, package.process_id, package.title, package.status,
              package.include_electronic_signature, package.review_required,
              package.generation_mode, package.storage_url, package.mime_type,
              package.file_size_bytes, package.file_hash_sha256, package.error_message,
              package.completed_at, package.created_at, package.updated_at,
              creator.full_name AS created_by_name
       FROM saas.proposal_packages package
       LEFT JOIN saas.app_users creator ON creator.id = package.created_by_user_id
       WHERE package.organization_id = $1 AND package.process_id = $2
       ORDER BY package.created_at DESC
       LIMIT 20`,
      [req.user.organization_id, processId],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

proposalsRouter.post(
  "/opportunities/:processId/proposals",
  requireAuth,
  requireEntitlement("proposal_generation"),
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    try {
      const processId = requireUuid(req.params.processId, "El identificador de la oportunidad no es válido.");
      const includeSignature = Boolean(req.body?.include_electronic_signature);
      const consent = Boolean(req.body?.confirm_review_and_signature);
      const instructions = String(req.body?.instructions ?? "").trim().slice(0, 3000);

      const opportunity = await query(
        `SELECT process.id, process.reference, process.secop_process_id, process.process_name, process.entity_name
         FROM secop.processes process
         WHERE process.id = $2
           AND EXISTS (
             SELECT 1 FROM saas.process_matches match
             WHERE match.organization_id = $1 AND match.process_id = process.id
           )
         LIMIT 1`,
        [req.user.organization_id, processId],
      );
      if (!opportunity.rowCount) return res.status(404).json({ error: "Oportunidad no encontrada." });

      const inProgress = await query(
        `SELECT id, status FROM saas.proposal_packages
         WHERE organization_id = $1 AND process_id = $2
           AND status IN ('queued', 'drafting', 'rendering')
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.organization_id, processId],
      );
      if (inProgress.rowCount) {
        return res.status(409).json({
          error: "Ya existe un paquete en preparación para esta oportunidad.",
          proposal_id: inProgress.rows[0].id,
        });
      }

      let signature = null;
      if (includeSignature) {
        if (!consent) return res.status(400).json({ error: "Confirma la revisión y aplicación de la firma electrónica." });
        signature = await activeSignature(req.user);
        if (!signature) return res.status(400).json({ error: "Primero crea o carga tu firma electrónica." });
      }

      const source = opportunity.rows[0];
      const title = `Paquete ${source.reference || source.secop_process_id || source.process_name || "de propuesta"}`.slice(0, 240);
      const result = await query(
        `INSERT INTO saas.proposal_packages (
           organization_id, process_id, created_by_user_id, signature_profile_id, title,
           status, include_electronic_signature, review_required, requested_instructions,
           input_snapshot
         ) VALUES ($1, $2, $3, $4, $5, 'queued', $6, TRUE, NULLIF($7, ''), $8::JSONB)
         RETURNING id, process_id, title, status, include_electronic_signature,
                   review_required, generation_mode, created_at, updated_at`,
        [
          req.user.organization_id,
          processId,
          req.user.id,
          signature?.id ?? null,
          title,
          includeSignature,
          instructions,
          JSON.stringify({
            requested_by_user_id: req.user.id,
            requested_at: new Date().toISOString(),
            request_fingerprint_sha256: requestFingerprint(req),
            user_agent: String(req.get("user-agent") ?? "").slice(0, 500),
            signature_confirmation: includeSignature
              ? {
                  confirmed: true,
                  version: PACKAGE_SIGNATURE_CONFIRMATION_VERSION,
                  confirmed_at: new Date().toISOString(),
                  statement: "Confirmo que soy la persona autorizada para usar este perfil de firma y que revisaré todo el paquete antes de presentarlo.",
                }
              : null,
          }),
        ],
      );
      const proposal = result.rows[0];

      await writeAudit({
        userId: req.user.id,
        organizationId: req.user.organization_id,
        action: "proposal.requested",
        entityType: "proposal_package",
        entityId: proposal.id,
        metadata: { process_id: processId, include_electronic_signature: includeSignature },
        req,
      });

      if (config.workflowUrls["WF-022"]) {
        void runWorkflow("WF-022", {
          organization_id: req.user.organization_id,
          process_id: processId,
          proposal_package_id: proposal.id,
          requested_by_user_id: req.user.id,
        }).catch(async (error) => {
          console.error("WF-022 no aceptó el paquete; se usa generación determinística:", error.message);
          await renderProposalPackage(proposal.id).catch((renderError) => {
            console.error("No fue posible generar el paquete de respaldo:", renderError.message);
          });
        });
        return res.status(202).json({ proposal, automation_queued: true });
      }

      const rendered = await renderProposalPackage(proposal.id);
      res.status(201).json({ proposal: rendered, automation_queued: false });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Ya existe un paquete en preparación para esta oportunidad." });
      next(error);
    }
  },
);

proposalsRouter.get("/proposals/:proposalId/file", requireAuth, async (req, res, next) => {
  try {
    const proposalId = requireUuid(req.params.proposalId, "El identificador del paquete no es válido.");
    const result = await query(
      `SELECT title, storage_key, mime_type
       FROM saas.proposal_packages
       WHERE id = $1 AND organization_id = $2 AND status = 'ready'
       LIMIT 1`,
      [proposalId, req.user.organization_id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "El paquete todavía no está disponible." });
    const stream = streamStoredDocument(result.rows[0].storage_key);
    if (!stream) return res.status(404).json({ error: "El archivo generado no está disponible." });
    setPrivateDownloadHeaders(res, `${result.rows[0].title}.pdf`, result.rows[0].mime_type || "application/pdf");
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

proposalsRouter.post("/integrations/proposals/:proposalId/render", async (req, res, next) => {
  try {
    const authorization = String(req.get("authorization") ?? "");
    if (!config.n8nWebhookSecret || !safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`)) {
      return res.status(401).json({ error: "Integración no autorizada." });
    }
    const proposalId = requireUuid(req.params.proposalId, "El identificador del paquete no es válido.");
    const content = req.body?.content && typeof req.body.content === "object" ? req.body.content : {};
    const workflowExecutionId = String(req.body?.workflow_execution_id ?? "").slice(0, 120);
    await query(
      `UPDATE saas.proposal_packages
       SET content_json = $2::JSONB, workflow_execution_id = NULLIF($3, ''), updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('cancelled', 'ready')`,
      [proposalId, JSON.stringify(content), workflowExecutionId],
    );
    const proposal = await renderProposalPackage(proposalId, { workflowExecutionId });
    res.json({ proposal });
  } catch (error) {
    next(error);
  }
});
