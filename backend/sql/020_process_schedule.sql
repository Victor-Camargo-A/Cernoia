BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='180s';
CREATE OR REPLACE FUNCTION secop.parse_source_datetime(value TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})?)?$' THEN RETURN NULL; END IF;
 IF value ~ '(Z|[+-]\d{2}:\d{2})$' THEN RETURN value::timestamptz; END IF;
 RETURN value::timestamp AT TIME ZONE 'America/Bogota';
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION secop.deadline_passed(deadline TIMESTAMPTZ, original TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT CASE WHEN deadline IS NULL THEN FALSE
 WHEN original ~ '^\d{4}-\d{2}-\d{2}(T00:00:00([.]0+)?)?$'
 THEN left(original,10)::date < (NOW() AT TIME ZONE 'America/Bogota')::date
 ELSE deadline <= NOW() END
$$;
CREATE OR REPLACE FUNCTION secop.normalize_process_schedule()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_url TEXT;
BEGIN
 -- Preserve a source's removal of a deadline; do not carry stale dates across adendas.
 IF NEW.raw_json ? 'id_del_proceso' THEN
  NEW.response_deadline:=secop.parse_source_datetime(NEW.raw_json->>'fecha_de_recepcion_de');
 END IF;
 source_url:=COALESCE(NEW.raw_json->'urlproceso'->>'url',CASE WHEN jsonb_typeof(NEW.raw_json->'urlproceso')='string' THEN NEW.raw_json->>'urlproceso' END);
 IF source_url ~ '^https://community[.]secop[.]gov[.]co/Public/' THEN NEW.process_url:=source_url; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS normalize_process_schedule ON secop.processes;
CREATE TRIGGER normalize_process_schedule BEFORE INSERT OR UPDATE OF raw_json,response_deadline,process_url ON secop.processes FOR EACH ROW EXECUTE FUNCTION secop.normalize_process_schedule();
-- Recover original source values without touching publication dates or match/user state.
UPDATE secop.processes SET
 response_deadline=secop.parse_source_datetime(raw_json->>'fecha_de_recepcion_de'),
 process_url=CASE WHEN raw_json->'urlproceso'->>'url' ~ '^https://community[.]secop[.]gov[.]co/Public/' THEN raw_json->'urlproceso'->>'url' ELSE process_url END
WHERE raw_json ? 'id_del_proceso' AND (
 response_deadline IS DISTINCT FROM secop.parse_source_datetime(raw_json->>'fecha_de_recepcion_de')
 OR (process_url='[object Object]' AND raw_json->'urlproceso'->>'url' ~ '^https://community[.]secop[.]gov[.]co/Public/')
);
-- Keep today's date-only deadlines visible until the published calendar day has passed.
DO $$ DECLARE definition TEXT;
BEGIN
 SELECT pg_get_functiondef('saas.process_matches_filters(jsonb,jsonb)'::regprocedure) INTO definition;
 IF position('NULLIF(p->>''response_deadline'','''')::timestamptz<NOW()' IN definition)=0 THEN
  IF position('secop.deadline_passed' IN definition)>0 THEN RETURN; END IF;
  RAISE EXCEPTION 'Unexpected process filter version';
 END IF;
 definition:=replace(definition,'NULLIF(p->>''response_deadline'','''')::timestamptz<NOW()', 'secop.deadline_passed(NULLIF(p->>''response_deadline'','''')::timestamptz,p->''raw_json''->>''fecha_de_recepcion_de'')');
 EXECUTE definition;
END $$;
COMMIT;
