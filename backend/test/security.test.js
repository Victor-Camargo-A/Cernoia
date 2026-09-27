import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { hashPassword, safeEqual, signWebhookPayload, validatePassword, verifyPassword } from "../src/security.js";

process.env.BOLD_SECRET_KEY ||= "bold-test-secret-key";

test("hashPassword crea un hash verificable sin guardar la clave", async () => {
  const password = "Una-clave-muy-segura-2026";
  const hash = await hashPassword(password);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("otra-clave-distinta", hash), false);
});

test("la firma HMAC es estable para el mismo cuerpo", () => {
  assert.equal(
    signWebhookPayload('{"ok":true}', "secreto"),
    signWebhookPayload('{"ok":true}', "secreto"),
  );
});

test("la política de contraseñas rechaza claves débiles", () => {
  assert.equal(validatePassword("corta1").valid, false);
  assert.equal(validatePassword("solo-letras-sin-numero").valid, false);
  assert.equal(validatePassword("Frase-larga-2026").valid, true);
});

test("la comparación segura exige valores completos e idénticos", () => {
  assert.equal(safeEqual("token-seguro", "token-seguro"), true);
  assert.equal(safeEqual("token-seguro", "token-distinto"), false);
  assert.equal(safeEqual("a", "aa"), false);
});

test("la carga documental valida firma y extensión", async () => {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
  const { validateUploadedFile } = await import("../src/services/document-storage.js");
  const pdf = Buffer.from("%PDF-1.7 contenido de prueba");
  assert.equal(validateUploadedFile(pdf, "certificado.pdf").valid, true);
  assert.equal(validateUploadedFile(Buffer.from("archivo falso"), "certificado.pdf").valid, false);
  assert.equal(validateUploadedFile(pdf, "certificado.exe").valid, false);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(validateUploadedFile(png, "firma.png").valid, true);
  assert.equal(validateUploadedFile(png, "firma.jpg").valid, false);
});

test("el paquete preliminar se renderiza como PDF válido", async () => {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
  const { buildProposalPdf } = await import("../src/services/proposal-renderer.js");
  const pdf = await buildProposalPdf({
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Paquete de prueba",
      organization_name: "Empresa de prueba",
      legal_name: "Empresa de prueba S.A.S.",
      organization_type: "legal_entity",
      tax_id: "900000000-1",
      city: "Bogotá",
      department: "Bogotá D.C.",
      reference: "PROCESO-001",
      entity_name: "Entidad de prueba",
      base_price: 1000000,
      response_deadline: "2026-10-01T12:00:00Z",
      generation_mode: "standard_package_v1",
      content_json: {},
      include_electronic_signature: false,
      creator_name: "Persona autorizada",
    },
    requirements: [
      {
        requirement_name: "Certificado de existencia",
        mandatory: true,
        status: "pending",
        organization_document_name: "Cámara de Comercio",
        document_match_status: "matched",
      },
    ],
    signatureBuffer: null,
  });
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 3000);
});

test("el webhook de Bold exige la firma HMAC del cuerpo exacto", async () => {
  const { normalizeBoldEvent, verifyBoldSignature } = await import("../src/services/bold.js");
  const raw = Buffer.from(JSON.stringify({ type: "SALE_APPROVED", data: { reference: "CERNOIA-1" } }));
  const signature = createHmac("sha256", process.env.BOLD_SECRET_KEY)
    .update(raw.toString("base64"))
    .digest("hex");
  assert.equal(verifyBoldSignature(raw, signature), true);
  assert.equal(verifyBoldSignature(Buffer.from(`${raw} `), signature), false);
  const invalidSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
  assert.equal(verifyBoldSignature(raw, invalidSignature), false);
  assert.deepEqual(
    normalizeBoldEvent({
      type: "SALE_APPROVED",
      data: {
        payment_id: "PAY-1",
        metadata: { reference: "CERNOIA-1" },
        amount: { currency: "COP", total: 250000 },
      },
    }),
    {
      type: "SALE_APPROVED",
      providerLinkId: "",
      merchantReference: "CERNOIA-1",
      transactionId: "PAY-1",
      amountCop: 250000,
      currency: "COP",
      payerEmail: "",
      paymentMethod: "",
    },
  );
});

test("los secretos de MFA se cifran y autentican con AES-GCM", async () => {
  const { decryptSecret, encryptSecret } = await import("../src/services/secret-box.js");
  const protectedSecret = encryptSecret("JBSWY3DPEHPK3PXP");
  assert.notEqual(protectedSecret.encrypted, "JBSWY3DPEHPK3PXP");
  assert.equal(decryptSecret(protectedSecret), "JBSWY3DPEHPK3PXP");
  const changedTag = Buffer.from(protectedSecret.tag, "base64url");
  changedTag[0] ^= 1;
  const invalidTag = changedTag.toString("base64url");
  assert.throws(() => decryptSecret({ ...protectedSecret, tag: invalidTag }));
});

test("el autollenado conserva un PDF válido y completa campos editables", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.create();
  const page = source.addPage([400, 300]);
  const form = source.getForm();
  form.createTextField("legal_name").addToPage(page, { x: 40, y: 220, width: 280, height: 24 });
  form.createCheckBox("authorized").addToPage(page, { x: 40, y: 170, width: 18, height: 18 });
  const sourceBuffer = Buffer.from(await source.save());
  const { inspectTemplate, renderTemplate } = await import("../src/services/template-renderer.js");
  const fields = await inspectTemplate(sourceBuffer, "pdf_form");
  assert.deepEqual(fields.map((field) => field.name).sort(), ["authorized", "legal_name"]);
  const result = await renderTemplate({
    buffer: sourceBuffer,
    templateType: "pdf_form",
    values: { legal_name: "Empresa Demo S.A.S.", authorized: true },
    fieldSchema: fields,
  });
  const rendered = await PDFDocument.load(result.buffer);
  assert.equal(rendered.getForm().getTextField("legal_name").getText(), "Empresa Demo S.A.S.");
  assert.equal(rendered.getForm().getCheckBox("authorized").isChecked(), true);
  assert.equal(result.issues.length, 0);
});
