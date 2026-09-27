BEGIN;

CREATE TABLE IF NOT EXISTS saas.app_signature_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES saas.app_users(id) ON DELETE CASCADE,
  signer_name TEXT NOT NULL,
  signer_role TEXT,
  signature_kind TEXT NOT NULL DEFAULT 'drawn'
    CHECK (signature_kind IN ('drawn', 'uploaded')),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  file_hash_sha256 TEXT NOT NULL,
  consent_version TEXT NOT NULL DEFAULT 'cernoia-electronic-signature-v1',
  consent_statement TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_signature_profiles_active_user
  ON saas.app_signature_profiles (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_signature_profiles_org
  ON saas.app_signature_profiles (organization_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas.document_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  organization_document_id UUID NOT NULL REFERENCES saas.organization_documents(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('expiring', 'expired', 'missing_date', 'review_required')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'read', 'resolved', 'dismissed')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  due_date DATE,
  dedupe_key TEXT NOT NULL,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  first_triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_document_alerts_org_status
  ON saas.document_alerts (organization_id, status, severity, due_date);

CREATE TABLE IF NOT EXISTS saas.alert_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'ready', 'fallback', 'failed')),
  headline TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  model_provider TEXT,
  model_name TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_alert_digests_org_date
  ON saas.alert_digests (organization_id, digest_date DESC);

CREATE TABLE IF NOT EXISTS saas.proposal_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  signature_profile_id UUID REFERENCES saas.app_signature_profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'drafting', 'rendering', 'ready', 'needs_review', 'failed', 'cancelled')),
  include_electronic_signature BOOLEAN NOT NULL DEFAULT FALSE,
  review_required BOOLEAN NOT NULL DEFAULT TRUE,
  generation_mode TEXT NOT NULL DEFAULT 'standard_package_v1',
  requested_instructions TEXT,
  content_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  storage_provider TEXT,
  storage_key TEXT,
  storage_url TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,
  file_hash_sha256 TEXT,
  signature_evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  workflow_execution_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_packages_org_process
  ON saas.proposal_packages (organization_id, process_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proposal_packages_queue
  ON saas.proposal_packages (status, created_at)
  WHERE status IN ('queued', 'drafting', 'rendering');

CREATE UNIQUE INDEX IF NOT EXISTS uq_proposal_packages_active_process
  ON saas.proposal_packages (organization_id, process_id)
  WHERE status IN ('queued', 'drafting', 'rendering');

CREATE TABLE IF NOT EXISTS ops.ai_quota_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'google',
  model_name TEXT NOT NULL,
  workflow_code TEXT NOT NULL,
  request_id TEXT,
  organization_id UUID REFERENCES saas.organizations(id) ON DELETE SET NULL,
  n8n_execution_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('granted', 'minute_wait', 'daily_limit', 'provider_error')),
  minute_used INTEGER,
  minute_limit INTEGER,
  daily_used INTEGER,
  daily_limit INTEGER,
  retry_after_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_quota_events_created
  ON ops.ai_quota_events (provider, model_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_quota_events_org
  ON ops.ai_quota_events (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

COMMIT;
