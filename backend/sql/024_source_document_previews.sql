BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS saas.source_document_previews (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('process_document','template_version','archive_entry')),
 source_id UUID NOT NULL,source_version TEXT NOT NULL,
 process_id UUID REFERENCES secop.processes(id) ON DELETE CASCADE,
 original_filename TEXT NOT NULL,mime_type TEXT NOT NULL,source_hash TEXT NOT NULL,
 original_storage_key TEXT NOT NULL,pdf_storage_key TEXT,pdf_hash TEXT,page_count INTEGER NOT NULL DEFAULT 0,
 archive_entries JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(organization_id,source_kind,source_id,source_version)
);
ALTER TABLE saas.source_document_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.source_document_previews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cernoia_tenant_isolation ON saas.source_document_previews;
CREATE POLICY cernoia_tenant_isolation ON saas.source_document_previews
 USING (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id())
 WITH CHECK (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id());
DO $$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT grantee FROM information_schema.role_table_grants WHERE table_schema='saas' AND table_name='document_templates' AND privilege_type='SELECT' AND grantee NOT IN ('PUBLIC','postgres') LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.source_document_previews TO %I',r);
 END LOOP;
END $$;
COMMIT;
