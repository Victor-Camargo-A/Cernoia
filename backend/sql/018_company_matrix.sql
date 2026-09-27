BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE saas.organization_documents ADD COLUMN IF NOT EXISTS matrix_source_version BIGINT NOT NULL DEFAULT 0;
CREATE TABLE saas.company_matrix_state (
 organization_id UUID PRIMARY KEY REFERENCES saas.organizations(id) ON DELETE CASCADE,
 requested_revision BIGINT NOT NULL DEFAULT 1, processed_revision BIGINT NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','needs_review','empty','error')),
 matrix JSONB NOT NULL DEFAULT '{}', generated_at TIMESTAMPTZ, as_of_date DATE,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_token UUID, locked_until TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_reason TEXT,
 documents_total INTEGER NOT NULL DEFAULT 0, documents_processed INTEGER NOT NULL DEFAULT 0,
 started_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE saas.company_document_facts (
 organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 document_id UUID NOT NULL REFERENCES saas.organization_documents(id) ON DELETE CASCADE,
 input_hash TEXT NOT NULL, facts JSONB NOT NULL DEFAULT '[]', rejected_facts INTEGER NOT NULL DEFAULT 0,
 provider TEXT NOT NULL, model_name TEXT NOT NULL, prompt_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(organization_id,document_id,input_hash)
);
CREATE TABLE saas.company_matrix_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL, matrix JSONB NOT NULL, document_inventory JSONB NOT NULL,
 provider TEXT NOT NULL, model_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(organization_id,revision)
);
CREATE INDEX company_matrix_pending ON saas.company_matrix_state(next_attempt_at) WHERE status IN ('queued','error','processing');
CREATE OR REPLACE FUNCTION saas.queue_company_matrix(target UUID, reason TEXT DEFAULT 'document_changed')
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
BEGIN
 IF saas.current_organization_id() IS NOT NULL AND saas.current_organization_id()<>target THEN
  RAISE EXCEPTION 'Organization context mismatch' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM saas.organizations WHERE id=target) THEN RETURN; END IF;
 INSERT INTO saas.company_matrix_state(organization_id,last_reason,next_attempt_at)
 VALUES(target,reason,NOW()+INTERVAL '5 seconds')
 ON CONFLICT(organization_id) DO UPDATE SET requested_revision=company_matrix_state.requested_revision+1,
  status=CASE WHEN company_matrix_state.status='processing' AND company_matrix_state.locked_until>NOW() THEN 'processing' ELSE 'queued' END,
  next_attempt_at=NOW()+INTERVAL '5 seconds',attempts=0,last_error=NULL,last_reason=reason,updated_at=NOW();
END $$;
CREATE OR REPLACE FUNCTION saas.company_document_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.matrix_source_version:=1;
 ELSIF ROW(NEW.document_type,NEW.document_name,NEW.extracted_text,NEW.storage_key,NEW.file_hash_sha256,NEW.extraction_status,NEW.issue_date,NEW.expiration_date,NEW.document_status,NEW.review_status,NEW.verification_status,NEW.malware_scan_status)
 IS DISTINCT FROM ROW(OLD.document_type,OLD.document_name,OLD.extracted_text,OLD.storage_key,OLD.file_hash_sha256,OLD.extraction_status,OLD.issue_date,OLD.expiration_date,OLD.document_status,OLD.review_status,OLD.verification_status,OLD.malware_scan_status)
 THEN NEW.matrix_source_version:=OLD.matrix_source_version+1;
 ELSE NEW.matrix_source_version:=OLD.matrix_source_version; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION saas.company_document_matrix_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM saas.queue_company_matrix(OLD.organization_id,'document_deleted');RETURN OLD;
 ELSIF TG_OP='INSERT' OR NEW.matrix_source_version<>OLD.matrix_source_version THEN
  PERFORM saas.queue_company_matrix(NEW.organization_id,'document_changed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_document_revision BEFORE INSERT OR UPDATE ON saas.organization_documents
 FOR EACH ROW EXECUTE FUNCTION saas.company_document_revision();
CREATE TRIGGER company_document_matrix_changed AFTER INSERT OR UPDATE OR DELETE ON saas.organization_documents
 FOR EACH ROW EXECUTE FUNCTION saas.company_document_matrix_changed();
CREATE OR REPLACE FUNCTION saas.company_identity_matrix_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.name,NEW.legal_name,NEW.tax_id) IS DISTINCT FROM ROW(OLD.name,OLD.legal_name,OLD.tax_id) THEN
  PERFORM saas.queue_company_matrix(NEW.id,'organization_identity_changed');
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER company_identity_matrix_changed AFTER UPDATE ON saas.organizations FOR EACH ROW EXECUTE FUNCTION saas.company_identity_matrix_changed();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['company_matrix_state','company_document_facts','company_matrix_versions'] LOOP
  EXECUTE format('ALTER TABLE saas.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE saas.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY cernoia_tenant_isolation ON saas.%I USING (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id()) WITH CHECK (saas.current_organization_id() IS NULL OR organization_id=saas.current_organization_id())',t);
 END LOOP;
END $$;
-- The same application role already operates the authenticated API and background tasks.
GRANT SELECT,INSERT,UPDATE,DELETE ON saas.company_matrix_state,saas.company_document_facts,saas.company_matrix_versions TO cernoia_app;
INSERT INTO saas.company_matrix_state(organization_id,last_reason)
 SELECT DISTINCT organization_id,'initial_document_inventory' FROM saas.organization_documents WHERE document_status<>'deleted'
 ON CONFLICT DO NOTHING;
COMMIT;
