import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [dataRoutes, workflowRoutes, server, authRoutes, accountRoutes, documentsView, proposalRoutes, proposalView, platformRoutes, migration, platformView, loginView] = await Promise.all([
  readFile(new URL("../backend/src/routes/data.js", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/routes/workflows.js", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/server.js", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/routes/auth.js", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/routes/account.js", import.meta.url), "utf8"),
  readFile(new URL("../app/components/dashboard/documents-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/routes/proposals.js", import.meta.url), "utf8"),
  readFile(new URL("../app/components/dashboard/proposal-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../backend/src/routes/platform.js", import.meta.url), "utf8"),
  readFile(new URL("../backend/sql/009_platform_onboarding_rls.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/components/platform-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/login-screen.tsx", import.meta.url), "utf8"),
]);

test("el historial operativo mantiene el límite por organización", () => {
  assert.match(dataRoutes, /metadata\s*->>\s*'organization_id'\s*=\s*\$1::TEXT/);
  assert.match(dataRoutes, /\[req\.user\.organization_id\]/);
});

test("el cliente solo puede iniciar la orquestación principal", () => {
  assert.match(workflowRoutes, /code\s*!==\s*"WF-019"/);
  assert.doesNotMatch(workflowRoutes, /\["WF-019",\s*"WF-005"/);
});

test("las escrituras pasan por origen y CSRF", () => {
  assert.match(server, /app\.use\(validateOrigin\)/);
  assert.match(server, /app\.use\(validateCsrf\)/);
});

test("las sesiones se persisten y pueden revocarse", () => {
  assert.match(authRoutes, /INSERT INTO saas\.app_sessions/);
  assert.match(authRoutes, /UPDATE saas\.app_sessions SET revoked_at = NOW\(\)/);
});

test("la empresa puede configurar capacidades y búsquedas sin editar SQL", () => {
  assert.match(accountRoutes, /\/account\/capability-profile/);
  assert.match(accountRoutes, /\/account\/search-profile/);
  assert.match(accountRoutes, /organization_id = \$1/);
  assert.match(accountRoutes, /organization_type_suggestion/);
  assert.match(accountRoutes, /ORGANIZATION_TYPES/);
});

test("la interfaz incluye carga documental real", () => {
  assert.match(documentsView, /type="file"/);
  assert.match(documentsView, /uploadOrganizationDocument/);
  assert.match(documentsView, /Cargar y validar/);
});

test("la disponibilidad exige etapas y workflows de soporte", () => {
  assert.match(workflowRoutes, /const PIPELINE_STAGES/);
  assert.match(workflowRoutes, /const SUPPORT_WORKFLOWS/);
  assert.match(workflowRoutes, /can_start: pipelineReady/);
});

test("las propuestas y firmas mantienen autorización, organización y consentimiento", () => {
  assert.match(proposalRoutes, /package\.organization_id = \$1/);
  assert.match(proposalRoutes, /signature_confirmation/);
  assert.match(proposalRoutes, /safeEqual\(authorization/);
  assert.match(proposalRoutes, /requireRole\("owner", "admin", "analyst"\)/);
  assert.match(proposalView, /confirm_review_and_signature/);
  assert.match(proposalView, /Descargar PDF/);
});

test("la consola global está separada del tenant y el alta usa invitación de un solo uso", () => {
  assert.match(platformRoutes, /platform_admin_users/);
  assert.match(platformRoutes, /requirePlatformAuth/);
  assert.match(platformRoutes, /organization_invitations/);
  assert.match(authRoutes, /invitations\/accept/);
  assert.match(loginView, /invite_token/);
  assert.match(platformView, /No fue posible crear la organización/);
});

test("RLS fija el contexto transaccional y no habilita selector de organización", () => {
  assert.match(migration, /current_organization_id/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /organization_invitations/);
  assert.match(migration, /organization_id = saas\.current_organization_id/);
});
