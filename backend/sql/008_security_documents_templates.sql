BEGIN;

ALTER TABLE saas.app_users
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS saas.app_mfa_credentials (
  user_id UUID PRIMARY KEY REFERENCES saas.app_users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  pending BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::JSONB,
  last_used_counter BIGINT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_mfa_org
  ON saas.app_mfa_credentials (organization_id, pending);

CREATE TABLE IF NOT EXISTS saas.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES saas.app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_active
  ON saas.password_reset_tokens (user_id, expires_at DESC)
  WHERE used_at IS NULL;

ALTER TABLE saas.organization_documents
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extraction_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS ocr_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS ocr_provider TEXT,
  ADD COLUMN IF NOT EXISTS malware_scan_status TEXT NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS malware_scanned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS encryption_version TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS saas.document_extraction_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  organization_document_id UUID NOT NULL REFERENCES saas.organization_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'corrected', 'rejected')),
  proposed_values JSONB NOT NULL DEFAULT '{}'::JSONB,
  confirmed_values JSONB NOT NULL DEFAULT '{}'::JSONB,
  confidence NUMERIC(5,4),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  reviewed_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_reviews_org_status
  ON saas.document_extraction_reviews (organization_id, status, created_at DESC);

ALTER TABLE saas.document_type_policies
  ADD COLUMN IF NOT EXISTS alert_schedule_days JSONB NOT NULL DEFAULT '[30,15,5,2,1]'::JSONB,
  ADD COLUMN IF NOT EXISTS require_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL;

INSERT INTO saas.document_type_policies (
  organization_id, document_type, policy_name, validity_days, alert_days_before,
  renewal_frequency, automation_candidate, alert_schedule_days, require_human_review
) VALUES
  (NULL, 'chamber_of_commerce', 'Cámara de Comercio', 45, 30, 'on_demand', TRUE, '[30,15,5,2,1]'::JSONB, TRUE),
  (NULL, 'rut', 'Registro Único Tributario', NULL, 30, 'on_change', FALSE, '[30,15,5,2,1]'::JSONB, TRUE),
  (NULL, 'fiscal_background', 'Antecedentes fiscales', 30, 15, 'monthly', TRUE, '[15,5,2,1]'::JSONB, TRUE),
  (NULL, 'disciplinary_background', 'Antecedentes disciplinarios', 30, 15, 'monthly', TRUE, '[15,5,2,1]'::JSONB, TRUE),
  (NULL, 'police_background', 'Antecedentes de Policía', 30, 15, 'monthly', TRUE, '[15,5,2,1]'::JSONB, TRUE),
  (NULL, 'judicial_measures', 'Medidas correctivas', 30, 15, 'monthly', TRUE, '[15,5,2,1]'::JSONB, TRUE),
  (NULL, 'experience_certificate', 'Certificado de experiencia', NULL, 30, 'on_demand', FALSE, '[30,15,5,2,1]'::JSONB, TRUE),
  (NULL, 'financial_statement', 'Estado financiero', 365, 60, 'annual', FALSE, '[60,30,15,5,1]'::JSONB, TRUE),
  (NULL, 'quality_certificate', 'Certificación de calidad', NULL, 60, 'on_demand', FALSE, '[60,30,15,5,1]'::JSONB, TRUE),
  (NULL, 'identity_document', 'Documento de identidad', NULL, 60, 'on_demand', FALSE, '[60,30,15,5,1]'::JSONB, TRUE),
  (NULL, 'other_document', 'Otro documento', NULL, 30, 'on_demand', FALSE, '[30,15,5,2,1]'::JSONB, TRUE)
ON CONFLICT (document_type) WHERE organization_id IS NULL DO UPDATE SET
  policy_name = EXCLUDED.policy_name,
  validity_days = EXCLUDED.validity_days,
  alert_days_before = EXCLUDED.alert_days_before,
  renewal_frequency = EXCLUDED.renewal_frequency,
  automation_candidate = EXCLUDED.automation_candidate,
  alert_schedule_days = EXCLUDED.alert_schedule_days,
  require_human_review = EXCLUDED.require_human_review,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS saas.document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  template_type TEXT NOT NULL CHECK (template_type IN ('docx', 'pdf_form')),
  scope TEXT NOT NULL DEFAULT 'organization' CHECK (scope IN ('organization', 'entity', 'process')),
  entity_nit TEXT,
  process_id UUID REFERENCES secop.processes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS saas.document_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES saas.document_templates(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  original_filename TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  file_hash_sha256 TEXT NOT NULL,
  field_schema JSONB NOT NULL DEFAULT '[]'::JSONB,
  field_mapping JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version_number),
  UNIQUE (organization_id, file_hash_sha256)
);

CREATE INDEX IF NOT EXISTS idx_document_templates_org
  ON saas.document_templates (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS saas.generated_template_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES saas.document_templates(id) ON DELETE CASCADE,
  template_version_id UUID NOT NULL REFERENCES saas.document_template_versions(id) ON DELETE RESTRICT,
  process_id UUID REFERENCES secop.processes(id) ON DELETE SET NULL,
  proposal_package_id UUID REFERENCES saas.proposal_packages(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'needs_review', 'failed')),
  field_values JSONB NOT NULL DEFAULT '{}'::JSONB,
  validation_issues JSONB NOT NULL DEFAULT '[]'::JSONB,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT,
  storage_url TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,
  file_hash_sha256 TEXT,
  error_message TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_templates_org_process
  ON saas.generated_template_documents (organization_id, process_id, created_at DESC);

CREATE OR REPLACE FUNCTION saas.current_organization_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', TRUE), '')::UUID
$$;

ALTER TABLE saas.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.billing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.document_extraction_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.generated_template_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.app_mfa_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_subscriptions ON saas.subscriptions;
CREATE POLICY tenant_subscriptions ON saas.subscriptions
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_billing_orders ON saas.billing_orders;
CREATE POLICY tenant_billing_orders ON saas.billing_orders
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_subscription_events ON saas.subscription_events;
CREATE POLICY tenant_subscription_events ON saas.subscription_events
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_chat_threads ON saas.chat_threads;
CREATE POLICY tenant_chat_threads ON saas.chat_threads
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_chat_messages ON saas.chat_messages;
CREATE POLICY tenant_chat_messages ON saas.chat_messages
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_notification_channels ON saas.notification_channels;
CREATE POLICY tenant_notification_channels ON saas.notification_channels
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_notification_outbox ON saas.notification_outbox;
CREATE POLICY tenant_notification_outbox ON saas.notification_outbox
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_notification_deliveries ON saas.notification_deliveries;
CREATE POLICY tenant_notification_deliveries ON saas.notification_deliveries
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_document_reviews ON saas.document_extraction_reviews;
CREATE POLICY tenant_document_reviews ON saas.document_extraction_reviews
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_document_templates ON saas.document_templates;
CREATE POLICY tenant_document_templates ON saas.document_templates
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_document_template_versions ON saas.document_template_versions;
CREATE POLICY tenant_document_template_versions ON saas.document_template_versions
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_generated_template_documents ON saas.generated_template_documents;
CREATE POLICY tenant_generated_template_documents ON saas.generated_template_documents
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

DROP POLICY IF EXISTS tenant_mfa_credentials ON saas.app_mfa_credentials;
CREATE POLICY tenant_mfa_credentials ON saas.app_mfa_credentials
  USING (organization_id = saas.current_organization_id())
  WITH CHECK (organization_id = saas.current_organization_id());

COMMIT;
