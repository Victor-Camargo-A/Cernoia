BEGIN;

ALTER TABLE saas.app_users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE saas.app_users
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE saas.app_users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS saas.app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES saas.app_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_user_active
  ON saas.app_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_sessions_expiry
  ON saas.app_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS saas.app_opportunity_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'watching'
    CHECK (stage IN ('watching', 'reviewing', 'preparing', 'submitted', 'dismissed')),
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  updated_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, process_id)
);

CREATE INDEX IF NOT EXISTS idx_app_opportunity_states_org_stage
  ON saas.app_opportunity_states (organization_id, stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS saas.app_organization_settings (
  organization_id UUID PRIMARY KEY REFERENCES saas.organizations(id) ON DELETE CASCADE,
  notification_email TEXT,
  minimum_match_score NUMERIC(5,2) NOT NULL DEFAULT 60
    CHECK (minimum_match_score BETWEEN 0 AND 100),
  default_departments TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notify_new_matches BOOLEAN NOT NULL DEFAULT TRUE,
  notify_deadlines BOOLEAN NOT NULL DEFAULT TRUE,
  daily_digest BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
