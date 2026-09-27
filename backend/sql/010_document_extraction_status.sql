BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE saas.organization_documents
  DROP CONSTRAINT IF EXISTS chk_org_document_extraction;
ALTER TABLE saas.organization_documents
  ADD CONSTRAINT chk_org_document_extraction CHECK (
    extraction_status IN (
      'not_requested', 'queued', 'processing', 'success', 'failed',
      'extracted', 'needs_review'
    )
  ) NOT VALID;
ALTER TABLE saas.organization_documents
  VALIDATE CONSTRAINT chk_org_document_extraction;
COMMIT;
