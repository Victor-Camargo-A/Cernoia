BEGIN;
CREATE TABLE IF NOT EXISTS saas.youtube_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), credentials jsonb, tokens jsonb,
 channel_id text, channel_title text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO saas.youtube_settings(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS saas.youtube_oauth_states (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, admin_id uuid NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS saas.youtube_videos (
 id text PRIMARY KEY, metadata jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'draft', reviewed_by uuid, reviewed_at timestamptz,
 upload_session jsonb, youtube_id text UNIQUE, actual_privacy text, target_channel_id text,
 thumbnail_status text NOT NULL DEFAULT 'local', attempts integer NOT NULL DEFAULT 0,
 next_attempt timestamptz NOT NULL DEFAULT now(), last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON saas.youtube_settings, saas.youtube_oauth_states, saas.youtube_videos TO cernoia_app;
COMMIT;
