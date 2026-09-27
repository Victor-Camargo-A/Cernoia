BEGIN;

CREATE TABLE IF NOT EXISTS saas.app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_email ON saas.app_users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_app_users_organization ON saas.app_users (organization_id, status);

CREATE TABLE IF NOT EXISTS saas.app_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES saas.organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_audit_org_created ON saas.app_audit_log (organization_id, created_at DESC);

COMMIT;
