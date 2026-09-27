ALTER TABLE saas.campaign_lists ADD COLUMN IF NOT EXISTS provider_only boolean NOT NULL DEFAULT FALSE;
ALTER TABLE saas.campaign_import_jobs ADD COLUMN IF NOT EXISTS excluded_rows integer NOT NULL DEFAULT 0;
