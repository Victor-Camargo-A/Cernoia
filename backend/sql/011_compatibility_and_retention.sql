BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE OR REPLACE FUNCTION saas.match_text(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
 SELECT regexp_replace(translate(lower(COALESCE(value,'')), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g')
$$;
CREATE OR REPLACE FUNCTION saas.process_compatibility(p JSONB, c JSONB, f JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
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
   SELECT count(*),count(*) FILTER(WHERE position(trim(saas.match_text(x)) in text_value)>0) INTO total,hits FROM jsonb_array_elements_text(terms) x;
   configured:=total>0; IF configured THEN earned:=weight*LEAST(1.0,hits::numeric/LEAST(total,3)); END IF;
  ELSIF item='unspsc' THEN
   terms:=COALESCE(f->'unspsc_codes','[]') || COALESCE(c->'unspsc_codes','[]');
   SELECT count(*),count(*) FILTER(WHERE regexp_replace(COALESCE(p->>'main_category_code',''),'[^0-9]','','g') LIKE regexp_replace(x,'[^0-9]','','g') || '%' AND length(regexp_replace(x,'[^0-9]','','g'))>=2) INTO total,hits FROM jsonb_array_elements_text(terms) x;
   configured:=total>0; IF hits>0 THEN earned:=weight; END IF;
  ELSIF item='budget' THEN
   minimum_value:=COALESCE(NULLIF(f->>'minimum_budget','')::numeric,NULLIF(c->>'minimum_contract_value','')::numeric);
   maximum_value:=COALESCE(NULLIF(f->>'maximum_budget','')::numeric,NULLIF(c->>'maximum_contract_value','')::numeric);
   price:=NULLIF(p->>'base_price','')::numeric;configured:=minimum_value IS NOT NULL OR maximum_value IS NOT NULL;
   IF configured AND price IS NOT NULL AND (minimum_value IS NULL OR price>=minimum_value) AND (maximum_value IS NULL OR price<=maximum_value) THEN earned:=weight; END IF;
  ELSE
   terms:=CASE item WHEN 'department' THEN COALESCE(f->'departments','[]') || COALESCE(c->'service_departments','[]') WHEN 'method' THEN COALESCE(f->'procurement_methods','[]') || COALESCE(c->'procurement_methods','[]') ELSE COALESCE(f->'contract_types','[]') || COALESCE(c->'contract_types','[]') END;
   SELECT count(*),count(*) FILTER(WHERE trim(saas.match_text(x))=trim(saas.match_text(p->>CASE item WHEN 'department' THEN 'department' WHEN 'method' THEN 'procurement_method' ELSE 'contract_type' END))) INTO total,hits FROM jsonb_array_elements_text(terms) x;
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
 RETURN jsonb_build_object('method','rules_v2','score',score,'criteria',details,'strengths',strengths,'gaps',gaps,'recommendation',recommendation,'summary',summary,'closed',COALESCE(closed,false),'disclaimer','Afinidad estimada por criterios; no es probabilidad de adjudicación ni certificación de cumplimiento.');
END $$;
CREATE OR REPLACE FUNCTION saas.refresh_match_scores(target_organization UUID) RETURNS BIGINT LANGUAGE SQL AS $$
 WITH scored AS (
  SELECT m.id,saas.process_compatibility(to_jsonb(p),COALESCE(cap.record,'{}'::jsonb),profile.filter_config) AS result
  FROM saas.process_matches m JOIN secop.processes p ON p.id=m.process_id
  JOIN saas.search_profiles profile ON profile.id=m.search_profile_id
  LEFT JOIN LATERAL (SELECT to_jsonb(c) AS record FROM saas.organization_capability_profiles c WHERE c.organization_id=m.organization_id AND c.is_active=TRUE ORDER BY c.updated_at DESC LIMIT 1) cap ON TRUE
  WHERE m.organization_id=target_organization
 ), updated AS (
  UPDATE saas.process_matches m SET match_score=(scored.result->>'score')::numeric,
   matched_reasons=COALESCE(m.matched_reasons,'{}'::jsonb)||jsonb_build_object('compatibility',scored.result),updated_at=NOW()
  FROM scored WHERE m.id=scored.id RETURNING m.id
 ) SELECT COUNT(*) FROM updated
$$;
CREATE TABLE IF NOT EXISTS ops.process_retention_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
 retention_days INTEGER NOT NULL, candidate_count INTEGER NOT NULL DEFAULT 0, deleted_count INTEGER NOT NULL DEFAULT 0,
 protected_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running', error_message TEXT
);
COMMIT;
