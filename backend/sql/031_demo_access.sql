BEGIN;

ALTER TABLE saas.organizations
  ADD COLUMN IF NOT EXISTS demo_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS demo_postulation_process_id UUID REFERENCES secop.processes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS demo_postulation_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_organizations_demo_process
  ON saas.organizations (demo_postulation_process_id)
  WHERE demo_postulation_process_id IS NOT NULL;

UPDATE saas.organizations organization
SET demo_postulation_process_id = state.process_id,
    demo_postulation_started_at = COALESCE(organization.demo_postulation_started_at, state.updated_at)
FROM (
  SELECT DISTINCT ON (opportunity_state.organization_id)
         opportunity_state.organization_id,
         opportunity_state.process_id,
         opportunity_state.updated_at
  FROM saas.app_opportunity_states opportunity_state
  WHERE opportunity_state.stage = 'submitted'
  ORDER BY opportunity_state.organization_id, opportunity_state.updated_at ASC
) state
WHERE state.organization_id = organization.id
  AND organization.demo_postulation_process_id IS NULL;

COMMIT;
