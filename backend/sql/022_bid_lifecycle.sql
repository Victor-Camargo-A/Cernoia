BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS secop.public_document_insights (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), process_document_id UUID NOT NULL REFERENCES secop.process_documents(id) ON DELETE CASCADE,
 source_version TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 content_hash TEXT, storage_key TEXT, filename TEXT, mime_type TEXT, extracted_text TEXT,
 document_role TEXT NOT NULL DEFAULT 'unknown', summary TEXT, facts JSONB NOT NULL DEFAULT '[]', chunks JSONB NOT NULL DEFAULT '{}',
 field_schema JSONB NOT NULL DEFAULT '[]', error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), verified_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(process_document_id,source_version,prompt_version),
 CHECK(status IN ('queued','processing','ready','error')), CHECK(document_role IN ('informative','fillable','mixed','unknown'))
);
CREATE TABLE IF NOT EXISTS secop.public_process_matrices (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL, prompt_version TEXT NOT NULL, document_ids JSONB NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(process_id,source_fingerprint,prompt_version), CHECK(status IN ('queued','processing','ready','incomplete'))
);
CREATE INDEX IF NOT EXISTS public_matrices_pending ON secop.public_process_matrices(status,updated_at);
CREATE TABLE IF NOT EXISTS saas.bid_workspaces (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE, matrix_id UUID REFERENCES secop.public_process_matrices(id),
 started_by_user_id UUID REFERENCES saas.app_users(id), document_decisions JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,process_id)
);
ALTER TABLE saas.document_templates DROP CONSTRAINT IF EXISTS document_templates_template_type_check;
ALTER TABLE saas.document_templates ADD CONSTRAINT document_templates_template_type_check CHECK(template_type IN ('docx','pdf_form','xlsx'));
ALTER TABLE saas.document_templates ADD COLUMN IF NOT EXISTS public_insight_id UUID REFERENCES secop.public_document_insights(id), ADD COLUMN IF NOT EXISTS source_content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bid_template_per_source ON saas.document_templates(organization_id,process_id,public_insight_id) WHERE public_insight_id IS NOT NULL AND status='active';
DO $$ DECLARE c TEXT; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='saas.document_template_versions'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (organization_id, file_hash_sha256)' LOOP
  EXECUTE format('ALTER TABLE saas.document_template_versions DROP CONSTRAINT %I',c);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS document_version_content_lookup ON saas.document_template_versions(organization_id,file_hash_sha256);
CREATE TABLE IF NOT EXISTS saas.generated_document_previews (
 generated_document_id UUID PRIMARY KEY REFERENCES saas.generated_template_documents(id) ON DELETE CASCADE,
 organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 source_hash TEXT NOT NULL, pdf_hash TEXT NOT NULL, storage_key TEXT NOT NULL, page_count INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saas.generated_document_reviews (
 generated_document_id UUID PRIMARY KEY REFERENCES saas.generated_template_documents(id) ON DELETE CASCADE,
 organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 source_hash TEXT NOT NULL, preview_hash TEXT NOT NULL, reviewed_by_user_id UUID NOT NULL REFERENCES saas.app_users(id),
 reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saas.bid_exports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE, created_by_user_id UUID NOT NULL REFERENCES saas.app_users(id),
 manifest JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['bid_workspaces','generated_document_previews','generated_document_reviews','bid_exports'] LOOP
  EXECUTE format('ALTER TABLE saas.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE saas.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS cernoia_tenant_isolation ON saas.%I',t);
  EXECUTE format('CREATE POLICY cernoia_tenant_isolation ON saas.%I USING (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id()) WITH CHECK (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id())',t);
 END LOOP;
END $$;
-- Match the established application roles without granting public access to company tables.
DO $$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT grantee FROM information_schema.role_table_grants WHERE table_schema='saas' AND table_name='document_templates' AND privilege_type='SELECT' AND grantee NOT IN ('PUBLIC','postgres') LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.bid_workspaces,saas.generated_document_previews,saas.generated_document_reviews,saas.bid_exports,secop.public_document_insights,secop.public_process_matrices TO %I',r);
 END LOOP;
END $$;
COMMIT;
