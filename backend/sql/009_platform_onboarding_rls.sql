BEGIN;

-- Administradores de la plataforma CernoIA. No pertenecen a una organización
-- cliente y nunca reciben acceso implícito a los paneles empresariales.
CREATE TABLE IF NOT EXISTS saas.platform_admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admin_email
  ON saas.platform_admin_users (LOWER(email));

CREATE TABLE IF NOT EXISTS saas.platform_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES saas.platform_admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_sessions_active
  ON saas.platform_admin_sessions (admin_id, expires_at)
  WHERE revoked_at IS NULL;

-- Invitaciones de acceso. El token nunca se guarda en claro.
CREATE TABLE IF NOT EXISTS saas.organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  invited_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_invitations_pending
  ON saas.organization_invitations (organization_id, LOWER(email))
  WHERE accepted_at IS NULL;

ALTER TABLE saas.app_sessions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES saas.organizations(id) ON DELETE CASCADE;

UPDATE saas.app_sessions AS session
SET organization_id = app_user.organization_id
FROM saas.app_users AS app_user
WHERE session.user_id = app_user.id
  AND session.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_sessions_organization
  ON saas.app_sessions (organization_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Permite que la aplicación detecte el nivel de preparación de cada empresa
-- sin mezclarlo con el estado de suscripción.
ALTER TABLE saas.organizations
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'started'
    CHECK (onboarding_status IN ('started', 'profile_incomplete', 'ready', 'blocked'));

-- El contexto se fija por transacción desde backend/src/db.js. La función
-- devuelve NULL para login, webhooks y operaciones globales autorizadas.
CREATE OR REPLACE FUNCTION saas.current_organization_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', TRUE), '')::UUID
$$;

-- Defensa en profundidad: todas las tablas SaaS que contienen organization_id
-- quedan protegidas. Las rutas autenticadas fijan app.organization_id por
-- transacción; el contexto vacío se conserva solamente para login, webhooks y
-- tareas de plataforma que necesitan operar globalmente.
DO $$
DECLARE
  table_record RECORD;
BEGIN
  FOR table_record IN
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'saas'
      AND column_name = 'organization_id'
  LOOP
    EXECUTE format('ALTER TABLE saas.%I ENABLE ROW LEVEL SECURITY', table_record.table_name);
    EXECUTE format('ALTER TABLE saas.%I FORCE ROW LEVEL SECURITY', table_record.table_name);
    EXECUTE format('DROP POLICY IF EXISTS cernoia_tenant_isolation ON saas.%I', table_record.table_name);
    EXECUTE format(
      'CREATE POLICY cernoia_tenant_isolation ON saas.%I
       USING (
         saas.current_organization_id() IS NULL
         OR organization_id IS NULL
         OR organization_id = saas.current_organization_id()
       )
       WITH CHECK (
         saas.current_organization_id() IS NULL
         OR organization_id = saas.current_organization_id()
       )',
      table_record.table_name
    );
  END LOOP;
END $$;

COMMIT;
