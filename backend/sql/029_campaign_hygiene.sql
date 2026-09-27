BEGIN;
SET LOCAL lock_timeout='10s';
ALTER TABLE saas.campaign_contacts ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'unchecked' CHECK(quality_status IN ('unchecked','valid','invalid','review','pending'));
ALTER TABLE saas.campaign_contacts ADD COLUMN IF NOT EXISTS quality_reason text;
ALTER TABLE saas.campaign_contacts ADD COLUMN IF NOT EXISTS email_suggestion text;
ALTER TABLE saas.campaign_contacts ADD COLUMN IF NOT EXISTS email_checked_at timestamptz;
CREATE TABLE IF NOT EXISTS saas.campaign_contact_exclusions(email_hash text PRIMARY KEY,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW());
ALTER TABLE saas.campaign_deliveries ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE saas.campaign_deliveries DROP CONSTRAINT IF EXISTS campaign_deliveries_contact_id_fkey;
ALTER TABLE saas.campaign_deliveries ADD CONSTRAINT campaign_deliveries_contact_id_fkey FOREIGN KEY(contact_id) REFERENCES saas.campaign_contacts(id) ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION saas.campaign_remember_deleted_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO saas.campaign_contact_exclusions(email_hash,reason) VALUES(encode(sha256(convert_to(lower(trim(OLD.email)),'UTF8')),'hex'),COALESCE(OLD.suppression,'removed')) ON CONFLICT DO NOTHING;
 RETURN OLD;
END;$$;
DROP TRIGGER IF EXISTS campaign_remember_deleted_contact ON saas.campaign_contacts;
CREATE TRIGGER campaign_remember_deleted_contact BEFORE DELETE ON saas.campaign_contacts FOR EACH ROW EXECUTE FUNCTION saas.campaign_remember_deleted_contact();
CREATE OR REPLACE FUNCTION saas.campaign_prevent_reimport() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM saas.campaign_contact_exclusions WHERE email_hash=encode(sha256(convert_to(lower(trim(NEW.email)),'UTF8')),'hex')) THEN RETURN NULL; END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS campaign_prevent_reimport ON saas.campaign_contacts;
CREATE TRIGGER campaign_prevent_reimport BEFORE INSERT OR UPDATE OF email ON saas.campaign_contacts FOR EACH ROW EXECUTE FUNCTION saas.campaign_prevent_reimport();
CREATE OR REPLACE FUNCTION saas.campaign_remove_bounced_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.contact_id IS NOT NULL THEN
  UPDATE saas.campaign_contacts SET suppression='hard_bounce',suppressed_at=COALESCE(suppressed_at,NOW()) WHERE id=NEW.contact_id;
  DELETE FROM saas.campaign_contacts WHERE id=NEW.contact_id;
 END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS campaign_remove_bounced_contact ON saas.campaign_deliveries;
CREATE TRIGGER campaign_remove_bounced_contact AFTER INSERT OR UPDATE OF status ON saas.campaign_deliveries FOR EACH ROW WHEN(NEW.status='bounced') EXECUTE FUNCTION saas.campaign_remove_bounced_contact();
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema='saas' AND table_name='campaign_contacts' AND privilege_type='SELECT' AND grantee NOT IN ('PUBLIC','postgres') LOOP
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.campaign_contact_exclusions TO %I',r);
 END LOOP;
END;$$;
COMMIT;
