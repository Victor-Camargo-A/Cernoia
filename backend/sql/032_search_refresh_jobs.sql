CREATE TABLE IF NOT EXISTS saas.search_refresh_jobs (
 organization_id uuid PRIMARY KEY REFERENCES saas.organizations(id),
 requested_revision bigint NOT NULL DEFAULT 1, processed_revision bigint NOT NULL DEFAULT 0,
 cursor_id uuid, status text NOT NULL DEFAULT 'queued', locked_until timestamptz, lease_token uuid,
 next_attempt_at timestamptz NOT NULL DEFAULT NOW(), last_error text, updated_at timestamptz NOT NULL DEFAULT NOW()
);

GRANT SELECT,INSERT,UPDATE ON saas.search_refresh_jobs TO cernoia_app;
