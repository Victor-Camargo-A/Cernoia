import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { query } from "../db.js";
import {
  fileSha256,
  readStoredDocument,
  removeStoredDocument,
  storeDocument,
} from "./document-storage.js";

const BRAND = Object.freeze({
  ink: "#082f38",
  teal: "#0b5963",
  mint: "#8de4cf",
  slate: "#475569",
  pale: "#eef8f6",
  border: "#d8e5e3",
  danger: "#b42318",
});

function clean(value, maximum = 4000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function dateText(value) {
  if (!value) return "No informada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value, 80) || "No informada";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "long",
    timeZone: "America/Bogota",
  }).format(date);
}

function currencyText(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "No informado";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(amount);
}

function statusText(value) {
  const labels = {
    matched: "Cubierto",
    compliant: "Cumple",
    partial: "Cobertura parcial",
    missing: "Pendiente",
    expired: "Vencido",
    expiring: "Por vencer",
    manual_review: "Revisión humana",
    review_required: "Revisión humana",
    legal_entity: "Persona jurídica",
    natural_person: "Persona natural",
    consortium: "Consorcio",
    temporary_union: "Unión temporal",
    nonprofit: "Entidad sin ánimo de lucro",
    unconfirmed: "Sin confirmar",
  };
  return labels[String(value ?? "").toLowerCase()] ?? (clean(value, 80) || "Pendiente");
}

function ensureSpace(doc, height = 70) {
  if (doc.y + height <= doc.page.height - 58) return;
  doc.addPage();
  pageHeader(doc);
}

function pageHeader(doc) {
  doc
    .fillColor(BRAND.ink)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("CERNOIA", 52, 30, { continued: true })
    .fillColor(BRAND.teal)
    .font("Helvetica")
    .text("  ·  Inteligencia de mercados públicos");
  doc
    .moveTo(52, 48)
    .lineTo(doc.page.width - 52, 48)
    .lineWidth(0.7)
    .strokeColor(BRAND.border)
    .stroke();
  doc.y = 64;
}

function sectionTitle(doc, title, description = "") {
  ensureSpace(doc, description ? 76 : 54);
  doc
    .fillColor(BRAND.ink)
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(clean(title, 180));
  if (description) {
    doc
      .moveDown(0.25)
      .fillColor(BRAND.slate)
      .font("Helvetica")
      .fontSize(9.5)
      .text(clean(description, 700), { lineGap: 2 });
  }
  doc.moveDown(0.75);
}

function fieldRow(doc, label, value) {
  ensureSpace(doc, 34);
  const left = 52;
  const top = doc.y;
  doc
    .roundedRect(left, top, doc.page.width - 104, 28, 5)
    .fillAndStroke("#f8fafc", BRAND.border);
  doc
    .fillColor(BRAND.slate)
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .text(clean(label, 80), left + 10, top + 9, { width: 125 });
  doc
    .fillColor(BRAND.ink)
    .font("Helvetica")
    .fontSize(9)
    .text(clean(value, 600) || "No informado", left + 140, top + 8, {
      width: doc.page.width - left - 202,
      ellipsis: true,
    });
  doc.y = top + 35;
}

function paragraph(doc, text) {
  const value = clean(text, 12000);
  if (!value) return;
  ensureSpace(doc, 48);
  doc
    .fillColor(BRAND.ink)
    .font("Helvetica")
    .fontSize(10.2)
    .text(value, { align: "justify", lineGap: 4 });
  doc.moveDown(0.75);
}

function requirementRow(doc, requirement, index) {
  ensureSpace(doc, 78);
  const x = 52;
  const width = doc.page.width - 104;
  const top = doc.y;
  const name = clean(requirement.requirement_name || requirement.requirement_description, 500) || `Requisito ${index + 1}`;
  const evidence = clean(requirement.organization_document_name, 240) || "Sin documento asociado";
  const status = statusText(requirement.document_match_status || requirement.status);
  const mandatory = requirement.mandatory ? "Obligatorio" : "Opcional";

  doc.roundedRect(x, top, width, 64, 6).fillAndStroke("#ffffff", BRAND.border);
  doc
    .fillColor(BRAND.teal)
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .text(`${index + 1}. ${mandatory}`, x + 10, top + 9, { width: 120 });
  doc
    .fillColor(BRAND.ink)
    .font("Helvetica-Bold")
    .fontSize(9.2)
    .text(name, x + 10, top + 23, { width: width - 150, height: 28, ellipsis: true });
  doc
    .fillColor(BRAND.slate)
    .font("Helvetica")
    .fontSize(8.2)
    .text(`Evidencia: ${evidence}`, x + 10, top + 50, { width: width - 145, ellipsis: true });
  doc
    .roundedRect(x + width - 125, top + 18, 112, 26, 13)
    .fill(status === "Cumple" || status === "Cubierto" ? BRAND.pale : "#fff7ed");
  doc
    .fillColor(status === "Cumple" || status === "Cubierto" ? BRAND.teal : "#9a3412")
    .font("Helvetica-Bold")
    .fontSize(8)
    .text(status, x + width - 119, top + 27, { width: 100, align: "center", ellipsis: true });
  doc.y = top + 72;
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

async function loadProposalData(packageId) {
  const packageResult = await query(
    `SELECT package.*, organization.name AS organization_name,
            COALESCE(organization.legal_name, organization.name) AS legal_name,
            organization.tax_id, organization.city, organization.department, organization.website,
            organization.organization_type,
            process.reference, process.secop_process_id, process.process_name, process.description AS process_description,
            process.entity_name, process.entity_nit, process.procurement_method, process.contract_type,
            process.base_price, process.response_deadline, process.process_url,
            creator.full_name AS creator_name, creator.email AS creator_email,
            signature.signer_name, signature.signer_role, signature.signature_kind,
            signature.storage_key AS signature_storage_key, signature.mime_type AS signature_mime_type,
            signature.file_hash_sha256 AS signature_hash_sha256,
            signature.consent_version, signature.consent_statement, signature.consented_at,
            signature.user_id AS signature_user_id, signature.revoked_at AS signature_revoked_at
     FROM saas.proposal_packages package
     JOIN saas.organizations organization ON organization.id = package.organization_id
     JOIN secop.processes process ON process.id = package.process_id
     LEFT JOIN saas.app_users creator ON creator.id = package.created_by_user_id
     LEFT JOIN saas.app_signature_profiles signature ON signature.id = package.signature_profile_id
     WHERE package.id = $1
     LIMIT 1`,
    [packageId],
  );
  if (!packageResult.rowCount) {
    const error = new Error("Paquete de propuesta no encontrado.");
    error.statusCode = 404;
    throw error;
  }

  const record = packageResult.rows[0];
  const requirements = await query(
    `SELECT requirement.id, requirement.requirement_name, requirement.requirement_description,
            requirement.requirement_category, requirement.normalized_document_type,
            requirement.mandatory, requirement.status, requirement.requires_signature,
            requirement.requires_entity_template, requirement.source_document_name,
            match.match_status AS document_match_status,
            document.document_name AS organization_document_name,
            document.expiration_date AS organization_document_expiry
     FROM saas.opportunity_requirements requirement
     LEFT JOIN LATERAL (
       SELECT relation.organization_document_id, relation.match_status, relation.match_score
       FROM saas.opportunity_requirement_documents relation
       WHERE relation.opportunity_requirement_id = requirement.id
       ORDER BY relation.match_score DESC NULLS LAST, relation.updated_at DESC
       LIMIT 1
     ) match ON TRUE
     LEFT JOIN saas.organization_documents document
       ON document.id = match.organization_document_id
      AND document.organization_id = requirement.organization_id
      AND document.document_status <> 'deleted'
     WHERE requirement.organization_id = $1 AND requirement.process_id = $2
     ORDER BY requirement.mandatory DESC, requirement.created_at ASC`,
    [record.organization_id, record.process_id],
  );

  return { record, requirements: requirements.rows };
}

export async function buildProposalPdf({ record, requirements, signatureBuffer }) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 64, right: 52, bottom: 58, left: 52 },
    info: {
      Title: clean(record.title, 200),
      Author: clean(record.legal_name, 200),
      Subject: `Paquete preliminar para ${clean(record.reference || record.secop_process_id, 160)}`,
      Creator: "CernoIA",
    },
    bufferPages: true,
  });

  doc.rect(0, 0, doc.page.width, 190).fill(BRAND.ink);
  doc
    .fillColor(BRAND.mint)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text("CERNOIA", 52, 48);
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(26)
    .text("Paquete preliminar\nde propuesta", 52, 78, { lineGap: 4 });
  doc
    .fillColor("#cbd5e1")
    .font("Helvetica")
    .fontSize(10)
    .text("Documento generado para revisión humana antes de su presentación.", 52, 150, {
      width: doc.page.width - 104,
    });

  doc.y = 220;
  fieldRow(doc, "Proceso", record.reference || record.secop_process_id || "Sin referencia");
  fieldRow(doc, "Entidad", record.entity_name || "No informada");
  fieldRow(doc, "Proponente", record.legal_name || record.organization_name);
  fieldRow(doc, "Tipo de proponente", statusText(record.organization_type));
  fieldRow(doc, "NIT", record.tax_id || "No informado");
  fieldRow(doc, "Presupuesto oficial", currencyText(record.base_price));
  fieldRow(doc, "Fecha límite", dateText(record.response_deadline));
  doc.moveDown(0.5);
  doc
    .fillColor(BRAND.danger)
    .font("Helvetica-Bold")
    .fontSize(8.8)
    .text("BORRADOR · CernoIA no presenta la oferta ni reemplaza la verificación del pliego.", {
      align: "center",
    });

  doc.addPage();
  pageHeader(doc);
  sectionTitle(doc, "Carta de presentación", "Texto base generado con los datos disponibles en la plataforma.");
  paragraph(doc, `${[record.city, record.department].filter(Boolean).join(", ") || "Colombia"}, ${dateText(new Date())}.`);
  paragraph(doc, `Señores ${record.entity_name || "Entidad contratante"}. Referencia: ${record.reference || record.secop_process_id || "proceso consultado"}.`);
  const generatedCover = clean(record.content_json?.cover_letter, 12000);
  paragraph(
    doc,
    generatedCover ||
      `${record.legal_name || record.organization_name}, identificada con NIT ${record.tax_id || "no informado"}, manifiesta su interés en participar en el proceso indicado. La información y los documentos incluidos en este paquete se presentan como borrador de trabajo y deben contrastarse con el pliego, sus adendas y los formatos oficiales antes de radicar la oferta.`,
  );
  paragraph(doc, "Declaramos que la información deberá ser revisada y aprobada por la persona autorizada de la empresa antes de cualquier presentación ante SECOP o la entidad contratante.");

  doc.moveDown(1);
  if (record.include_electronic_signature && signatureBuffer && !record.signature_revoked_at) {
    ensureSpace(doc, 155);
    const signatureTop = doc.y;
    try {
      doc.image(signatureBuffer, 52, signatureTop, { fit: [190, 70], align: "left", valign: "center" });
    } catch {
      doc
        .fillColor(BRAND.slate)
        .font("Helvetica-Oblique")
        .fontSize(9)
        .text("La imagen de firma no pudo representarse; revise el perfil de firma.", 52, signatureTop + 22);
    }
    doc
      .moveTo(52, signatureTop + 78)
      .lineTo(280, signatureTop + 78)
      .strokeColor(BRAND.ink)
      .stroke();
    doc
      .fillColor(BRAND.ink)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(clean(record.signer_name || record.creator_name, 180), 52, signatureTop + 86);
    doc
      .fillColor(BRAND.slate)
      .font("Helvetica")
      .fontSize(9)
      .text(clean(record.signer_role, 160) || "Firmante autorizado", 52, signatureTop + 102);
    doc
      .fillColor(BRAND.teal)
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("Firma electrónica aplicada en CernoIA", 52, signatureTop + 121);
    doc.y = signatureTop + 145;
  } else {
    ensureSpace(doc, 90);
    doc
      .moveTo(52, doc.y + 42)
      .lineTo(280, doc.y + 42)
      .strokeColor(BRAND.ink)
      .stroke();
    doc
      .moveDown(3)
      .fillColor(BRAND.slate)
      .font("Helvetica")
      .fontSize(9)
      .text("Firma de la persona autorizada");
  }

  doc.addPage();
  pageHeader(doc);
  sectionTitle(doc, "Matriz de preparación", `${requirements.length} requisitos identificados. La cobertura automática no constituye un concepto jurídico definitivo.`);
  if (!requirements.length) {
    paragraph(doc, "Aún no hay requisitos extraídos para este proceso. Ejecute el análisis documental antes de considerar completo el paquete.");
  } else {
    requirements.slice(0, 250).forEach((requirement, index) => requirementRow(doc, requirement, index));
  }

  const declarations = Array.isArray(record.content_json?.declarations)
    ? record.content_json.declarations.slice(0, 12)
    : [];
  if (declarations.length) {
    doc.addPage();
    pageHeader(doc);
    sectionTitle(doc, "Declaraciones preparadas", "Borradores sujetos a la validación del representante y del formato exigido por la entidad.");
    declarations.forEach((declaration, index) => {
      sectionTitle(doc, clean(declaration?.title, 180) || `Declaración ${index + 1}`);
      paragraph(doc, declaration?.text);
    });
  }

  doc.addPage();
  pageHeader(doc);
  sectionTitle(doc, "Control de revisión y trazabilidad");
  fieldRow(doc, "Paquete", record.id);
  fieldRow(doc, "Generado por", record.creator_name || record.creator_email || "Usuario autorizado");
  fieldRow(doc, "Fecha de generación", dateText(new Date()));
  fieldRow(doc, "Modo", record.generation_mode);
  fieldRow(doc, "Revisión humana", "Obligatoria antes de presentar la oferta");
  if (record.include_electronic_signature) {
    fieldRow(doc, "Firma electrónica", record.signer_name || "Perfil no disponible");
    fieldRow(doc, "Consentimiento", record.consent_version || "No informado");
    fieldRow(doc, "Huella de la firma", record.signature_hash_sha256 || "No informada");
    paragraph(doc, "La firma aplicada es una firma electrónica simple con evidencia de consentimiento y trazabilidad interna. No se presenta como firma digital certificada. Si el pliego exige certificado digital, estampado cronológico acreditado, reconocimiento notarial u otra formalidad específica, debe utilizarse el mecanismo exigido por la entidad.");
  }
  paragraph(doc, "Lista mínima de control: verificar adendas, fechas, cuantías, experiencia, indicadores, garantías, inhabilidades, documentos obligatorios, formatos oficiales y canal de radicación.");

  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(index);
    doc
      .fillColor("#64748b")
      .font("Helvetica")
      .fontSize(8)
      .text(`CernoIA · ${record.reference || record.secop_process_id || record.id}`, 52, doc.page.height - 38, {
        width: doc.page.width - 104,
        align: "left",
      });
    doc.text(`Página ${index + 1} de ${pages.count}`, 52, doc.page.height - 38, {
      width: doc.page.width - 104,
      align: "right",
    });
  }

  return collectPdf(doc);
}

export async function renderProposalPackage(packageId, { workflowExecutionId = null } = {}) {
  let stored = null;
  try {
    const { record, requirements } = await loadProposalData(packageId);
    if (record.status === "cancelled") {
      const error = new Error("El paquete fue cancelado.");
      error.statusCode = 409;
      throw error;
    }
    if (record.status === "ready" && record.storage_key) return record;

    await query(
      `UPDATE saas.proposal_packages
       SET status = 'rendering', started_at = COALESCE(started_at, NOW()),
           workflow_execution_id = COALESCE(NULLIF($2, ''), workflow_execution_id),
           error_message = NULL, updated_at = NOW()
       WHERE id = $1`,
      [packageId, workflowExecutionId],
    );

    let signatureBuffer = null;
    if (
      record.include_electronic_signature &&
      record.signature_storage_key &&
      !record.signature_revoked_at &&
      record.signature_user_id === record.created_by_user_id
    ) {
      signatureBuffer = await readStoredDocument(record.signature_storage_key);
    }

    const pdf = await buildProposalPdf({ record, requirements, signatureBuffer });
    const hash = fileSha256(pdf);
    stored = await storeDocument({
      organizationId: record.organization_id,
      extension: ".pdf",
      buffer: pdf,
    });
    const signatureEvidence = record.include_electronic_signature && signatureBuffer
      ? {
          method: "cernoia_electronic_signature_v1",
          signature_profile_id: record.signature_profile_id,
          signer_user_id: record.signature_user_id,
          signer_name: record.signer_name,
          signer_role: record.signer_role,
          consent_version: record.consent_version,
          consented_at: record.consented_at,
          package_confirmation: record.input_snapshot?.signature_confirmation ?? null,
          signature_hash_sha256: record.signature_hash_sha256,
          applied_at: new Date().toISOString(),
        }
      : {};

    const result = await query(
      `UPDATE saas.proposal_packages
       SET status = 'ready', review_required = TRUE,
           storage_provider = 'local', storage_key = $2, storage_url = $3,
           mime_type = 'application/pdf', file_size_bytes = $4, file_hash_sha256 = $5,
           signature_evidence = $6::JSONB, completed_at = NOW(), error_message = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, organization_id, process_id, title, status, include_electronic_signature,
                 review_required, generation_mode, storage_url, mime_type, file_size_bytes,
                 file_hash_sha256, signature_evidence, completed_at, created_at, updated_at`,
      [
        packageId,
        stored.relativeKey,
        `/api/proposals/${packageId}/file`,
        pdf.length,
        hash,
        JSON.stringify(signatureEvidence),
      ],
    );
    return result.rows[0];
  } catch (error) {
    if (stored?.relativeKey) await removeStoredDocument(stored.relativeKey).catch(() => {});
    await query(
      `UPDATE saas.proposal_packages
       SET status = 'failed', error_message = LEFT($2, 3000), completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status <> 'cancelled'`,
      [packageId, clean(error.message, 3000) || "No fue posible generar el paquete."],
    ).catch(() => undefined);
    throw error;
  }
}

export function requestFingerprint(req) {
  const raw = `${req.ip ?? ""}|${req.get?.("user-agent") ?? ""}`;
  return createHash("sha256").update(raw).digest("hex");
}
