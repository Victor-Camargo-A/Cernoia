BEGIN;
CREATE OR REPLACE FUNCTION saas.founder_availability()
RETURNS TABLE(assigned integer,available integer,confirmed integer,reserved integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH confirmed_slots AS (SELECT DISTINCT founder_number FROM saas.subscriptions WHERE founder_number IS NOT NULL),
reserved_slots AS (SELECT DISTINCT founder_number FROM saas.billing_orders WHERE founder_number IS NOT NULL
 AND status IN ('draft','link_created','pending') AND expires_at>NOW()
 AND founder_number NOT IN(SELECT founder_number FROM confirmed_slots)),
counts AS (SELECT (SELECT COUNT(*)::integer FROM confirmed_slots) c,(SELECT COUNT(*)::integer FROM reserved_slots) r)
SELECT c+r,GREATEST(0,100-c-r),c,r FROM counts;
$$;
CREATE OR REPLACE FUNCTION saas.next_founder_slot() RETURNS TABLE(number integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT n FROM generate_series(1,100) n WHERE NOT EXISTS(SELECT 1 FROM saas.subscriptions s WHERE s.founder_number=n)
 AND NOT EXISTS(SELECT 1 FROM saas.billing_orders b WHERE b.founder_number=n AND b.status IN ('draft','link_created','pending') AND b.expires_at>NOW()) ORDER BY n LIMIT 1;
$$;
REVOKE ALL ON FUNCTION saas.founder_availability() FROM PUBLIC;
REVOKE ALL ON FUNCTION saas.next_founder_slot() FROM PUBLIC;
COMMIT;
