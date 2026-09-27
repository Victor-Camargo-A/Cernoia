CREATE TABLE IF NOT EXISTS saas.opportunity_preparations (
 organization_id uuid NOT NULL REFERENCES saas.organizations(id),process_id uuid NOT NULL REFERENCES secop.processes(id),
 requested_by_user_id uuid REFERENCES saas.app_users(id),status text NOT NULL DEFAULT 'queued',matrix_id uuid,analysis_id uuid,
 requested_at timestamptz NOT NULL DEFAULT NOW(),updated_at timestamptz NOT NULL DEFAULT NOW(),next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
 last_error text,attempts int NOT NULL DEFAULT 0,PRIMARY KEY(organization_id,process_id)
);
GRANT SELECT,INSERT,UPDATE ON saas.opportunity_preparations TO cernoia_app;
