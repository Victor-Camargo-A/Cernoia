BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS saas.campaign_settings(
 id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),owner_admin_id UUID REFERENCES saas.platform_admin_users(id),
 sender_email TEXT NOT NULL DEFAULT 'director@energeticanika.com',sender_name TEXT NOT NULL DEFAULT 'CernoIA',
 smtp_host TEXT NOT NULL DEFAULT 'smtp.hostinger.com',smtp_port INTEGER NOT NULL DEFAULT 465,
 password_box JSONB,provider_daily_limit INTEGER NOT NULL DEFAULT 1000 CHECK(provider_daily_limit BETWEEN 1 AND 100000),
 daily_limit INTEGER NOT NULL DEFAULT 1000 CHECK(daily_limit BETWEEN 1 AND 100000),reserved_daily INTEGER NOT NULL DEFAULT 100 CHECK(reserved_daily>=0),
 minimum_gap_days INTEGER NOT NULL DEFAULT 2 CHECK(minimum_gap_days BETWEEN 2 AND 365),
 sending_enabled BOOLEAN NOT NULL DEFAULT FALSE,smtp_verified_at TIMESTAMPTZ,limits_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
 imap_host TEXT NOT NULL DEFAULT 'imap.hostinger.com',imap_folder TEXT NOT NULL DEFAULT 'INBOX',imap_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 imap_uid_validity TEXT,imap_last_uid BIGINT NOT NULL DEFAULT 0,last_feedback_at TIMESTAMPTZ,last_run_at TIMESTAMPTZ,last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO saas.campaign_settings(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS saas.campaign_lists(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,source_note TEXT NOT NULL,
 permission_confirmed BOOLEAN NOT NULL DEFAULT FALSE,created_by UUID REFERENCES saas.platform_admin_users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saas.campaign_contacts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),email TEXT NOT NULL UNIQUE CHECK(email=LOWER(email)),company_name TEXT NOT NULL DEFAULT '',contact_name TEXT NOT NULL DEFAULT '',
 suppression TEXT CHECK(suppression IN ('unsubscribe','hard_bounce','complaint','manual','uncertain','blocked')),suppressed_at TIMESTAMPTZ,
 last_attempt_at TIMESTAMPTZ,last_sent_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saas.campaign_list_contacts(
 list_id UUID NOT NULL REFERENCES saas.campaign_lists(id) ON DELETE CASCADE,contact_id UUID NOT NULL REFERENCES saas.campaign_contacts(id) ON DELETE CASCADE,
 PRIMARY KEY(list_id,contact_id)
);
CREATE TABLE IF NOT EXISTS saas.email_campaigns(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),list_id UUID NOT NULL REFERENCES saas.campaign_lists(id),name TEXT NOT NULL,
 subject TEXT NOT NULL,body_text TEXT NOT NULL,cta_label TEXT NOT NULL DEFAULT 'Conocer CernoIA',cta_url TEXT NOT NULL DEFAULT 'https://cernoia.secretbloom.tech/planes',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed')),repeat_days INTEGER CHECK(repeat_days BETWEEN 2 AND 365),
 track_opens BOOLEAN NOT NULL DEFAULT TRUE,track_clicks BOOLEAN NOT NULL DEFAULT TRUE,
 created_by UUID REFERENCES saas.platform_admin_users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_dispatched_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS saas.campaign_deliveries(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id UUID NOT NULL REFERENCES saas.email_campaigns(id),contact_id UUID NOT NULL REFERENCES saas.campaign_contacts(id),
 email TEXT NOT NULL,company_name TEXT NOT NULL,subject TEXT NOT NULL,body_text TEXT NOT NULL,cta_label TEXT NOT NULL,cta_url TEXT NOT NULL,
 tracking_token TEXT NOT NULL UNIQUE,track_opens BOOLEAN NOT NULL,track_clicks BOOLEAN NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('sending','accepted','delivered','deferred','bounced','rejected','uncertain')),
 message_id TEXT NOT NULL UNIQUE,smtp_response TEXT,error_code TEXT,diagnostic TEXT,
 attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),accepted_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,bounced_at TIMESTAMPTZ,
 opened_at TIMESTAMPTZ,clicked_at TIMESTAMPTZ,unsubscribed_at TIMESTAMPTZ,complaint_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS campaign_deliveries_budget ON saas.campaign_deliveries(attempted_at DESC);
CREATE INDEX IF NOT EXISTS campaign_deliveries_contact ON saas.campaign_deliveries(contact_id,campaign_id,attempted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_deliveries_inflight ON saas.campaign_deliveries(contact_id) WHERE status='sending';
CREATE TABLE IF NOT EXISTS saas.campaign_events(
 id BIGSERIAL PRIMARY KEY,delivery_id UUID NOT NULL REFERENCES saas.campaign_deliveries(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,details JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Platform-only tables. Tenant data access must never grant ownership access.
DO $$ DECLARE r TEXT;t TEXT;BEGIN
 FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema='saas' AND table_name='platform_admin_users' AND privilege_type='SELECT' AND grantee NOT IN ('PUBLIC','postgres') LOOP
  FOREACH t IN ARRAY ARRAY['campaign_settings','campaign_lists','campaign_contacts','campaign_list_contacts','email_campaigns','campaign_deliveries','campaign_events'] LOOP
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.%I TO %I',t,r);
  END LOOP;
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE saas.campaign_events_id_seq TO %I',r);
 END LOOP;
END $$;
COMMIT;
