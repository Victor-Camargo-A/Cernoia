BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE saas.campaign_settings ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL;
COMMIT;
