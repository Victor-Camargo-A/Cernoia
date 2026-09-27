BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE saas.campaign_lists ADD COLUMN IF NOT EXISTS import_status TEXT NOT NULL DEFAULT 'ready' CHECK(import_status IN ('ready','processing','failed'));
CREATE TABLE IF NOT EXISTS saas.campaign_import_jobs(
 id UUID PRIMARY KEY,filename TEXT NOT NULL,file_bytes BIGINT NOT NULL,name TEXT NOT NULL,source_note TEXT NOT NULL,
 permission_confirmed BOOLEAN NOT NULL DEFAULT FALSE,created_by UUID REFERENCES saas.platform_admin_users(id),
 owner_user_id UUID REFERENCES saas.app_users(id),list_id UUID REFERENCES saas.campaign_lists(id),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
 phase TEXT NOT NULL DEFAULT 'En espera',total_rows INTEGER NOT NULL DEFAULT 0,valid_rows INTEGER NOT NULL DEFAULT 0,
 invalid_rows INTEGER NOT NULL DEFAULT 0,unique_contacts INTEGER NOT NULL DEFAULT 0,duplicate_rows INTEGER NOT NULL DEFAULT 0,
 error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ
);
DO $$ DECLARE r TEXT;BEGIN
 FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema='saas' AND table_name='campaign_lists' AND privilege_type='SELECT' AND grantee NOT IN ('PUBLIC','postgres') LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.campaign_import_jobs TO %I',r);
 END LOOP;
END $$;
COMMIT;
