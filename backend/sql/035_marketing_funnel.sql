BEGIN;
ALTER TABLE saas.campaign_contacts ADD COLUMN IF NOT EXISTS attribution_cid uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_contact_cid ON saas.campaign_contacts(attribution_cid) WHERE attribution_cid IS NOT NULL;
CREATE TABLE IF NOT EXISTS saas.marketing_tracking_settings (id boolean PRIMARY KEY DEFAULT TRUE CHECK(id), started_at timestamptz NOT NULL DEFAULT NOW());
INSERT INTO saas.marketing_tracking_settings(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS saas.marketing_visitors (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT NOW(),
 campaign_id uuid, cid uuid, delivery_id uuid, utm_source text, utm_medium text, utm_campaign text
);
CREATE TABLE IF NOT EXISTS saas.marketing_organizations (
 organization_id uuid PRIMARY KEY REFERENCES saas.organizations(id), visitor_id uuid NOT NULL REFERENCES saas.marketing_visitors(id),
 created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saas.marketing_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_key text NOT NULL UNIQUE,
 event_name text NOT NULL CHECK(event_name IN ('landing_visited','demo_started','signup_started','signup_completed','demo_completed','checkout_started','purchase')),
 visitor_id uuid, organization_id uuid, campaign_id uuid, cid uuid, delivery_id uuid,
 analysis_id uuid, order_id uuid, value numeric(16,2), currency text,
 is_test boolean NOT NULL DEFAULT FALSE, created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_events_campaign ON saas.marketing_events(campaign_id,event_name,created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_events_org ON saas.marketing_events(organization_id,event_name);
ALTER TABLE saas.billing_orders ADD COLUMN IF NOT EXISTS marketing_is_test boolean NOT NULL DEFAULT TRUE;
CREATE OR REPLACE FUNCTION saas.capture_marketing_conversion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
DECLARE event text; key text; org uuid; oid uuid; amount numeric; curr text; test_payment boolean := FALSE;
BEGIN
 IF TG_TABLE_NAME='organizations' THEN
  IF NEW.demo_enabled IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;
  event:='signup_completed'; org:=NEW.id; key:=event||':'||org::text;
 ELSE
  org:=NEW.organization_id;oid:=NEW.id;amount:=NEW.amount_cop;curr:=NEW.currency;test_payment:=NEW.marketing_is_test;
  IF NEW.status='approved' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN event:='purchase';
  ELSIF NEW.checkout_url IS NOT NULL AND NEW.status IN ('link_created','pending') AND (TG_OP='INSERT' OR OLD.checkout_url IS NULL) THEN event:='checkout_started';
  ELSE RETURN NEW; END IF;
  key:=event||':'||oid::text;
 END IF;
 INSERT INTO saas.marketing_events(event_key,event_name,organization_id,visitor_id,campaign_id,cid,delivery_id,order_id,value,currency,is_test)
 SELECT key,event,org,v.id,v.campaign_id,v.cid,v.delivery_id,oid,amount,curr,test_payment
 FROM (SELECT 1) anchor LEFT JOIN saas.marketing_organizations a ON a.organization_id=org LEFT JOIN saas.marketing_visitors v ON v.id=a.visitor_id
 ON CONFLICT(event_key) DO NOTHING;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 -- Analytics must not interrupt account creation or a verified payment.
 RAISE WARNING 'Marketing conversion could not be recorded: %',SQLSTATE;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER marketing_signup AFTER INSERT ON saas.organizations FOR EACH ROW EXECUTE FUNCTION saas.capture_marketing_conversion();
CREATE OR REPLACE TRIGGER marketing_billing AFTER INSERT OR UPDATE OF status,checkout_url ON saas.billing_orders FOR EACH ROW EXECUTE FUNCTION saas.capture_marketing_conversion();
REVOKE ALL ON FUNCTION saas.capture_marketing_conversion() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON saas.marketing_visitors,saas.marketing_organizations,saas.marketing_events TO cernoia_app;
GRANT SELECT ON saas.marketing_tracking_settings TO cernoia_app;
GRANT USAGE,SELECT ON SEQUENCE saas.marketing_events_id_seq TO cernoia_app;
COMMIT;
