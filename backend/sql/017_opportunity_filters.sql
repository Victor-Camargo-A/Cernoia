BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION saas.service_term_matches(document TEXT, term TEXT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
 WITH terms AS (
  SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('spanish', COALESCE(term,'')))) AS word
 ), meaningful AS (
  SELECT word FROM terms WHERE length(word)>=3 AND word NOT IN
   ('suministr','servici','realiz','implement','basic','tecnic','apoy','activ','solucion','sistem')
 ), hits AS (
  SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE word=ANY(tsvector_to_array(to_tsvector('spanish',COALESCE(document,''))))) AS matched FROM meaningful
 ) SELECT total>0 AND matched>=CEIL(total*0.5) FROM hits
$$;
CREATE OR REPLACE FUNCTION saas.unspsc_digits(value TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
 SELECT regexp_replace(regexp_replace(COALESCE(value,''),'^V[0-9]+[.]','','i'),'[^0-9]','','g')
$$;
CREATE OR REPLACE FUNCTION saas.process_matches_filters(p JSONB, f JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE field_name TEXT; process_field TEXT; terms JSONB; text_value TEXT;
 minimum_value NUMERIC; maximum_value NUMERIC; price NUMERIC;
BEGIN
 f:=COALESCE(f,'{}');
 FOR field_name,process_field IN SELECT * FROM (VALUES
  ('procurement_methods','procurement_method'),('process_statuses','process_status'),
  ('departments','department'),('cities','city'),('contract_types','contract_type')) fields LOOP
  terms:=COALESCE(NULLIF(f->field_name,'null'::jsonb),'[]');
  IF jsonb_array_length(terms)>0 AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements_text(terms) t
   WHERE trim(saas.match_text(t))=trim(saas.match_text(p->>process_field))
    OR (field_name='departments' AND trim(saas.match_text(t)) IN ('nacional','cobertura nacional','todo el pais','colombia'))
  ) THEN RETURN FALSE; END IF;
 END LOOP;
 terms:=COALESCE(NULLIF(f->'unspsc_codes','null'::jsonb),'[]');
 IF jsonb_array_length(terms)>0 AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(terms) t WHERE length(saas.unspsc_digits(t))>=2
   AND saas.unspsc_digits(COALESCE(p->>'main_category_code',p->'raw_json'->>'codigo_principal_de_categoria')) LIKE saas.unspsc_digits(t)||'%'
 ) THEN RETURN FALSE; END IF;
 minimum_value:=NULLIF(f->>'minimum_budget','')::numeric;
 maximum_value:=NULLIF(f->>'maximum_budget','')::numeric;
 price:=NULLIF(p->>'base_price','')::numeric;
 IF (minimum_value IS NOT NULL OR maximum_value IS NOT NULL) AND price IS NULL THEN RETURN FALSE; END IF;
 IF price<minimum_value OR price>maximum_value THEN RETURN FALSE; END IF;
 IF COALESCE((f->>'only_open')::boolean,FALSE) AND (
  COALESCE((p->>'awarded')::boolean,FALSE) OR NULLIF(p->>'response_deadline','')::timestamptz<NOW()
  OR saas.match_text(p->>'process_status') ~ '(cancelad|adjudicad|terminad|cerrad)'
  OR saas.match_text(p->>'opening_status') ~ '(cerrad)'
 ) THEN RETURN FALSE; END IF;
 text_value:=saas.match_text(concat_ws(' ',p->>'reference',p->>'process_name',p->>'description',p->>'entity_name',p->>'department',p->>'city',p->>'procurement_method',p->>'contract_type'));
 terms:=COALESCE(NULLIF(f->'keywords_any','null'::jsonb),'[]');
 IF jsonb_array_length(terms)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(terms) t WHERE position(trim(saas.match_text(t)) in text_value)>0) THEN RETURN FALSE; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(f->'keywords_all','null'::jsonb),'[]')) t WHERE position(trim(saas.match_text(t)) in text_value)=0) THEN RETURN FALSE; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(f->'excluded_keywords','null'::jsonb),'[]')) t WHERE position(trim(saas.match_text(t)) in text_value)>0) THEN RETURN FALSE; END IF;
 RETURN TRUE;
END $$;
CREATE OR REPLACE FUNCTION saas.process_compatibility(p jsonb, c jsonb, f jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
 text_value TEXT := saas.match_text(concat_ws(' ',p->>'process_name',p->>'description',p->>'main_category_code',p->>'additional_categories'));
 terms JSONB; criterion JSONB; details JSONB := '[]'; strengths JSONB := '[]'; gaps JSONB := '[]';
 total INTEGER; hits INTEGER; earned NUMERIC; score NUMERIC := 0; weight INTEGER; configured BOOLEAN;
 label TEXT; item TEXT; minimum_value NUMERIC; maximum_value NUMERIC; price NUMERIC;
 closed BOOLEAN; recommendation TEXT; summary TEXT;
BEGIN
 c := COALESCE(c,'{}'); f := COALESCE(f,'{}');
 FOR item,label,weight IN SELECT * FROM (VALUES ('keywords','Productos, servicios y palabras clave',35),('unspsc','Categoría UNSPSC',30),('department','Cobertura geográfica',15),('budget','Rango de contratación',10),('method','Modalidad de contratación',5),('contract','Tipo de contrato',5)) v LOOP
  hits:=0;total:=0;earned:=0;configured:=false;
  IF item='keywords' THEN
   SELECT COALESCE(jsonb_agg(DISTINCT x),'[]') INTO terms FROM jsonb_array_elements_text(COALESCE(f->'keywords_any','[]') || COALESCE(c->'products_services','[]')) x WHERE length(trim(x))>=3;
   SELECT count(*),count(*) FILTER(WHERE saas.service_term_matches(text_value,x)) INTO total,hits FROM jsonb_array_elements_text(terms) x;
   configured:=total>0; IF configured THEN earned:=weight*LEAST(1.0,hits::numeric/LEAST(total,3)); END IF;
  ELSIF item='unspsc' THEN
   terms:=COALESCE(f->'unspsc_codes','[]') || COALESCE(c->'unspsc_codes','[]');
   SELECT count(*),count(*) FILTER(WHERE saas.unspsc_digits(p->>'main_category_code') LIKE saas.unspsc_digits(x) || '%' AND length(saas.unspsc_digits(x))>=2) INTO total,hits FROM jsonb_array_elements_text(terms) x;
   configured:=total>0; IF hits>0 THEN earned:=weight; END IF;
  ELSIF item='budget' THEN
   minimum_value:=COALESCE(NULLIF(f->>'minimum_budget','')::numeric,NULLIF(c->>'minimum_contract_value','')::numeric);
   maximum_value:=COALESCE(NULLIF(f->>'maximum_budget','')::numeric,NULLIF(c->>'maximum_contract_value','')::numeric);
   price:=NULLIF(p->>'base_price','')::numeric;configured:=minimum_value IS NOT NULL OR maximum_value IS NOT NULL;
   IF configured AND price IS NOT NULL AND (minimum_value IS NULL OR price>=minimum_value) AND (maximum_value IS NULL OR price<=maximum_value) THEN earned:=weight; END IF;
  ELSE
   terms:=CASE item WHEN 'department' THEN COALESCE(f->'departments','[]') || COALESCE(c->'service_departments','[]') WHEN 'method' THEN COALESCE(f->'procurement_methods','[]') || COALESCE(c->'procurement_methods','[]') ELSE COALESCE(f->'contract_types','[]') || COALESCE(c->'contract_types','[]') END;
   SELECT count(*),count(*) FILTER(WHERE (item='department' AND trim(saas.match_text(x)) IN ('cobertura nacional','nacional','todo el pais','colombia')) OR trim(saas.match_text(x))=trim(saas.match_text(p->>CASE item WHEN 'department' THEN 'department' WHEN 'method' THEN 'procurement_method' ELSE 'contract_type' END))) INTO total,hits FROM jsonb_array_elements_text(terms) x;
   configured:=total>0; IF hits>0 THEN earned:=weight; END IF;
  END IF;
  earned:=round(earned,1);score:=score+earned;
  details:=details || jsonb_build_array(jsonb_build_object('label',label,'weight',weight,'earned',earned,'configured',configured));
  IF earned>0 THEN strengths:=strengths || jsonb_build_array(label || ': ' || earned || '/' || weight || ' puntos'); END IF;
  IF earned<weight THEN gaps:=gaps || jsonb_build_array(CASE WHEN NOT configured THEN 'Falta configurar: ' || lower(label) ELSE 'Coincidencia parcial o ausente: ' || lower(label) END); END IF;
 END LOOP;
 closed:=COALESCE((p->>'awarded')::boolean,false) OR (NULLIF(p->>'response_deadline','')::timestamptz < NOW()) OR saas.match_text(p->>'process_status') ~ '(cancelad|adjudicad|terminad|cerrad)';
 IF closed THEN recommendation:='not_recommended';summary:='No iniciar una nueva oferta: el proceso está cerrado, vencido o adjudicado.';
 ELSIF score>=75 THEN recommendation:='review_recommended';summary:='Conviene revisar los pliegos: existe afinidad alta con las capacidades registradas. Falta validar requisitos y vigencias.';
 ELSIF score>=40 THEN recommendation:='review_required';summary:='Revisión necesaria: hay coincidencias, pero también capacidades sin acreditar o criterios pendientes.';
 ELSE recommendation:='not_recommended';summary:='No priorizar por ahora: la afinidad demostrada es baja. Revisa las diferencias y completa el perfil empresarial.'; END IF;
 RETURN jsonb_build_object('method','rules_v3','score',score,'criteria',details,'strengths',strengths,'gaps',gaps,'recommendation',recommendation,'summary',summary,'closed',COALESCE(closed,false),'disclaimer','Afinidad estimada por criterios; no es probabilidad de adjudicación ni certificación de cumplimiento.');
END $function$
;
COMMIT;
