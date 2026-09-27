CREATE TABLE IF NOT EXISTS secop.unspsc_catalog(code text PRIMARY KEY CHECK(code ~ '^\d{8}$'),label text NOT NULL,version text NOT NULL,source_url text NOT NULL,search_terms tsvector GENERATED ALWAYS AS (to_tsvector('spanish',label)) STORED);
CREATE INDEX IF NOT EXISTS idx_unspsc_catalog_search ON secop.unspsc_catalog USING gin(search_terms);
CREATE TABLE IF NOT EXISTS saas.company_unspsc_classifications(organization_id uuid PRIMARY KEY REFERENCES saas.organizations(id),input_hash text NOT NULL,facts jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',suggestions jsonb NOT NULL DEFAULT '[]',next_attempt_at timestamptz NOT NULL DEFAULT NOW(),last_error text,updated_at timestamptz NOT NULL DEFAULT NOW());
GRANT SELECT ON secop.unspsc_catalog TO cernoia_app;
GRANT SELECT,INSERT,UPDATE ON saas.company_unspsc_classifications TO cernoia_app;
