BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION secop.normalize_process_schedule()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_url TEXT;
BEGIN
 IF NEW.raw_json ? 'id_del_proceso' THEN NEW.response_deadline:=secop.parse_source_datetime(NEW.raw_json->>'fecha_de_recepcion_de'); END IF;
 source_url:=COALESCE(NEW.raw_json->'urlproceso'->>'url',CASE WHEN jsonb_typeof(NEW.raw_json->'urlproceso')='string' THEN NEW.raw_json->>'urlproceso' END);
 IF source_url ~ '^https://community[.]secop[.]gov[.]co/Public/' THEN NEW.process_url:=source_url;
 ELSIF NEW.process_url='[object Object]' THEN NEW.process_url:=NULL; END IF;
 RETURN NEW;
END $$;
UPDATE secop.processes SET process_url=NULL WHERE process_url='[object Object]';
COMMIT;
