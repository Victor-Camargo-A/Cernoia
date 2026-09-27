BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS secop;
CREATE SCHEMA IF NOT EXISTS saas;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS secop.processes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secop_process_id VARCHAR(160) NOT NULL UNIQUE,
  reference VARCHAR(160),
  entity_name TEXT,
  entity_nit VARCHAR(50),
  department VARCHAR(120),
  city VARCHAR(120),
  process_name TEXT,
  description TEXT,
  procurement_method VARCHAR(180),
  contract_type VARCHAR(180),
  base_price NUMERIC(20,2),
  publication_date TIMESTAMPTZ,
  response_deadline TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  process_status VARCHAR(180),
  awarded BOOLEAN NOT NULL DEFAULT FALSE,
  main_category_code VARCHAR(100),
  process_url TEXT,
  content_hash VARCHAR(64),
  raw_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  source VARCHAR(80) NOT NULL DEFAULT 'SECOP_II',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE secop.processes
  ADD COLUMN IF NOT EXISTS portfolio_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS ppi VARCHAR(100),
  ADD COLUMN IF NOT EXISTS entity_order VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pci_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS phase VARCHAR(120),
  ADD COLUMN IF NOT EXISTS procurement_justification TEXT,
  ADD COLUMN IF NOT EXISTS process_status_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS award_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS duration_value NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(80),
  ADD COLUMN IF NOT EXISTS contracting_unit_city VARCHAR(120),
  ADD COLUMN IF NOT EXISTS contracting_unit_name TEXT,
  ADD COLUMN IF NOT EXISTS invited_suppliers INTEGER,
  ADD COLUMN IF NOT EXISTS suppliers_with_invitation INTEGER,
  ADD COLUMN IF NOT EXISTS views_count INTEGER,
  ADD COLUMN IF NOT EXISTS suppliers_expressed_interest INTEGER,
  ADD COLUMN IF NOT EXISTS procedure_responses INTEGER,
  ADD COLUMN IF NOT EXISTS external_responses INTEGER,
  ADD COLUMN IF NOT EXISTS offer_response_count INTEGER,
  ADD COLUMN IF NOT EXISTS unique_suppliers_with_responses INTEGER,
  ADD COLUMN IF NOT EXISTS lot_count INTEGER,
  ADD COLUMN IF NOT EXISTS phase_3_publication_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supplier_code VARCHAR(160),
  ADD COLUMN IF NOT EXISTS supplier_department VARCHAR(120),
  ADD COLUMN IF NOT EXISTS supplier_city VARCHAR(120),
  ADD COLUMN IF NOT EXISTS awarded_supplier_name TEXT,
  ADD COLUMN IF NOT EXISTS awarded_supplier_nit VARCHAR(50),
  ADD COLUMN IF NOT EXISTS total_awarded_value NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS contract_subtype VARCHAR(180),
  ADD COLUMN IF NOT EXISTS additional_categories TEXT,
  ADD COLUMN IF NOT EXISTS opening_status VARCHAR(100),
  ADD COLUMN IF NOT EXISTS summary_status VARCHAR(180);

CREATE INDEX IF NOT EXISTS idx_processes_publication_date ON secop.processes (publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_processes_response_deadline ON secop.processes (response_deadline);
CREATE INDEX IF NOT EXISTS idx_processes_department ON secop.processes (department);
CREATE INDEX IF NOT EXISTS idx_processes_updated_cursor ON secop.processes (updated_at, id);

CREATE TABLE IF NOT EXISTS saas.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  plan_code TEXT NOT NULL DEFAULT 'pilot',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE saas.organizations
  ADD COLUMN IF NOT EXISTS legal_name TEXT,
  ADD COLUMN IF NOT EXISTS tax_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS city VARCHAR(160),
  ADD COLUMN IF NOT EXISTS department VARCHAR(160),
  ADD COLUMN IF NOT EXISTS website TEXT;

CREATE TABLE IF NOT EXISTS saas.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_auth_id TEXT UNIQUE,
  email TEXT,
  full_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON saas.users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS saas.organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES saas.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS saas.search_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES saas.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  filter_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  notification_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS saas.search_profile_evaluation_state (
  profile_id UUID PRIMARY KEY REFERENCES saas.search_profiles(id) ON DELETE CASCADE,
  config_hash TEXT,
  cursor_timestamp TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  cursor_process_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  records_evaluated BIGINT NOT NULL DEFAULT 0,
  matches_created BIGINT NOT NULL DEFAULT 0,
  matches_updated BIGINT NOT NULL DEFAULT 0,
  matches_archived BIGINT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saas.process_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  search_profile_id UUID NOT NULL REFERENCES saas.search_profiles(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  match_score NUMERIC(5,2) NOT NULL DEFAULT 100,
  match_status TEXT NOT NULL DEFAULT 'new',
  matched_reasons JSONB NOT NULL DEFAULT '{}'::JSONB,
  process_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  first_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (search_profile_id, process_id)
);

CREATE INDEX IF NOT EXISTS idx_process_matches_org_status ON saas.process_matches (organization_id, match_status);
CREATE INDEX IF NOT EXISTS idx_process_matches_profile ON saas.process_matches (search_profile_id, last_matched_at DESC);

CREATE TABLE IF NOT EXISTS saas.organization_capability_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Perfil empresarial principal',
  company_summary TEXT,
  economic_activities JSONB NOT NULL DEFAULT '[]'::JSONB,
  products_services JSONB NOT NULL DEFAULT '[]'::JSONB,
  unspsc_codes JSONB NOT NULL DEFAULT '[]'::JSONB,
  procurement_methods JSONB NOT NULL DEFAULT '[]'::JSONB,
  contract_types JSONB NOT NULL DEFAULT '[]'::JSONB,
  service_departments JSONB NOT NULL DEFAULT '[]'::JSONB,
  service_cities JSONB NOT NULL DEFAULT '[]'::JSONB,
  minimum_contract_value NUMERIC(20,2),
  maximum_contract_value NUMERIC(20,2),
  years_experience NUMERIC(8,2),
  legal_capabilities JSONB NOT NULL DEFAULT '{}'::JSONB,
  financial_capabilities JSONB NOT NULL DEFAULT '{}'::JSONB,
  technical_capabilities JSONB NOT NULL DEFAULT '{}'::JSONB,
  certifications JSONB NOT NULL DEFAULT '[]'::JSONB,
  relevant_experience JSONB NOT NULL DEFAULT '[]'::JSONB,
  available_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
  exclusions JSONB NOT NULL DEFAULT '[]'::JSONB,
  ai_instructions TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_ready_for_ai BOOLEAN NOT NULL DEFAULT FALSE,
  profile_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS saas.opportunity_ai_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  search_profile_id UUID REFERENCES saas.search_profiles(id) ON DELETE SET NULL,
  process_match_id UUID NOT NULL REFERENCES saas.process_matches(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  capability_profile_id UUID NOT NULL REFERENCES saas.organization_capability_profiles(id) ON DELETE CASCADE,
  analysis_version INTEGER NOT NULL DEFAULT 1,
  analysis_status TEXT NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  prompt_version TEXT,
  model_provider TEXT,
  model_name TEXT,
  compatibility_score NUMERIC(5,2),
  confidence_score NUMERIC(5,2),
  decision TEXT,
  executive_summary TEXT,
  analysis_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  raw_model_output JSONB NOT NULL DEFAULT '{}'::JSONB,
  process_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  capability_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  human_decision TEXT,
  human_notes TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (process_match_id, capability_profile_id, input_hash)
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_queue ON saas.opportunity_ai_analyses (analysis_status, priority DESC, queued_at);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_org_process ON saas.opportunity_ai_analyses (organization_id, process_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS secop.process_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_document_id TEXT NOT NULL UNIQUE,
  process_id UUID REFERENCES secop.processes(id) ON DELETE CASCADE,
  secop_portfolio_id TEXT,
  contract_number TEXT,
  file_name TEXT,
  file_size_bytes BIGINT,
  file_extension TEXT,
  description TEXT,
  uploaded_at TIMESTAMPTZ,
  entity_name TEXT,
  entity_nit TEXT,
  download_url JSONB NOT NULL DEFAULT '{}'::JSONB,
  download_url_text TEXT,
  download_policy TEXT NOT NULL DEFAULT 'metadata_only',
  relevance_status TEXT NOT NULL DEFAULT 'pending',
  download_status TEXT NOT NULL DEFAULT 'not_requested',
  extraction_status TEXT NOT NULL DEFAULT 'not_requested',
  raw_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_process_documents_process ON secop.process_documents (process_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS ops.sync_cursors (
  source_code VARCHAR(100) PRIMARY KEY,
  cursor_timestamp TIMESTAMPTZ,
  cursor_process_id VARCHAR(160),
  status VARCHAR(30) NOT NULL DEFAULT 'idle',
  active_execution_id TEXT,
  lock_acquired_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  records_processed BIGINT NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ops.sync_cursors
  ADD COLUMN IF NOT EXISTS active_execution_id TEXT,
  ADD COLUMN IF NOT EXISTS lock_acquired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ops.workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_code VARCHAR(100) NOT NULL,
  source_code VARCHAR(100),
  n8n_execution_id VARCHAR(100) NOT NULL UNIQUE,
  trigger_type VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  batches_processed INTEGER NOT NULL DEFAULT 0,
  records_read BIGINT NOT NULL DEFAULT 0,
  records_written BIGINT NOT NULL DEFAULT 0,
  cursor_start_timestamp TIMESTAMPTZ,
  cursor_start_process_id VARCHAR(160),
  cursor_end_timestamp TIMESTAMPTZ,
  cursor_end_process_id VARCHAR(160),
  completion_reason TEXT,
  error_node TEXT,
  error_message TEXT,
  error_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_org ON ops.workflow_runs ((metadata ->> 'organization_id'), started_at DESC);

CREATE TABLE IF NOT EXISTS saas.organization_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  capability_profile_id UUID REFERENCES saas.organization_capability_profiles(id) ON DELETE SET NULL,
  document_type TEXT NOT NULL,
  document_name TEXT NOT NULL,
  original_filename TEXT,
  description TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'pending',
  storage_bucket TEXT,
  storage_key TEXT,
  storage_url TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,
  file_hash_sha256 TEXT,
  issue_date DATE,
  expiration_date DATE,
  document_status TEXT NOT NULL DEFAULT 'uploaded',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  extraction_status TEXT NOT NULL DEFAULT 'not_requested',
  extracted_text TEXT,
  ai_classification JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  uploaded_by_user_id UUID REFERENCES saas.users(id) ON DELETE SET NULL,
  verified_by_user_id UUID REFERENCES saas.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  policy_validity_days INTEGER,
  alert_days_before INTEGER,
  renewal_due_date DATE,
  alert_due_date DATE,
  renewal_status TEXT NOT NULL DEFAULT 'not_configured',
  replaces_document_id UUID REFERENCES saas.organization_documents(id) ON DELETE SET NULL,
  replaced_by_document_id UUID REFERENCES saas.organization_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_document_hash ON saas.organization_documents (organization_id, file_hash_sha256)
  WHERE file_hash_sha256 IS NOT NULL AND document_status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_org_documents_org ON saas.organization_documents (organization_id, document_status, document_type);

CREATE TABLE IF NOT EXISTS saas.document_type_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES saas.organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  validity_days INTEGER,
  alert_days_before INTEGER NOT NULL DEFAULT 5,
  renewal_frequency TEXT NOT NULL DEFAULT 'on_demand',
  automation_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_global_document_policy ON saas.document_type_policies (document_type) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_document_policy ON saas.document_type_policies (organization_id, document_type) WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS saas.opportunity_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  opportunity_analysis_id UUID NOT NULL REFERENCES saas.opportunity_ai_analyses(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  process_document_id UUID NOT NULL REFERENCES secop.process_documents(id) ON DELETE CASCADE,
  process_reference TEXT,
  document_name TEXT NOT NULL,
  source_file_extension TEXT,
  source_download_url TEXT,
  source_file_size_bytes BIGINT,
  primary_category TEXT NOT NULL DEFAULT 'other',
  detected_categories JSONB NOT NULL DEFAULT '[]'::JSONB,
  relevant_for_analysis BOOLEAN NOT NULL DEFAULT FALSE,
  selected_for_download BOOLEAN NOT NULL DEFAULT FALSE,
  download_status TEXT NOT NULL DEFAULT 'not_requested',
  download_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_download_attempt_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  download_sha256 TEXT,
  downloaded_mime_type TEXT,
  downloaded_file_extension TEXT,
  downloaded_file_size_bytes BIGINT,
  download_error TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'not_requested',
  extraction_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_extraction_attempt_at TIMESTAMPTZ,
  extracted_at TIMESTAMPTZ,
  extraction_error TEXT,
  ai_requirement_status TEXT NOT NULL DEFAULT 'not_requested',
  ai_requirement_attempt_count INTEGER NOT NULL DEFAULT 0,
  ai_requirement_started_at TIMESTAMPTZ,
  ai_requirement_finished_at TIMESTAMPTZ,
  ai_requirement_error TEXT,
  ai_requirement_model TEXT,
  ai_requirement_prompt_version INTEGER NOT NULL DEFAULT 1,
  ai_requirement_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, opportunity_analysis_id, process_document_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_documents_extract_queue ON saas.opportunity_documents (extraction_status, extraction_attempt_count, updated_at);

CREATE TABLE IF NOT EXISTS saas.opportunity_document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_document_id UUID NOT NULL REFERENCES saas.opportunity_documents(id) ON DELETE CASCADE,
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extractor TEXT NOT NULL,
  extraction_status TEXT NOT NULL DEFAULT 'extracted',
  text_content TEXT,
  text_sha256 TEXT,
  character_count INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER,
  structured_content JSONB NOT NULL DEFAULT '{}'::JSONB,
  extraction_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_document_id, extraction_version)
);

CREATE TABLE IF NOT EXISTS saas.opportunity_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES saas.organizations(id) ON DELETE CASCADE,
  opportunity_analysis_id UUID REFERENCES saas.opportunity_ai_analyses(id) ON DELETE CASCADE,
  process_id UUID REFERENCES secop.processes(id) ON DELETE CASCADE,
  opportunity_document_id UUID REFERENCES saas.opportunity_documents(id) ON DELETE CASCADE,
  extraction_id UUID REFERENCES saas.opportunity_document_extractions(id) ON DELETE SET NULL,
  requirement_code TEXT,
  category TEXT,
  requirement_category VARCHAR(80) NOT NULL DEFAULT 'other',
  requirement_name TEXT NOT NULL,
  normalized_document_type VARCHAR(120),
  requirement_description TEXT,
  mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  condition_text TEXT,
  maximum_age_days INTEGER,
  requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
  requires_entity_template BOOLEAN NOT NULL DEFAULT FALSE,
  requires_original BOOLEAN NOT NULL DEFAULT FALSE,
  requires_notarization BOOLEAN NOT NULL DEFAULT FALSE,
  requires_translation BOOLEAN NOT NULL DEFAULT FALSE,
  applies_to VARCHAR(100),
  requirement_stage TEXT,
  is_bid_requirement BOOLEAN NOT NULL DEFAULT TRUE,
  source_document_name TEXT,
  source_reference TEXT,
  source_page INTEGER,
  source_section TEXT,
  evidence_text TEXT,
  confidence_score NUMERIC(5,4),
  extraction_version INTEGER NOT NULL DEFAULT 1,
  requirement_hash_sha256 CHAR(64) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  requirement_status TEXT NOT NULL DEFAULT 'pending',
  risk_level TEXT NOT NULL DEFAULT 'medium',
  due_at TIMESTAMPTZ,
  ai_model TEXT,
  ai_assessment JSONB NOT NULL DEFAULT '{}'::JSONB,
  human_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunity_document_requirement ON saas.opportunity_requirements
  (opportunity_document_id, requirement_hash_sha256, extraction_version);
CREATE INDEX IF NOT EXISTS idx_opportunity_requirements_process ON saas.opportunity_requirements (organization_id, process_id, status);

CREATE TABLE IF NOT EXISTS saas.opportunity_requirement_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_requirement_id UUID NOT NULL REFERENCES saas.opportunity_requirements(id) ON DELETE CASCADE,
  organization_document_id UUID NOT NULL REFERENCES saas.organization_documents(id) ON DELETE CASCADE,
  match_status TEXT NOT NULL DEFAULT 'suggested',
  match_score NUMERIC(5,2),
  match_reason TEXT,
  ai_assessment JSONB NOT NULL DEFAULT '{}'::JSONB,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_requirement_id, organization_document_id)
);

CREATE TABLE IF NOT EXISTS saas.opportunity_requirement_matrices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  opportunity_analysis_id UUID NOT NULL REFERENCES saas.opportunity_ai_analyses(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  process_reference TEXT,
  matrix_version INTEGER NOT NULL DEFAULT 1,
  consolidation_version INTEGER NOT NULL DEFAULT 1,
  consolidation_method TEXT NOT NULL DEFAULT 'deterministic_v1',
  input_hash_sha256 CHAR(64) NOT NULL,
  matrix_status TEXT NOT NULL DEFAULT 'building',
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  source_document_count INTEGER NOT NULL DEFAULT 0,
  source_requirement_count INTEGER NOT NULL DEFAULT 0,
  consolidated_requirement_count INTEGER NOT NULL DEFAULT 0,
  bid_requirement_count INTEGER NOT NULL DEFAULT 0,
  non_bid_requirement_count INTEGER NOT NULL DEFAULT 0,
  conditional_requirement_count INTEGER NOT NULL DEFAULT 0,
  review_required_count INTEGER NOT NULL DEFAULT 0,
  n8n_execution_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, opportunity_analysis_id, input_hash_sha256, consolidation_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_current_requirement_matrix ON saas.opportunity_requirement_matrices
  (organization_id, opportunity_analysis_id) WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS saas.opportunity_requirement_matrix_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id UUID NOT NULL REFERENCES saas.opportunity_requirement_matrices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  opportunity_analysis_id UUID NOT NULL REFERENCES saas.opportunity_ai_analyses(id) ON DELETE CASCADE,
  process_id UUID NOT NULL REFERENCES secop.processes(id) ON DELETE CASCADE,
  canonical_requirement_key CHAR(64) NOT NULL,
  requirement_category TEXT NOT NULL,
  requirement_name TEXT NOT NULL,
  normalized_document_type TEXT,
  requirement_description TEXT,
  mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  condition_text TEXT,
  maximum_age_days INTEGER,
  requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
  requires_entity_template BOOLEAN NOT NULL DEFAULT FALSE,
  requires_original BOOLEAN NOT NULL DEFAULT FALSE,
  requires_notarization BOOLEAN NOT NULL DEFAULT FALSE,
  requires_translation BOOLEAN NOT NULL DEFAULT FALSE,
  applies_to TEXT,
  requirement_stage TEXT,
  is_bid_requirement BOOLEAN NOT NULL DEFAULT TRUE,
  confidence_score NUMERIC(5,4),
  source_requirement_count INTEGER NOT NULL DEFAULT 0,
  source_document_count INTEGER NOT NULL DEFAULT 0,
  conflict_status TEXT NOT NULL DEFAULT 'none',
  conflict_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  review_reason TEXT,
  item_status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (matrix_id, canonical_requirement_key)
);

CREATE TABLE IF NOT EXISTS saas.opportunity_requirement_matrix_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_item_id UUID NOT NULL REFERENCES saas.opportunity_requirement_matrix_items(id) ON DELETE CASCADE,
  opportunity_requirement_id UUID NOT NULL REFERENCES saas.opportunity_requirements(id) ON DELETE CASCADE,
  opportunity_document_id UUID NOT NULL REFERENCES saas.opportunity_documents(id) ON DELETE CASCADE,
  source_rank SMALLINT NOT NULL DEFAULT 1,
  source_priority SMALLINT NOT NULL DEFAULT 0,
  is_primary_source BOOLEAN NOT NULL DEFAULT FALSE,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (matrix_item_id, opportunity_requirement_id)
);

INSERT INTO ops.sync_cursors (source_code, cursor_timestamp, cursor_process_id, status)
VALUES
  ('SECOP_II_PROCESSES', NULL, NULL, 'idle'),
  ('SECOP_II_PROCESS_VERSIONS', NULL, NULL, 'idle'),
  ('SECOP_II_DOCUMENT_METADATA', NULL, NULL, 'idle'),
  ('SECOP_PROFILE_MATCHING', NULL, NULL, 'idle'),
  ('SECOP_ORGANIZATION_DOCUMENT_VALIDITY', NULL, NULL, 'idle'),
  ('SECOP_OPPORTUNITY_DOCUMENT_EXTRACTION', NULL, NULL, 'idle'),
  ('SECOP_OPPORTUNITY_REQUIREMENT_EXTRACTION', NULL, NULL, 'idle'),
  ('SECOP_OPPORTUNITY_REQUIREMENT_CONSOLIDATION', NULL, NULL, 'idle'),
  ('SECOP_OPPORTUNITY_COMPLIANCE_EVALUATION', NULL, NULL, 'idle'),
  ('SECOP_OPPORTUNITY_ACTION_PLAN_GENERATION', NULL, NULL, 'idle'),
  ('SECOP_PIPELINE_ORCHESTRATION', NULL, NULL, 'idle')
ON CONFLICT (source_code) DO NOTHING;

COMMIT;
