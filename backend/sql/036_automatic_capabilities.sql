ALTER TABLE saas.organization_capability_profiles ADD COLUMN IF NOT EXISTS matrix_field_modes jsonb NOT NULL DEFAULT '{}';
