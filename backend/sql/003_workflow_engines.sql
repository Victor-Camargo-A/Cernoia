-- Generado a partir de los DDL proporcionados por el propietario del proyecto.
-- No contiene datos piloto, limpiezas manuales ni pruebas destructivas.

-- ============================================================
-- Fuente auditada: WF-000 - Inicialización BD SECOP SaaS1
-- ============================================================

CREATE TABLE IF NOT EXISTS secop.process_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    process_id UUID NOT NULL,
    secop_process_id VARCHAR(160) NOT NULL,

    version_number INTEGER NOT NULL,

    change_type VARCHAR(30) NOT NULL,

    previous_hash VARCHAR(64),
    new_hash VARCHAR(64),

    changed_fields JSONB NOT NULL DEFAULT '[]'::JSONB,

    source_updated_at TIMESTAMPTZ,

    snapshot JSONB NOT NULL,

    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_process_versions_process
        FOREIGN KEY (process_id)
        REFERENCES secop.processes(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_process_versions_number
        UNIQUE (process_id, version_number),

    CONSTRAINT chk_process_versions_change_type
        CHECK (
            change_type IN (
                'created',
                'updated',
                'restored'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_process_versions_secop_id
ON secop.process_versions (
    secop_process_id,
    version_number DESC
);

CREATE INDEX IF NOT EXISTS idx_process_versions_process
ON secop.process_versions (
    process_id,
    version_number DESC
);

CREATE INDEX IF NOT EXISTS idx_process_versions_captured
ON secop.process_versions (
    captured_at DESC
);

CREATE INDEX IF NOT EXISTS idx_process_versions_changed_fields
ON secop.process_versions
USING GIN (
    changed_fields
);

CREATE INDEX IF NOT EXISTS idx_process_versions_snapshot
ON secop.process_versions
USING GIN (
    snapshot
);


-- ============================================================
-- Fuente auditada: Configurar versionado automático
-- ============================================================

BEGIN;

-- =========================================================
-- 1. Eliminamos un índice demasiado pesado.
-- Las versiones se consultarán por proceso y número,
-- no haciendo búsquedas libres dentro de todo el snapshot.
-- =========================================================

DROP INDEX IF EXISTS secop.idx_process_versions_snapshot;


-- =========================================================
-- 2. Función para generar el hash SHA-256 del JSON original.
-- El hash permite saber si SECOP modificó realmente el proceso.
-- =========================================================

CREATE OR REPLACE FUNCTION secop.calculate_process_hash(
    p_raw_json JSONB
)
RETURNS VARCHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT encode(
        digest(
            COALESCE(
                p_raw_json,
                '{}'::JSONB
            )::TEXT,
            'sha256'
        ),
        'hex'
    );
$$;


-- =========================================================
-- 3. Función BEFORE INSERT/UPDATE.
-- Calcula el hash y actualiza las fechas técnicas.
-- =========================================================

CREATE OR REPLACE FUNCTION secop.prepare_process_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash :=
        secop.calculate_process_hash(NEW.raw_json);

    NEW.last_seen_at := NOW();
    NEW.updated_at := NOW();

    RETURN NEW;
END;
$$;


-- =========================================================
-- 4. Función AFTER INSERT/UPDATE.
-- Crea la versión inicial o una nueva versión cuando
-- cambie realmente el contenido recibido desde SECOP.
-- =========================================================

CREATE OR REPLACE FUNCTION secop.capture_process_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_next_version INTEGER;
    v_changed_fields JSONB := '[]'::JSONB;
BEGIN

    -- -----------------------------------------------------
    -- Proceso nuevo: crear versión 1.
    -- -----------------------------------------------------

    IF TG_OP = 'INSERT' THEN

        INSERT INTO secop.process_versions (
            process_id,
            secop_process_id,
            version_number,
            change_type,
            previous_hash,
            new_hash,
            changed_fields,
            source_updated_at,
            snapshot,
            captured_at,
            created_at
        )
        VALUES (
            NEW.id,
            NEW.secop_process_id,
            1,
            'created',
            NULL,
            NEW.content_hash,
            jsonb_build_array('initial_snapshot'),
            NEW.source_updated_at,

            to_jsonb(NEW)
                - ARRAY[
                    'last_seen_at',
                    'updated_at',
                    'created_at'
                ],

            NOW(),
            NOW()
        );

        RETURN NEW;
    END IF;


    -- -----------------------------------------------------
    -- Si el JSON no cambió, no crear una nueva versión.
    -- -----------------------------------------------------

    IF OLD.content_hash IS NOT DISTINCT FROM NEW.content_hash THEN
        RETURN NEW;
    END IF;


    -- -----------------------------------------------------
    -- Identificar cuáles propiedades del JSON cambiaron.
    -- -----------------------------------------------------

    SELECT COALESCE(
        jsonb_agg(changed.key ORDER BY changed.key),
        '[]'::JSONB
    )
    INTO v_changed_fields
    FROM (
        SELECT all_keys.key
        FROM (
            SELECT jsonb_object_keys(
                COALESCE(OLD.raw_json, '{}'::JSONB)
            ) AS key

            UNION

            SELECT jsonb_object_keys(
                COALESCE(NEW.raw_json, '{}'::JSONB)
            ) AS key
        ) AS all_keys

        WHERE
            COALESCE(OLD.raw_json, '{}'::JSONB)
                -> all_keys.key
            IS DISTINCT FROM
            COALESCE(NEW.raw_json, '{}'::JSONB)
                -> all_keys.key
    ) AS changed;


    -- -----------------------------------------------------
    -- Calcular el siguiente número de versión.
    -- -----------------------------------------------------

    SELECT COALESCE(
        MAX(version_number),
        0
    ) + 1
    INTO v_next_version
    FROM secop.process_versions
    WHERE process_id = NEW.id;


    -- -----------------------------------------------------
    -- Guardar nueva versión histórica.
    -- -----------------------------------------------------

    INSERT INTO secop.process_versions (
        process_id,
        secop_process_id,
        version_number,
        change_type,
        previous_hash,
        new_hash,
        changed_fields,
        source_updated_at,
        snapshot,
        captured_at,
        created_at
    )
    VALUES (
        NEW.id,
        NEW.secop_process_id,
        v_next_version,
        'updated',
        OLD.content_hash,
        NEW.content_hash,
        v_changed_fields,
        NEW.source_updated_at,

        to_jsonb(NEW)
            - ARRAY[
                'last_seen_at',
                'updated_at',
                'created_at'
            ],

        NOW(),
        NOW()
    );

    RETURN NEW;
END;
$$;


-- =========================================================
-- 5. Calcular hashes para los procesos que ya existen.
-- Todavía no hemos creado los triggers, así que esta
-- actualización no generará versiones adicionales.
-- =========================================================

UPDATE secop.processes
SET content_hash =
    secop.calculate_process_hash(raw_json)
WHERE content_hash IS DISTINCT FROM
    secop.calculate_process_hash(raw_json);


-- =========================================================
-- 6. Crear versión inicial para todos los procesos actuales.
-- El NOT EXISTS permite ejecutar nuevamente esta migración
-- sin duplicar las versiones iniciales.
-- =========================================================

INSERT INTO secop.process_versions (
    process_id,
    secop_process_id,
    version_number,
    change_type,
    previous_hash,
    new_hash,
    changed_fields,
    source_updated_at,
    snapshot,
    captured_at,
    created_at
)
SELECT
    process.id,
    process.secop_process_id,
    1,
    'created',
    NULL,
    process.content_hash,
    jsonb_build_array('initial_snapshot'),
    process.source_updated_at,

    to_jsonb(process)
        - ARRAY[
            'last_seen_at',
            'updated_at',
            'created_at'
        ],

    NOW(),
    NOW()

FROM secop.processes AS process

WHERE NOT EXISTS (
    SELECT 1
    FROM secop.process_versions AS version
    WHERE version.process_id = process.id
);


-- =========================================================
-- 7. Eliminar triggers anteriores si ya existían.
-- =========================================================

DROP TRIGGER IF EXISTS trg_prepare_process_hash
ON secop.processes;

DROP TRIGGER IF EXISTS trg_capture_process_version
ON secop.processes;


-- =========================================================
-- 8. Crear los triggers definitivos.
-- =========================================================

CREATE TRIGGER trg_prepare_process_hash
BEFORE INSERT OR UPDATE OF raw_json
ON secop.processes
FOR EACH ROW
EXECUTE FUNCTION secop.prepare_process_hash();


CREATE TRIGGER trg_capture_process_version
AFTER INSERT OR UPDATE OF raw_json
ON secop.processes
FOR EACH ROW
EXECUTE FUNCTION secop.capture_process_version();

COMMIT;


-- ============================================================
-- Fuente auditada: Nombre: Crear eventos de cambios WF-002 Credential: Postgres account Operation: Execute Query
-- ============================================================

CREATE TABLE IF NOT EXISTS secop.process_change_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    version_id UUID NOT NULL,
    process_id UUID NOT NULL,

    secop_process_id VARCHAR(160) NOT NULL,
    version_number INTEGER NOT NULL,

    event_type VARCHAR(60) NOT NULL
        DEFAULT 'process_updated',

    relevance_level VARCHAR(20) NOT NULL
        DEFAULT 'pending',

    changed_fields JSONB NOT NULL
        DEFAULT '[]'::JSONB,

    change_summary JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    status VARCHAR(20) NOT NULL
        DEFAULT 'pending',

    source_updated_at TIMESTAMPTZ,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_change_events_version
        FOREIGN KEY (version_id)
        REFERENCES secop.process_versions(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_change_events_process
        FOREIGN KEY (process_id)
        REFERENCES secop.processes(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_change_events_version
        UNIQUE (version_id),

    CONSTRAINT chk_change_events_type
        CHECK (
            event_type IN (
                'process_created',
                'process_updated',
                'budget_changed',
                'status_changed',
                'date_changed',
                'award_changed',
                'multiple_changes',
                'other'
            )
        ),

    CONSTRAINT chk_change_events_relevance
        CHECK (
            relevance_level IN (
                'pending',
                'low',
                'medium',
                'high',
                'critical'
            )
        ),

    CONSTRAINT chk_change_events_status
        CHECK (
            status IN (
                'pending',
                'processed',
                'ignored',
                'error'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_change_events_pending
ON secop.process_change_events (
    status,
    detected_at ASC
);

CREATE INDEX IF NOT EXISTS idx_change_events_relevance
ON secop.process_change_events (
    relevance_level,
    detected_at DESC
);

CREATE INDEX IF NOT EXISTS idx_change_events_secop_id
ON secop.process_change_events (
    secop_process_id,
    version_number DESC
);

CREATE INDEX IF NOT EXISTS idx_change_events_process
ON secop.process_change_events (
    process_id,
    version_number DESC
);

CREATE INDEX IF NOT EXISTS idx_change_events_changed_fields
ON secop.process_change_events
USING GIN (
    changed_fields
);

INSERT INTO ops.sync_cursors (
    source_code,
    cursor_timestamp,
    cursor_process_id,
    status,
    metadata,
    created_at,
    updated_at
)
VALUES (
    'SECOP_II_PROCESS_VERSIONS',

    (
        SELECT captured_at
        FROM secop.process_versions
        ORDER BY captured_at DESC, id::TEXT DESC
        LIMIT 1
    ),

    (
        SELECT id::TEXT
        FROM secop.process_versions
        ORDER BY captured_at DESC, id::TEXT DESC
        LIMIT 1
    ),

    'idle',

    jsonb_build_object(
        'workflow_code',
        'WF-002',
        'purpose',
        'Procesar versiones y generar eventos de cambios',
        'initialized_at',
        NOW(),
        'initial_versions_skipped',
        TRUE
    ),

    NOW(),
    NOW()
)

ON CONFLICT (source_code)
DO NOTHING;


-- ============================================================
-- Fuente auditada: Crear función consolidación WF-016
-- ============================================================

DROP FUNCTION IF EXISTS
    saas.consolidate_opportunity_requirement_matrix_v1
    (
        UUID,
        UUID,
        UUID,
        TEXT,
        TEXT,
        INTEGER,
        INTEGER,
        INTEGER,
        TEXT,
        TEXT
    );


CREATE FUNCTION
    saas.consolidate_opportunity_requirement_matrix_v1
(
    p_organization_id UUID,
    p_opportunity_analysis_id UUID,
    p_process_id UUID,
    p_process_reference TEXT,
    p_input_hash_sha256 TEXT,
    p_expected_source_document_count INTEGER,
    p_expected_source_requirement_count INTEGER,
    p_consolidation_version INTEGER,
    p_consolidation_method TEXT,
    p_execution_id TEXT
)

RETURNS TABLE
(
    matrix_id UUID,
    organization_id UUID,
    opportunity_analysis_id UUID,
    process_id UUID,
    process_reference TEXT,

    matrix_version INTEGER,
    consolidation_version INTEGER,
    consolidation_method TEXT,

    matrix_status TEXT,
    is_current BOOLEAN,

    source_document_count INTEGER,
    source_requirement_count INTEGER,

    consolidated_requirement_count INTEGER,
    bid_requirement_count INTEGER,
    non_bid_requirement_count INTEGER,
    conditional_requirement_count INTEGER,
    review_required_count INTEGER,

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    matrix_stored BOOLEAN,
    consolidation_result TEXT
)

LANGUAGE plpgsql

AS $wf016$

DECLARE
    v_matrix_id UUID;
    v_matrix_version INTEGER;

    v_source_document_count INTEGER := 0;
    v_source_requirement_count INTEGER := 0;

    v_consolidated_count INTEGER := 0;
    v_bid_count INTEGER := 0;
    v_non_bid_count INTEGER := 0;
    v_conditional_count INTEGER := 0;
    v_review_count INTEGER := 0;
    v_source_link_count INTEGER := 0;
    v_archived_count INTEGER := 0;

    v_consolidation_version INTEGER;
    v_consolidation_method TEXT;
    v_input_hash TEXT;

BEGIN
    /*
     * Validación inicial.
     */
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION
            'organization_id es obligatorio';
    END IF;

    IF p_opportunity_analysis_id IS NULL THEN
        RAISE EXCEPTION
            'opportunity_analysis_id es obligatorio';
    END IF;

    IF p_process_id IS NULL THEN
        RAISE EXCEPTION
            'process_id es obligatorio';
    END IF;

    v_consolidation_version :=
        GREATEST(
            COALESCE(
                p_consolidation_version,
                1
            ),
            1
        );

    v_consolidation_method :=
        COALESCE(
            NULLIF(
                BTRIM(p_consolidation_method),
                ''
            ),
            'deterministic_v1'
        );

    v_input_hash :=
        LOWER(
            BTRIM(
                COALESCE(
                    p_input_hash_sha256,
                    ''
                )
            )
        );

    IF LENGTH(v_input_hash) <> 64 THEN
        RAISE EXCEPTION
            'input_hash_sha256 inválido: longitud %',
            LENGTH(v_input_hash);
    END IF;


    /*
     * Contar requisitos fuente activos.
     */
    SELECT
        COUNT(requirement.id)::INTEGER,

        COUNT(
            DISTINCT
            requirement.opportunity_document_id
        )::INTEGER

    INTO
        v_source_requirement_count,
        v_source_document_count

    FROM saas.opportunity_requirements
        AS requirement

    WHERE requirement.organization_id =
          p_organization_id

      AND requirement.opportunity_analysis_id =
          p_opportunity_analysis_id

      AND requirement.process_id =
          p_process_id

      AND requirement.status IN (
          'active',
          'review_required'
      );


    IF v_source_requirement_count = 0 THEN
        RAISE EXCEPTION
            'No existen requisitos activos para la oportunidad %',
            p_opportunity_analysis_id;
    END IF;


    /*
     * Buscar una matriz con el mismo conjunto fuente.
     */
    SELECT
        matrix.id,
        matrix.matrix_version

    INTO
        v_matrix_id,
        v_matrix_version

    FROM saas.opportunity_requirement_matrices
        AS matrix

    WHERE matrix.organization_id =
          p_organization_id

      AND matrix.opportunity_analysis_id =
          p_opportunity_analysis_id

      AND matrix.input_hash_sha256 =
          v_input_hash::CHARACTER(64)

      AND matrix.consolidation_version =
          v_consolidation_version

    ORDER BY
        matrix.created_at DESC

    LIMIT 1;


    /*
     * Crear o reutilizar la cabecera.
     */
    IF v_matrix_id IS NULL THEN

        SELECT
            COALESCE(
                MAX(matrix.matrix_version),
                0
            ) + 1

        INTO
            v_matrix_version

        FROM saas.opportunity_requirement_matrices
            AS matrix

        WHERE matrix.organization_id =
              p_organization_id

          AND matrix.opportunity_analysis_id =
              p_opportunity_analysis_id;


        INSERT INTO
            saas.opportunity_requirement_matrices
        (
            organization_id,
            opportunity_analysis_id,
            process_id,
            process_reference,

            matrix_version,
            consolidation_version,
            consolidation_method,
            input_hash_sha256,

            matrix_status,
            is_current,

            source_document_count,
            source_requirement_count,

            consolidated_requirement_count,
            bid_requirement_count,
            non_bid_requirement_count,
            conditional_requirement_count,
            review_required_count,

            n8n_execution_id,
            started_at,

            summary,
            metadata,

            created_at,
            updated_at
        )

        VALUES
        (
            p_organization_id,
            p_opportunity_analysis_id,
            p_process_id,
            p_process_reference,

            v_matrix_version,
            v_consolidation_version,
            v_consolidation_method,
            v_input_hash::CHARACTER(64),

            'building',
            FALSE,

            v_source_document_count,
            v_source_requirement_count,

            0,
            0,
            0,
            0,
            0,

            p_execution_id,
            NOW(),

            '{}'::JSONB,

            jsonb_build_object(
                'workflow_code',
                'WF-016',

                'created_by',
                'WF-016',

                'created_at',
                NOW(),

                'expected_source_document_count',
                COALESCE(
                    p_expected_source_document_count,
                    0
                ),

                'expected_source_requirement_count',
                COALESCE(
                    p_expected_source_requirement_count,
                    0
                )
            ),

            NOW(),
            NOW()
        )

        RETURNING id
        INTO v_matrix_id;

    ELSE

        UPDATE saas.opportunity_requirement_matrices
            AS matrix

        SET
            process_id =
                p_process_id,

            process_reference =
                p_process_reference,

            consolidation_method =
                v_consolidation_method,

            matrix_status =
                'building',

            is_current =
                FALSE,

            source_document_count =
                v_source_document_count,

            source_requirement_count =
                v_source_requirement_count,

            consolidated_requirement_count =
                0,

            bid_requirement_count =
                0,

            non_bid_requirement_count =
                0,

            conditional_requirement_count =
                0,

            review_required_count =
                0,

            n8n_execution_id =
                p_execution_id,

            started_at =
                NOW(),

            finished_at =
                NULL,

            error_message =
                NULL,

            summary =
                '{}'::JSONB,

            metadata =
                COALESCE(
                    matrix.metadata,
                    '{}'::JSONB
                )
                || jsonb_build_object(
                    'workflow_code',
                    'WF-016',

                    'rebuild_started_at',
                    NOW(),

                    'rebuild_execution_id',
                    p_execution_id
                ),

            updated_at =
                NOW()

        WHERE matrix.id =
              v_matrix_id;

    END IF;


    /*
     * Borrar consolidación parcial anterior.
     */
    DELETE FROM
        saas.opportunity_requirement_matrix_items
            AS item

    WHERE item.matrix_id =
          v_matrix_id;


    /*
     * Construir una tabla temporal de fuentes clasificadas.
     */
    DROP TABLE IF EXISTS
        tmp_wf016_sources;

    CREATE TEMP TABLE
        tmp_wf016_sources

    ON COMMIT DROP

    AS

    WITH prepared_sources AS (
        SELECT
            requirement.id
                AS source_requirement_id,

            requirement.opportunity_document_id,

            requirement.requirement_category,
            requirement.requirement_name,
            requirement.normalized_document_type,
            requirement.requirement_description,

            requirement.mandatory,

            NULLIF(
                BTRIM(requirement.condition_text),
                ''
            )
                AS condition_text,

            requirement.maximum_age_days,

            requirement.requires_signature,
            requirement.requires_entity_template,
            requirement.requires_original,
            requirement.requires_notarization,
            requirement.requires_translation,

            COALESCE(
                NULLIF(
                    BTRIM(requirement.applies_to),
                    ''
                ),
                'bidder'
            )
                AS applies_to,

            requirement.requirement_stage,
            requirement.is_bid_requirement,

            requirement.source_page,
            requirement.source_section,
            requirement.evidence_text,
            requirement.confidence_score,

            requirement.requirement_hash_sha256,
            requirement.ai_model,
            requirement.metadata,
            requirement.updated_at,

            document.document_name,
            document.primary_category,

            CASE document.primary_category
                WHEN 'addendum' THEN 100
                WHEN 'invitation_or_terms' THEN 90
                WHEN 'entity_template' THEN 80
                WHEN 'technical_annex' THEN 70
                WHEN 'previous_studies' THEN 60
                WHEN 'risk_matrix' THEN 50
                ELSE 40
            END
                AS source_priority,

            ENCODE(
                DIGEST(
                    CONCAT_WS(
                        '|',

                        CASE
                            WHEN LOWER(
                                COALESCE(
                                    NULLIF(
                                        BTRIM(
                                            requirement.normalized_document_type
                                        ),
                                        ''
                                    ),
                                    'other'
                                )
                            ) NOT IN (
                                'other',
                                'unknown',
                                'unspecified'
                            )
                                THEN LOWER(
                                    BTRIM(
                                        requirement.normalized_document_type
                                    )
                                )

                            ELSE REGEXP_REPLACE(
                                LOWER(
                                    BTRIM(
                                        requirement.requirement_name
                                    )
                                ),
                                '[^[:alnum:]]+',
                                '',
                                'g'
                            )
                        END,

                        requirement.requirement_stage,

                        LOWER(
                            COALESCE(
                                NULLIF(
                                    BTRIM(requirement.applies_to),
                                    ''
                                ),
                                'bidder'
                            )
                        ),

                        COALESCE(
                            REGEXP_REPLACE(
                                LOWER(
                                    BTRIM(
                                        requirement.condition_text
                                    )
                                ),
                                '\s+',
                                ' ',
                                'g'
                            ),
                            'general'
                        )
                    ),

                    'sha256'
                ),

                'hex'
            )::CHARACTER(64)
                AS canonical_requirement_key

        FROM saas.opportunity_requirements
            AS requirement

        JOIN saas.opportunity_documents
            AS document

            ON document.id =
               requirement.opportunity_document_id

        WHERE requirement.organization_id =
              p_organization_id

          AND requirement.opportunity_analysis_id =
              p_opportunity_analysis_id

          AND requirement.process_id =
              p_process_id

          AND requirement.status IN (
              'active',
              'review_required'
          )
    )

    SELECT
        source.*,

        ROW_NUMBER() OVER (
            PARTITION BY
                source.canonical_requirement_key

            ORDER BY
                source.source_priority DESC,

                source.confidence_score DESC
                    NULLS LAST,

                source.updated_at DESC,

                source.source_requirement_id
        )
            AS source_rank

    FROM prepared_sources
        AS source;


    /*
     * Insertar requisitos consolidados.
     */
    WITH grouped_sources AS (
        SELECT
            source.canonical_requirement_key,

            (
                ARRAY_AGG(
                    source.requirement_category
                    ORDER BY source.source_rank
                )
            )[1]
                AS requirement_category,

            (
                ARRAY_AGG(
                    source.requirement_name
                    ORDER BY source.source_rank
                )
            )[1]
                AS requirement_name,

            (
                ARRAY_AGG(
                    source.normalized_document_type
                    ORDER BY source.source_rank
                )
            )[1]
                AS normalized_document_type,

            (
                ARRAY_AGG(
                    source.requirement_description
                    ORDER BY source.source_rank
                )
            )[1]
                AS requirement_description,

            BOOL_OR(source.mandatory)
                AS mandatory,

            (
                ARRAY_AGG(
                    source.condition_text
                    ORDER BY source.source_rank
                )
            )[1]
                AS condition_text,

            (
                ARRAY_AGG(
                    source.maximum_age_days
                    ORDER BY source.source_rank
                )
            )[1]
                AS maximum_age_days,

            BOOL_OR(source.requires_signature)
                AS requires_signature,

            BOOL_OR(source.requires_entity_template)
                AS requires_entity_template,

            BOOL_OR(source.requires_original)
                AS requires_original,

            BOOL_OR(source.requires_notarization)
                AS requires_notarization,

            BOOL_OR(source.requires_translation)
                AS requires_translation,

            (
                ARRAY_AGG(
                    source.applies_to
                    ORDER BY source.source_rank
                )
            )[1]
                AS applies_to,

            (
                ARRAY_AGG(
                    source.requirement_stage
                    ORDER BY source.source_rank
                )
            )[1]
                AS requirement_stage,

            MAX(source.confidence_score)
                AS confidence_score,

            COUNT(*)::INTEGER
                AS source_requirement_count,

            COUNT(
                DISTINCT
                source.opportunity_document_id
            )::INTEGER
                AS source_document_count,

            CASE
                WHEN COUNT(
                    DISTINCT source.mandatory
                ) > 1

                  OR COUNT(
                      DISTINCT source.maximum_age_days
                  ) FILTER (
                      WHERE source.maximum_age_days
                            IS NOT NULL
                  ) > 1

                  OR COUNT(
                      DISTINCT source.requires_signature
                  ) > 1

                  OR COUNT(
                      DISTINCT source.requires_entity_template
                  ) > 1

                  OR COUNT(
                      DISTINCT source.requires_original
                  ) > 1

                  OR COUNT(
                      DISTINCT source.requires_notarization
                  ) > 1

                  OR COUNT(
                      DISTINCT source.requires_translation
                  ) > 1

                    THEN 'review_required'

                ELSE 'none'
            END
                AS conflict_status,

            jsonb_build_object(
                'mandatory_values',
                TO_JSONB(
                    ARRAY_AGG(
                        DISTINCT source.mandatory
                    )
                ),

                'maximum_age_days_values',
                TO_JSONB(
                    ARRAY_AGG(
                        DISTINCT source.maximum_age_days
                    ) FILTER (
                        WHERE source.maximum_age_days
                              IS NOT NULL
                    )
                ),

                'document_categories',
                TO_JSONB(
                    ARRAY_AGG(
                        DISTINCT source.primary_category
                    )
                )
            )
                AS conflict_details,

            (
                ARRAY_AGG(
                    source.source_requirement_id
                    ORDER BY source.source_rank
                )
            )[1]
                AS primary_source_requirement_id,

            (
                ARRAY_AGG(
                    source.opportunity_document_id
                    ORDER BY source.source_rank
                )
            )[1]
                AS primary_source_document_id,

            (
                ARRAY_AGG(
                    source.document_name
                    ORDER BY source.source_rank
                )
            )[1]
                AS primary_source_document_name

        FROM tmp_wf016_sources
            AS source

        GROUP BY
            source.canonical_requirement_key
    ),

    ordered_items AS (
        SELECT
            grouped.*,

            (
                grouped.requirement_stage IN (
                    'bid_submission',
                    'eligibility',
                    'evaluation'
                )
            )
                AS calculated_bid_requirement,

            CASE
                WHEN grouped.conflict_status =
                     'review_required'
                    THEN 'review_required'

                ELSE 'active'
            END
                AS calculated_item_status,

            (
                CASE grouped.requirement_stage
                    WHEN 'bid_submission' THEN 1000
                    WHEN 'eligibility' THEN 2000
                    WHEN 'evaluation' THEN 3000
                    WHEN 'award' THEN 4000
                    WHEN 'contract_signing' THEN 5000
                    WHEN 'contract_execution' THEN 6000
                    WHEN 'payment' THEN 7000
                    ELSE 8000
                END

                + ROW_NUMBER() OVER (
                    ORDER BY
                        CASE grouped.requirement_stage
                            WHEN 'bid_submission' THEN 1
                            WHEN 'eligibility' THEN 2
                            WHEN 'evaluation' THEN 3
                            WHEN 'award' THEN 4
                            WHEN 'contract_signing' THEN 5
                            WHEN 'contract_execution' THEN 6
                            WHEN 'payment' THEN 7
                            ELSE 8
                        END,

                        grouped.requirement_category,
                        grouped.requirement_name
                )
            )::INTEGER
                AS calculated_sort_order

        FROM grouped_sources
            AS grouped
    )

    INSERT INTO
        saas.opportunity_requirement_matrix_items
    (
        matrix_id,
        organization_id,
        opportunity_analysis_id,
        process_id,

        canonical_requirement_key,

        requirement_category,
        requirement_name,
        normalized_document_type,
        requirement_description,

        mandatory,
        condition_text,
        maximum_age_days,

        requires_signature,
        requires_entity_template,
        requires_original,
        requires_notarization,
        requires_translation,

        applies_to,
        requirement_stage,
        is_bid_requirement,

        confidence_score,

        source_requirement_count,
        source_document_count,

        conflict_status,
        conflict_details,
        review_reason,

        item_status,
        sort_order,

        metadata,

        created_at,
        updated_at
    )

    SELECT
        v_matrix_id,
        p_organization_id,
        p_opportunity_analysis_id,
        p_process_id,

        item.canonical_requirement_key,

        item.requirement_category,
        item.requirement_name,
        item.normalized_document_type,
        item.requirement_description,

        item.mandatory,
        item.condition_text,
        item.maximum_age_days,

        item.requires_signature,
        item.requires_entity_template,
        item.requires_original,
        item.requires_notarization,
        item.requires_translation,

        item.applies_to,
        item.requirement_stage,
        item.calculated_bid_requirement,

        item.confidence_score,

        item.source_requirement_count,
        item.source_document_count,

        item.conflict_status,
        item.conflict_details,

        CASE
            WHEN item.conflict_status =
                 'review_required'
                THEN
                    'Se encontraron diferencias entre documentos fuente.'

            ELSE NULL
        END,

        item.calculated_item_status,
        item.calculated_sort_order,

        jsonb_build_object(
            'workflow_code',
            'WF-016',

            'consolidation_method',
            v_consolidation_method,

            'consolidation_version',
            v_consolidation_version,

            'primary_source_requirement_id',
            item.primary_source_requirement_id,

            'primary_source_document_id',
            item.primary_source_document_id,

            'primary_source_document_name',
            item.primary_source_document_name
        ),

        NOW(),
        NOW()

    FROM ordered_items
        AS item;


    /*
     * Insertar trazabilidad completa.
     */
    INSERT INTO
        saas.opportunity_requirement_matrix_sources
    (
        matrix_item_id,
        opportunity_requirement_id,
        opportunity_document_id,

        source_rank,
        source_priority,
        is_primary_source,

        source_snapshot,
        metadata,

        created_at
    )

    SELECT
        item.id,

        source.source_requirement_id,
        source.opportunity_document_id,

        LEAST(
            source.source_rank,
            32767
        )::SMALLINT,

        source.source_priority::SMALLINT,

        source.source_rank = 1,

        jsonb_build_object(
            'requirement_name',
            source.requirement_name,

            'requirement_category',
            source.requirement_category,

            'normalized_document_type',
            source.normalized_document_type,

            'requirement_stage',
            source.requirement_stage,

            'mandatory',
            source.mandatory,

            'condition_text',
            source.condition_text,

            'maximum_age_days',
            source.maximum_age_days,

            'source_page',
            source.source_page,

            'source_section',
            source.source_section,

            'evidence_text',
            source.evidence_text,

            'confidence_score',
            source.confidence_score,

            'document_name',
            source.document_name,

            'document_category',
            source.primary_category,

            'requirement_hash_sha256',
            source.requirement_hash_sha256,

            'ai_model',
            source.ai_model,

            'prompt_version',
            source.metadata
                ->> 'prompt_version'
        ),

        jsonb_build_object(
            'workflow_code',
            'WF-016',

            'source_priority',
            source.source_priority,

            'source_rank',
            source.source_rank
        ),

        NOW()

    FROM tmp_wf016_sources
        AS source

    JOIN saas.opportunity_requirement_matrix_items
        AS item

        ON item.matrix_id =
           v_matrix_id

       AND item.canonical_requirement_key =
           source.canonical_requirement_key;


    /*
     * Calcular los resultados.
     */
    SELECT
        COUNT(*)::INTEGER,

        COUNT(*) FILTER (
            WHERE item.is_bid_requirement = TRUE
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE item.is_bid_requirement = FALSE
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE item.condition_text IS NOT NULL
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE item.item_status =
                  'review_required'
        )::INTEGER

    INTO
        v_consolidated_count,
        v_bid_count,
        v_non_bid_count,
        v_conditional_count,
        v_review_count

    FROM saas.opportunity_requirement_matrix_items
        AS item

    WHERE item.matrix_id =
          v_matrix_id;


    SELECT
        COUNT(*)::INTEGER

    INTO
        v_source_link_count

    FROM saas.opportunity_requirement_matrix_sources
        AS source

    JOIN saas.opportunity_requirement_matrix_items
        AS item

        ON item.id =
           source.matrix_item_id

    WHERE item.matrix_id =
          v_matrix_id;


    IF v_consolidated_count = 0 THEN
        RAISE EXCEPTION
            'La consolidación no produjo requisitos';
    END IF;


    /*
     * Archivar matrices anteriores.
     */
    UPDATE saas.opportunity_requirement_matrices
        AS previous

    SET
        is_current = FALSE,

        matrix_status =
            CASE
                WHEN previous.matrix_status =
                     'completed'
                    THEN 'archived'

                ELSE previous.matrix_status
            END,

        updated_at = NOW()

    WHERE previous.organization_id =
          p_organization_id

      AND previous.opportunity_analysis_id =
          p_opportunity_analysis_id

      AND previous.id <> v_matrix_id

      AND previous.is_current = TRUE;


    GET DIAGNOSTICS
        v_archived_count =
        ROW_COUNT;


    /*
     * Finalizar la matriz actual.
     */
    UPDATE saas.opportunity_requirement_matrices
        AS matrix

    SET
        matrix_status = 'completed',
        is_current = TRUE,

        source_document_count =
            v_source_document_count,

        source_requirement_count =
            v_source_requirement_count,

        consolidated_requirement_count =
            v_consolidated_count,

        bid_requirement_count =
            v_bid_count,

        non_bid_requirement_count =
            v_non_bid_count,

        conditional_requirement_count =
            v_conditional_count,

        review_required_count =
            v_review_count,

        finished_at = NOW(),
        error_message = NULL,

        summary =
            jsonb_build_object(
                'source_document_count',
                v_source_document_count,

                'source_requirement_count',
                v_source_requirement_count,

                'consolidated_requirement_count',
                v_consolidated_count,

                'bid_requirement_count',
                v_bid_count,

                'non_bid_requirement_count',
                v_non_bid_count,

                'conditional_requirement_count',
                v_conditional_count,

                'review_required_count',
                v_review_count,

                'source_links_created',
                v_source_link_count
            ),

        metadata =
            COALESCE(
                matrix.metadata,
                '{}'::JSONB
            )
            || jsonb_build_object(
                'completed_by',
                'WF-016',

                'completed_at',
                NOW(),

                'completed_execution_id',
                p_execution_id,

                'archived_previous_matrices',
                v_archived_count
            ),

        updated_at = NOW()

    WHERE matrix.id =
          v_matrix_id;


    /*
     * Devolver una fila a n8n.
     */
    RETURN QUERY

    SELECT
        current_matrix.id,
        current_matrix.organization_id,
        current_matrix.opportunity_analysis_id,
        current_matrix.process_id,
        current_matrix.process_reference,

        current_matrix.matrix_version,
        current_matrix.consolidation_version,
        current_matrix.consolidation_method::TEXT,

        current_matrix.matrix_status::TEXT,
        current_matrix.is_current,

        current_matrix.source_document_count,
        current_matrix.source_requirement_count,

        current_matrix.consolidated_requirement_count,
        current_matrix.bid_requirement_count,
        current_matrix.non_bid_requirement_count,
        current_matrix.conditional_requirement_count,
        current_matrix.review_required_count,

        current_matrix.started_at,
        current_matrix.finished_at,

        TRUE,
        'success'::TEXT

    FROM saas.opportunity_requirement_matrices
        AS current_matrix

    WHERE current_matrix.id =
          v_matrix_id;

END;

$wf016$;


-- ============================================================
-- Fuente auditada: Crear estructura base WF-017
-- ============================================================

/*
 * ============================================================
 * WF-017 — EVALUACIÓN DE CUMPLIMIENTO EMPRESARIAL
 * Estructura base V1
 * ============================================================
 */


/*
 * ------------------------------------------------------------
 * 1. Equivalencias entre tipos documentales
 *
 * Permite relacionar:
 * - normalized_document_type de WF-016
 * - document_type de organization_documents
 *
 * match_mode:
 * - equivalent:
 *   puede ser utilizado como coincidencia documental automática.
 *
 * - candidate_only:
 *   se considera documento candidato, pero requiere revisión.
 * ------------------------------------------------------------
 */

CREATE TABLE IF NOT EXISTS
    saas.document_type_equivalences
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    requirement_document_type TEXT NOT NULL,

    organization_document_type TEXT NOT NULL,

    applies_to TEXT NOT NULL
        DEFAULT '*',

    match_mode VARCHAR(32) NOT NULL
        DEFAULT 'equivalent',

    priority SMALLINT NOT NULL
        DEFAULT 100,

    is_active BOOLEAN NOT NULL
        DEFAULT TRUE,

    notes TEXT,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT document_type_equivalences_unique
        UNIQUE
        (
            requirement_document_type,
            organization_document_type,
            applies_to
        ),

    CONSTRAINT document_type_equivalences_match_mode_check
        CHECK (
            match_mode IN (
                'equivalent',
                'candidate_only'
            )
        ),

    CONSTRAINT document_type_equivalences_priority_check
        CHECK (
            priority BETWEEN 1 AND 1000
        )
);


/*
 * ------------------------------------------------------------
 * 2. Cabecera de evaluación por oportunidad y empresa
 * ------------------------------------------------------------
 */

CREATE TABLE IF NOT EXISTS
    saas.opportunity_compliance_evaluations
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    organization_id UUID NOT NULL,

    opportunity_analysis_id UUID NOT NULL,

    process_id UUID NOT NULL,

    process_reference TEXT,

    matrix_id UUID NOT NULL
        REFERENCES
            saas.opportunity_requirement_matrices(id)
        ON DELETE CASCADE,

    evaluation_version INTEGER NOT NULL
        DEFAULT 1,

    evaluation_method VARCHAR(64) NOT NULL
        DEFAULT 'deterministic_v1',

    input_hash_sha256 CHAR(64) NOT NULL,

    evaluation_status VARCHAR(24) NOT NULL
        DEFAULT 'queued',

    is_current BOOLEAN NOT NULL
        DEFAULT TRUE,

    total_requirement_count INTEGER NOT NULL
        DEFAULT 0,

    bid_requirement_count INTEGER NOT NULL
        DEFAULT 0,

    compliant_count INTEGER NOT NULL
        DEFAULT 0,

    expiring_count INTEGER NOT NULL
        DEFAULT 0,

    expired_count INTEGER NOT NULL
        DEFAULT 0,

    missing_count INTEGER NOT NULL
        DEFAULT 0,

    non_compliant_count INTEGER NOT NULL
        DEFAULT 0,

    manual_review_count INTEGER NOT NULL
        DEFAULT 0,

    not_applicable_count INTEGER NOT NULL
        DEFAULT 0,

    verification_pending_count INTEGER NOT NULL
        DEFAULT 0,

    overall_status VARCHAR(32) NOT NULL
        DEFAULT 'pending',

    compliance_score NUMERIC(5, 2),

    n8n_execution_id VARCHAR(255),

    started_at TIMESTAMPTZ,

    finished_at TIMESTAMPTZ,

    error_message TEXT,

    summary JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT opportunity_compliance_evaluation_version_check
        CHECK (
            evaluation_version > 0
        ),

    CONSTRAINT opportunity_compliance_evaluation_status_check
        CHECK (
            evaluation_status IN (
                'queued',
                'building',
                'completed',
                'failed',
                'archived'
            )
        ),

    CONSTRAINT opportunity_compliance_overall_status_check
        CHECK (
            overall_status IN (
                'pending',
                'ready',
                'ready_with_warnings',
                'not_ready',
                'manual_review'
            )
        ),

    CONSTRAINT opportunity_compliance_score_check
        CHECK (
            compliance_score IS NULL
            OR compliance_score BETWEEN 0 AND 100
        ),

    CONSTRAINT opportunity_compliance_counts_check
        CHECK (
            total_requirement_count >= 0
            AND bid_requirement_count >= 0
            AND compliant_count >= 0
            AND expiring_count >= 0
            AND expired_count >= 0
            AND missing_count >= 0
            AND non_compliant_count >= 0
            AND manual_review_count >= 0
            AND not_applicable_count >= 0
            AND verification_pending_count >= 0
        ),

    CONSTRAINT opportunity_compliance_input_unique
        UNIQUE
        (
            matrix_id,
            evaluation_version,
            input_hash_sha256
        )
);


/*
 * Solo puede existir una evaluación actual
 * por organización y oportunidad.
 */

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_current_opportunity_compliance_evaluation

ON saas.opportunity_compliance_evaluations
(
    organization_id,
    opportunity_analysis_id
)

WHERE is_current = TRUE;


/*
 * Índices operativos.
 */

CREATE INDEX IF NOT EXISTS
    idx_compliance_evaluations_matrix

ON saas.opportunity_compliance_evaluations
(
    matrix_id,
    evaluation_status
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_evaluations_organization

ON saas.opportunity_compliance_evaluations
(
    organization_id,
    evaluation_status,
    updated_at DESC
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_evaluations_execution

ON saas.opportunity_compliance_evaluations
(
    n8n_execution_id
);


/*
 * ------------------------------------------------------------
 * 3. Resultado individual por requisito
 * ------------------------------------------------------------
 */

CREATE TABLE IF NOT EXISTS
    saas.opportunity_compliance_evaluation_items
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    evaluation_id UUID NOT NULL
        REFERENCES
            saas.opportunity_compliance_evaluations(id)
        ON DELETE CASCADE,

    matrix_item_id UUID NOT NULL
        REFERENCES
            saas.opportunity_requirement_matrix_items(id)
        ON DELETE CASCADE,

    matrix_id UUID NOT NULL,

    organization_id UUID NOT NULL,

    opportunity_analysis_id UUID NOT NULL,

    process_id UUID NOT NULL,

    requirement_name TEXT NOT NULL,

    requirement_category VARCHAR(64),

    normalized_document_type VARCHAR(128),

    mandatory BOOLEAN NOT NULL
        DEFAULT TRUE,

    requirement_stage VARCHAR(64),

    applies_to VARCHAR(64),

    maximum_age_days INTEGER,

    compliance_status VARCHAR(40) NOT NULL,

    result_code VARCHAR(100) NOT NULL,

    selected_document_id UUID
        REFERENCES saas.organization_documents(id)
        ON DELETE SET NULL,

    matched_document_type TEXT,

    match_method VARCHAR(32) NOT NULL
        DEFAULT 'none',

    document_issue_date DATE,

    document_expiration_date DATE,

    document_renewal_status TEXT,

    document_verification_status TEXT,

    document_age_days INTEGER,

    age_compliant BOOLEAN,

    requires_review BOOLEAN NOT NULL
        DEFAULT FALSE,

    review_reason TEXT,

    is_automatic BOOLEAN NOT NULL
        DEFAULT TRUE,

    evidence JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    evaluated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT opportunity_compliance_item_unique
        UNIQUE
        (
            evaluation_id,
            matrix_item_id
        ),

    CONSTRAINT opportunity_compliance_item_status_check
        CHECK (
            compliance_status IN (
                'compliant',
                'expiring',
                'expired',
                'missing',
                'non_compliant',
                'manual_review',
                'not_applicable'
            )
        ),

    CONSTRAINT opportunity_compliance_item_match_method_check
        CHECK (
            match_method IN (
                'exact',
                'equivalent',
                'candidate_only',
                'none'
            )
        ),

    CONSTRAINT opportunity_compliance_item_age_check
        CHECK (
            maximum_age_days IS NULL
            OR maximum_age_days >= 0
        )
);


/*
 * Índices de los resultados individuales.
 */

CREATE INDEX IF NOT EXISTS
    idx_compliance_items_evaluation

ON saas.opportunity_compliance_evaluation_items
(
    evaluation_id,
    compliance_status
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_items_matrix_item

ON saas.opportunity_compliance_evaluation_items
(
    matrix_item_id
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_items_selected_document

ON saas.opportunity_compliance_evaluation_items
(
    selected_document_id
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_items_organization

ON saas.opportunity_compliance_evaluation_items
(
    organization_id,
    compliance_status
);


/*
 * ------------------------------------------------------------
 * 4. Documentos candidatos evaluados por requisito
 *
 * Permite conservar:
 * - documento elegido;
 * - documentos descartados;
 * - razón de descarte;
 * - tipo de equivalencia utilizada.
 * ------------------------------------------------------------
 */

CREATE TABLE IF NOT EXISTS
    saas.opportunity_compliance_evaluation_documents
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    evaluation_item_id UUID NOT NULL
        REFERENCES
            saas.opportunity_compliance_evaluation_items(id)
        ON DELETE CASCADE,

    organization_document_id UUID
        REFERENCES saas.organization_documents(id)
        ON DELETE SET NULL,

    match_rank INTEGER NOT NULL
        DEFAULT 1,

    is_selected BOOLEAN NOT NULL
        DEFAULT FALSE,

    match_method VARCHAR(32) NOT NULL,

    candidate_status VARCHAR(32) NOT NULL,

    candidate_score NUMERIC(5, 2),

    exclusion_reason TEXT,

    document_snapshot JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT compliance_evaluation_document_unique
        UNIQUE
        (
            evaluation_item_id,
            organization_document_id
        ),

    CONSTRAINT compliance_evaluation_document_method_check
        CHECK (
            match_method IN (
                'exact',
                'equivalent',
                'candidate_only'
            )
        ),

    CONSTRAINT compliance_evaluation_document_status_check
        CHECK (
            candidate_status IN (
                'selected',
                'eligible',
                'expired',
                'age_exceeded',
                'verification_rejected',
                'manual_review',
                'discarded'
            )
        ),

    CONSTRAINT compliance_evaluation_document_rank_check
        CHECK (
            match_rank > 0
        ),

    CONSTRAINT compliance_evaluation_document_score_check
        CHECK (
            candidate_score IS NULL
            OR candidate_score BETWEEN 0 AND 100
        )
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_documents_item

ON saas.opportunity_compliance_evaluation_documents
(
    evaluation_item_id,
    match_rank
);


CREATE INDEX IF NOT EXISTS
    idx_compliance_documents_document

ON saas.opportunity_compliance_evaluation_documents
(
    organization_document_id
);


/*
 * ------------------------------------------------------------
 * 5. Equivalencias iniciales confirmadas por los datos actuales
 * ------------------------------------------------------------
 */

INSERT INTO saas.document_type_equivalences
(
    requirement_document_type,
    organization_document_type,
    applies_to,
    match_mode,
    priority,
    is_active,
    notes,
    metadata,
    created_at,
    updated_at
)

VALUES
(
    'tax_id',
    'rut',
    '*',
    'equivalent',
    10,
    TRUE,
    'El tipo tax_id de la matriz corresponde al RUT empresarial.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1
    ),
    NOW(),
    NOW()
),

(
    'bank_certification',
    'bank_certificate',
    '*',
    'equivalent',
    10,
    TRUE,
    'Equivalencia entre certificación bancaria y bank_certificate.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1
    ),
    NOW(),
    NOW()
),

(
    'social_security_certificate',
    'social_security',
    '*',
    'candidate_only',
    50,
    TRUE,
    'Documento candidato; debe revisarse el contenido y la firma exigida.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1,
        'automatic_compliance_allowed',
        FALSE
    ),
    NOW(),
    NOW()
),

(
    'social_security_payment_certificate',
    'social_security',
    '*',
    'candidate_only',
    50,
    TRUE,
    'Documento candidato; puede requerir certificación adicional del representante o revisor fiscal.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1,
        'automatic_compliance_allowed',
        FALSE
    ),
    NOW(),
    NOW()
),

(
    'social_security_payment_proof',
    'social_security',
    '*',
    'candidate_only',
    50,
    TRUE,
    'Documento candidato; debe verificarse que contenga planilla y aportes requeridos.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1,
        'automatic_compliance_allowed',
        FALSE
    ),
    NOW(),
    NOW()
),

(
    'disciplinary_background',
    'disciplinary_background_legal_entity',
    'legal_entity',
    'equivalent',
    10,
    TRUE,
    'Antecedentes disciplinarios de la persona jurídica.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1
    ),
    NOW(),
    NOW()
),

(
    'disciplinary_background',
    'disciplinary_background_natural_person',
    'natural_person',
    'equivalent',
    10,
    TRUE,
    'Antecedentes disciplinarios de persona natural o representante legal.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'mapping_version',
        1
    ),
    NOW(),
    NOW()
)

ON CONFLICT
(
    requirement_document_type,
    organization_document_type,
    applies_to
)

DO UPDATE

SET
    match_mode =
        EXCLUDED.match_mode,

    priority =
        EXCLUDED.priority,

    is_active =
        EXCLUDED.is_active,

    notes =
        EXCLUDED.notes,

    metadata =
        COALESCE(
            saas.document_type_equivalences.metadata,
            '{}'::JSONB
        )
        ||
        EXCLUDED.metadata,

    updated_at =
        NOW();


/*
 * ------------------------------------------------------------
 * 6. Comentarios técnicos
 * ------------------------------------------------------------
 */

COMMENT ON TABLE
    saas.document_type_equivalences

IS
    'WF-017: equivalencias entre tipos de requisito y tipos de documentos empresariales.';


COMMENT ON TABLE
    saas.opportunity_compliance_evaluations

IS
    'WF-017: evaluación general de una empresa frente a una matriz consolidada de requisitos.';


COMMENT ON TABLE
    saas.opportunity_compliance_evaluation_items

IS
    'WF-017: resultado de cumplimiento para cada requisito individual de una oportunidad.';


COMMENT ON TABLE
    saas.opportunity_compliance_evaluation_documents

IS
    'WF-017: documentos empresariales candidatos considerados para cada requisito evaluado.';


-- ============================================================
-- Fuente auditada: Crear motor de evaluación WF-017
-- ============================================================

/*
 * ============================================================
 * WF-017 — MOTOR DE EVALUACIÓN DE CUMPLIMIENTO V1
 * ============================================================
 */


/*
 * Ampliar los resultados individuales con los campos necesarios
 * para conservar la lógica original de la matriz.
 */

ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    is_bid_requirement BOOLEAN NOT NULL
        DEFAULT FALSE;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    condition_text TEXT;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    requires_signature BOOLEAN NOT NULL
        DEFAULT FALSE;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    requires_entity_template BOOLEAN NOT NULL
        DEFAULT FALSE;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    requires_original BOOLEAN NOT NULL
        DEFAULT FALSE;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    requires_notarization BOOLEAN NOT NULL
        DEFAULT FALSE;


ALTER TABLE
    saas.opportunity_compliance_evaluation_items

ADD COLUMN IF NOT EXISTS
    requires_translation BOOLEAN NOT NULL
        DEFAULT FALSE;


/*
 * Eliminar una versión anterior de la función, en caso de existir.
 */

DROP FUNCTION IF EXISTS
    saas.evaluate_opportunity_compliance_v1
    (
        UUID,
        TEXT,
        INTEGER,
        TEXT,
        BOOLEAN
    );


CREATE FUNCTION
    saas.evaluate_opportunity_compliance_v1
    (
        p_matrix_id UUID,

        p_n8n_execution_id TEXT
            DEFAULT NULL,

        p_evaluation_version INTEGER
            DEFAULT 1,

        p_evaluation_method TEXT
            DEFAULT 'deterministic_v1',

        p_apply_changes BOOLEAN
            DEFAULT TRUE
    )

RETURNS TABLE
(
    evaluation_id UUID,

    matrix_id UUID,

    organization_id UUID,

    opportunity_analysis_id UUID,

    process_reference TEXT,

    evaluation_status TEXT,

    overall_status TEXT,

    compliance_score NUMERIC,

    total_requirement_count INTEGER,

    bid_requirement_count INTEGER,

    compliant_count INTEGER,

    expiring_count INTEGER,

    expired_count INTEGER,

    missing_count INTEGER,

    non_compliant_count INTEGER,

    manual_review_count INTEGER,

    not_applicable_count INTEGER,

    verification_pending_count INTEGER,

    input_hash_sha256 TEXT,

    result_code TEXT,

    changes_applied BOOLEAN
)

LANGUAGE plpgsql

AS
$$

DECLARE
    v_matrix
        saas.opportunity_requirement_matrices%ROWTYPE;

    v_existing
        saas.opportunity_compliance_evaluations%ROWTYPE;

    v_evaluation_id UUID;

    v_input_hash TEXT;

    v_evaluation_method TEXT;

    v_total_requirement_count INTEGER := 0;
    v_bid_requirement_count INTEGER := 0;

    v_compliant_count INTEGER := 0;
    v_expiring_count INTEGER := 0;
    v_expired_count INTEGER := 0;
    v_missing_count INTEGER := 0;
    v_non_compliant_count INTEGER := 0;
    v_manual_review_count INTEGER := 0;
    v_not_applicable_count INTEGER := 0;
    v_verification_pending_count INTEGER := 0;

    v_mandatory_bid_blocker_count INTEGER := 0;
    v_mandatory_bid_review_count INTEGER := 0;
    v_warning_count INTEGER := 0;

    v_overall_status TEXT;
    v_compliance_score NUMERIC(5, 2);

BEGIN
    /*
     * --------------------------------------------------------
     * 1. Validar configuración
     * --------------------------------------------------------
     */

    IF p_evaluation_version IS NULL
       OR p_evaluation_version <= 0
    THEN
        RAISE EXCEPTION
            'evaluation_version debe ser mayor que cero';
    END IF;

    v_evaluation_method :=
        COALESCE(
            NULLIF(
                BTRIM(
                    p_evaluation_method
                ),
                ''
            ),
            'deterministic_v1'
        );


    /*
     * --------------------------------------------------------
     * 2. Cargar y bloquear la matriz
     * --------------------------------------------------------
     */

    SELECT
        matrix.*

    INTO v_matrix

    FROM saas.opportunity_requirement_matrices
        AS matrix

    WHERE matrix.id =
          p_matrix_id

    FOR UPDATE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'No existe la matriz %',
            p_matrix_id;
    END IF;


    IF v_matrix.matrix_status <>
       'completed'
    THEN
        RAISE EXCEPTION
            'La matriz % no está completada. Estado actual: %',
            p_matrix_id,
            v_matrix.matrix_status;
    END IF;


    IF v_matrix.is_current IS DISTINCT FROM
       TRUE
    THEN
        RAISE EXCEPTION
            'La matriz % no es la versión actual',
            p_matrix_id;
    END IF;


    /*
     * --------------------------------------------------------
     * 3. Calcular hash de entrada
     *
     * Incluye:
     * - hash de la matriz;
     * - versión y método;
     * - documentos empresariales;
     * - equivalencias activas.
     * --------------------------------------------------------
     */

    SELECT
        ENCODE(
            DIGEST(
                CONVERT_TO(
                    CONCAT_WS(
                        '|',

                        v_matrix.id::TEXT,

                        v_matrix.input_hash_sha256::TEXT,

                        p_evaluation_version::TEXT,

                        v_evaluation_method,

                        COALESCE(
                            (
                                SELECT
                                    STRING_AGG(
                                        CONCAT_WS(
                                            ':',

                                            document.id::TEXT,

                                            document.document_type,

                                            COALESCE(
                                                document.issue_date::TEXT,
                                                ''
                                            ),

                                            COALESCE(
                                                document.expiration_date::TEXT,
                                                ''
                                            ),

                                            COALESCE(
                                                document.renewal_status,
                                                ''
                                            ),

                                            COALESCE(
                                                document.verification_status,
                                                ''
                                            ),

                                            COALESCE(
                                                document.document_status,
                                                ''
                                            ),

                                            COALESCE(
                                                document.updated_at::TEXT,
                                                ''
                                            )
                                        ),

                                        '|'

                                        ORDER BY
                                            document.id
                                    )

                                FROM saas.organization_documents
                                    AS document

                                WHERE document.organization_id =
                                      v_matrix.organization_id

                                  AND document.document_status IN (
                                      'uploaded',
                                      'active'
                                  )

                                  AND document.replaced_by_document_id
                                      IS NULL
                            ),
                            ''
                        ),

                        COALESCE(
                            (
                                SELECT
                                    STRING_AGG(
                                        CONCAT_WS(
                                            ':',

                                            equivalence.requirement_document_type,

                                            equivalence.organization_document_type,

                                            equivalence.applies_to,

                                            equivalence.match_mode,

                                            equivalence.priority::TEXT,

                                            equivalence.updated_at::TEXT
                                        ),

                                        '|'

                                        ORDER BY
                                            equivalence.requirement_document_type,
                                            equivalence.organization_document_type,
                                            equivalence.applies_to
                                    )

                                FROM saas.document_type_equivalences
                                    AS equivalence

                                WHERE equivalence.is_active =
                                      TRUE
                            ),
                            ''
                        )
                    ),

                    'UTF8'
                ),

                'sha256'
            ),

            'hex'
        )

    INTO v_input_hash;


    /*
     * --------------------------------------------------------
     * 4. Detectar evaluación idéntica ya completada
     * --------------------------------------------------------
     */

    SELECT
        evaluation.*

    INTO v_existing

    FROM saas.opportunity_compliance_evaluations
        AS evaluation

    WHERE evaluation.matrix_id =
          v_matrix.id

      AND evaluation.evaluation_version =
          p_evaluation_version

      AND evaluation.input_hash_sha256 =
          v_input_hash

    ORDER BY
        evaluation.created_at DESC

    LIMIT 1;


    IF FOUND
       AND p_apply_changes = TRUE
       AND v_existing.evaluation_status = 'completed'
       AND v_existing.is_current = TRUE
    THEN
        RETURN QUERY

        SELECT
            v_existing.id,

            v_existing.matrix_id,

            v_existing.organization_id,

            v_existing.opportunity_analysis_id,

            v_existing.process_reference,

            v_existing.evaluation_status::TEXT,

            v_existing.overall_status::TEXT,

            v_existing.compliance_score,

            v_existing.total_requirement_count,

            v_existing.bid_requirement_count,

            v_existing.compliant_count,

            v_existing.expiring_count,

            v_existing.expired_count,

            v_existing.missing_count,

            v_existing.non_compliant_count,

            v_existing.manual_review_count,

            v_existing.not_applicable_count,

            v_existing.verification_pending_count,

            v_existing.input_hash_sha256::TEXT,

            'already_current'::TEXT,

            FALSE;

        RETURN;
    END IF;


    /*
     * --------------------------------------------------------
     * 5. Preparar documentos candidatos
     * --------------------------------------------------------
     */

    DROP TABLE IF EXISTS
        tmp_wf017_candidates;


    CREATE TEMP TABLE
        tmp_wf017_candidates

    ON COMMIT DROP

    AS

    WITH candidate_matches AS (
        /*
         * Coincidencia exacta.
         */

        SELECT
            item.id
                AS matrix_item_id,

            document.id
                AS document_id,

            'exact'::VARCHAR(32)
                AS match_method,

            0::INTEGER
                AS mapping_priority,

            item.maximum_age_days,

            document.document_type,
            document.document_name,
            document.issue_date,
            document.expiration_date,
            document.renewal_due_date,
            document.renewal_status,
            document.verification_status,
            document.document_status,
            document.updated_at

        FROM saas.opportunity_requirement_matrix_items
            AS item

        JOIN saas.organization_documents
            AS document

            ON document.organization_id =
               item.organization_id

           AND LOWER(
                   BTRIM(
                       document.document_type
                   )
               ) =
               LOWER(
                   BTRIM(
                       item.normalized_document_type
                   )
               )

        WHERE item.matrix_id =
              v_matrix.id

          AND item.item_status =
              'active'

          AND document.document_status IN (
              'uploaded',
              'active'
          )

          AND document.replaced_by_document_id
              IS NULL


        UNION ALL


        /*
         * Coincidencia mediante equivalencias.
         */

        SELECT
            item.id
                AS matrix_item_id,

            document.id
                AS document_id,

            equivalence.match_mode
                AS match_method,

            equivalence.priority
                AS mapping_priority,

            item.maximum_age_days,

            document.document_type,
            document.document_name,
            document.issue_date,
            document.expiration_date,
            document.renewal_due_date,
            document.renewal_status,
            document.verification_status,
            document.document_status,
            document.updated_at

        FROM saas.opportunity_requirement_matrix_items
            AS item

        JOIN saas.document_type_equivalences
            AS equivalence

            ON LOWER(
                   BTRIM(
                       equivalence.requirement_document_type
                   )
               ) =
               LOWER(
                   BTRIM(
                       item.normalized_document_type
                   )
               )

           AND equivalence.is_active =
               TRUE

           AND (
               equivalence.applies_to = '*'

               OR

               equivalence.applies_to =
                   COALESCE(
                       item.applies_to,
                       ''
                   )
           )

        JOIN saas.organization_documents
            AS document

            ON document.organization_id =
               item.organization_id

           AND LOWER(
                   BTRIM(
                       document.document_type
                   )
               ) =
               LOWER(
                   BTRIM(
                       equivalence.organization_document_type
                   )
               )

        WHERE item.matrix_id =
              v_matrix.id

          AND item.item_status =
              'active'

          AND document.document_status IN (
              'uploaded',
              'active'
          )

          AND document.replaced_by_document_id
              IS NULL
    ),

    deduplicated_matches AS (
        SELECT DISTINCT ON (
            candidate.matrix_item_id,
            candidate.document_id
        )
            candidate.*

        FROM candidate_matches
            AS candidate

        ORDER BY
            candidate.matrix_item_id,
            candidate.document_id,

            CASE candidate.match_method
                WHEN 'exact'
                    THEN 1

                WHEN 'equivalent'
                    THEN 2

                ELSE 3
            END,

            candidate.mapping_priority
    ),

    scored_candidates AS (
        SELECT
            candidate.*,

            CASE
                WHEN candidate.issue_date
                     IS NULL
                    THEN NULL

                ELSE (
                    CURRENT_DATE
                    -
                    candidate.issue_date
                )::INTEGER
            END
                AS document_age_days,

            CASE
                WHEN candidate.maximum_age_days
                     IS NULL
                    THEN NULL

                WHEN candidate.issue_date
                     IS NULL
                    THEN FALSE

                ELSE (
                    CURRENT_DATE
                    -
                    candidate.issue_date
                ) <=
                candidate.maximum_age_days
            END
                AS age_compliant,

            GREATEST(
                0,

                100

                -
                CASE candidate.match_method
                    WHEN 'exact'
                        THEN 0

                    WHEN 'equivalent'
                        THEN 5

                    ELSE 20
                END

                -
                CASE
                    WHEN candidate.renewal_status =
                         'current'
                        THEN 0

                    WHEN candidate.renewal_status =
                         'expiring'
                        THEN 15

                    WHEN candidate.renewal_status =
                         'expired'
                        THEN 60

                    ELSE 30
                END

                -
                CASE
                    WHEN candidate.verification_status =
                         'verified'
                        THEN 0

                    WHEN candidate.verification_status =
                         'pending'
                        THEN 5

                    WHEN candidate.verification_status =
                         'rejected'
                        THEN 100

                    ELSE 10
                END

                -
                CASE
                    WHEN candidate.maximum_age_days
                         IS NOT NULL

                     AND (
                         candidate.issue_date IS NULL

                         OR

                         (
                             CURRENT_DATE
                             -
                             candidate.issue_date
                         ) >
                         candidate.maximum_age_days
                     )
                        THEN 40

                    ELSE 0
                END
            )::NUMERIC(5, 2)
                AS candidate_score

        FROM deduplicated_matches
            AS candidate
    )

    SELECT
        candidate.*,

        ROW_NUMBER() OVER (
            PARTITION BY
                candidate.matrix_item_id

            ORDER BY
                candidate.candidate_score DESC,

                CASE candidate.match_method
                    WHEN 'exact'
                        THEN 1

                    WHEN 'equivalent'
                        THEN 2

                    ELSE 3
                END,

                candidate.issue_date DESC
                    NULLS LAST,

                candidate.updated_at DESC,

                candidate.document_id
        )::INTEGER
            AS match_rank

    FROM scored_candidates
        AS candidate;


    /*
     * --------------------------------------------------------
     * 6. Evaluar cada requisito
     *
     * WF-017 V1 evalúa preparación para presentar oferta.
     * Los requisitos posteriores a la adjudicación se conservan
     * como not_applicable para el indicador de alistamiento.
     * --------------------------------------------------------
     */

    DROP TABLE IF EXISTS
        tmp_wf017_results;


    CREATE TEMP TABLE
        tmp_wf017_results

    ON COMMIT DROP

    AS

    WITH selected_candidates AS (
        SELECT
            candidate.*

        FROM tmp_wf017_candidates
            AS candidate

        WHERE candidate.match_rank = 1
    ),

    candidate_counts AS (
        SELECT
            candidate.matrix_item_id,

            COUNT(*)::INTEGER
                AS candidate_count

        FROM tmp_wf017_candidates
            AS candidate

        GROUP BY
            candidate.matrix_item_id
    )

    SELECT
        item.id
            AS matrix_item_id,

        item.matrix_id,
        item.organization_id,
        item.opportunity_analysis_id,
        item.process_id,

        item.requirement_name,
        item.requirement_category,
        item.normalized_document_type,

        item.mandatory,
        item.requirement_stage,
        item.is_bid_requirement,
        item.applies_to,
        item.condition_text,

        item.maximum_age_days,

        item.requires_signature,
        item.requires_entity_template,
        item.requires_original,
        item.requires_notarization,
        item.requires_translation,

        candidate.document_id
            AS selected_document_id,

        candidate.document_type
            AS matched_document_type,

        COALESCE(
            candidate.match_method,
            'none'
        )::VARCHAR(32)
            AS match_method,

        candidate.issue_date
            AS document_issue_date,

        candidate.expiration_date
            AS document_expiration_date,

        candidate.renewal_status
            AS document_renewal_status,

        candidate.verification_status
            AS document_verification_status,

        candidate.document_age_days,

        candidate.age_compliant,

        /*
         * Estado principal.
         */

        CASE
            WHEN item.is_bid_requirement =
                 FALSE
                THEN 'not_applicable'

            WHEN item.normalized_document_type
                 IS NULL

              OR BTRIM(
                     item.normalized_document_type
                 ) = ''

              OR LOWER(
                     BTRIM(
                         item.normalized_document_type
                     )
                 ) = 'other'
                THEN 'manual_review'

            WHEN item.requires_entity_template =
                 TRUE
                THEN 'manual_review'

            WHEN item.requires_notarization = TRUE

              OR item.requires_translation = TRUE

              OR item.requires_original = TRUE
                THEN 'manual_review'

            WHEN candidate.document_id IS NULL
             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN 'manual_review'

            WHEN candidate.document_id IS NULL
                THEN 'missing'

            WHEN candidate.match_method =
                 'candidate_only'
                THEN 'manual_review'

            WHEN candidate.verification_status =
                 'rejected'
                THEN 'non_compliant'

            WHEN item.maximum_age_days IS NOT NULL
             AND candidate.issue_date IS NULL
                THEN 'manual_review'

            WHEN candidate.age_compliant =
                 FALSE
                THEN 'non_compliant'

            WHEN candidate.renewal_status =
                 'expired'

              OR (
                  candidate.expiration_date
                      IS NOT NULL

                  AND CURRENT_DATE >=
                      candidate.expiration_date
              )
                THEN 'expired'

            WHEN candidate.renewal_status =
                 'expiring'
                THEN 'expiring'

            ELSE 'compliant'
        END::VARCHAR(40)
            AS compliance_status,

        /*
         * Código explicativo.
         */

        CASE
            WHEN item.is_bid_requirement =
                 FALSE
                THEN 'POST_AWARD_REQUIREMENT'

            WHEN item.normalized_document_type
                 IS NULL

              OR BTRIM(
                     item.normalized_document_type
                 ) = ''

              OR LOWER(
                     BTRIM(
                         item.normalized_document_type
                     )
                 ) = 'other'
                THEN 'NON_STANDARD_REQUIREMENT'

            WHEN item.requires_entity_template =
                 TRUE
                THEN 'ENTITY_TEMPLATE_REQUIRED'

            WHEN item.requires_notarization = TRUE

              OR item.requires_translation = TRUE

              OR item.requires_original = TRUE
                THEN 'DOCUMENT_FORMALITY_REVIEW_REQUIRED'

            WHEN candidate.document_id IS NULL
             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN 'CONDITIONAL_REQUIREMENT_REVIEW'

            WHEN candidate.document_id IS NULL
                THEN 'DOCUMENT_MISSING'

            WHEN candidate.match_method =
                 'candidate_only'
                THEN 'CANDIDATE_DOCUMENT_REQUIRES_REVIEW'

            WHEN candidate.verification_status =
                 'rejected'
                THEN 'DOCUMENT_VERIFICATION_REJECTED'

            WHEN item.maximum_age_days IS NOT NULL
             AND candidate.issue_date IS NULL
                THEN 'ISSUE_DATE_REQUIRED_FOR_MAXIMUM_AGE'

            WHEN candidate.age_compliant =
                 FALSE
                THEN 'MAXIMUM_AGE_EXCEEDED'

            WHEN candidate.renewal_status =
                 'expired'

              OR (
                  candidate.expiration_date
                      IS NOT NULL

                  AND CURRENT_DATE >=
                      candidate.expiration_date
              )
                THEN 'DOCUMENT_EXPIRED'

            WHEN candidate.renewal_status =
                 'expiring'
                THEN 'DOCUMENT_EXPIRING'

            WHEN item.requires_signature = TRUE
                THEN 'DOCUMENT_CURRENT_SIGNATURE_REVIEW'

            WHEN candidate.verification_status =
                 'pending'
                THEN 'DOCUMENT_CURRENT_VERIFICATION_PENDING'

            ELSE 'DOCUMENT_CURRENT'
        END::VARCHAR(100)
            AS result_code,

        /*
         * Revisión complementaria.
         */

        CASE
            WHEN item.is_bid_requirement =
                 FALSE
                THEN FALSE

            WHEN item.normalized_document_type
                 IS NULL

              OR LOWER(
                     BTRIM(
                         COALESCE(
                             item.normalized_document_type,
                             ''
                         )
                     )
                 ) = 'other'
                THEN TRUE

            WHEN item.requires_entity_template = TRUE

              OR item.requires_signature = TRUE

              OR item.requires_notarization = TRUE

              OR item.requires_translation = TRUE

              OR item.requires_original = TRUE
                THEN TRUE

            WHEN candidate.match_method =
                 'candidate_only'
                THEN TRUE

            WHEN candidate.verification_status =
                 'pending'
                THEN TRUE

            WHEN item.condition_text
                 IS NOT NULL
                THEN TRUE

            ELSE FALSE
        END
            AS requires_review,

        CASE
            WHEN item.is_bid_requirement =
                 FALSE
                THEN NULL

            WHEN item.normalized_document_type
                 IS NULL

              OR LOWER(
                     BTRIM(
                         COALESCE(
                             item.normalized_document_type,
                             ''
                         )
                     )
                 ) = 'other'
                THEN
                    'El requisito no posee un tipo documental específico.'

            WHEN item.requires_entity_template =
                 TRUE
                THEN
                    'Debe diligenciarse el formato oficial de la entidad.'

            WHEN candidate.match_method =
                 'candidate_only'
                THEN
                    'Existe un documento candidato, pero no es una equivalencia automática definitiva.'

            WHEN candidate.verification_status =
                 'pending'
                THEN
                    'El documento todavía tiene verificación pendiente.'

            WHEN item.requires_signature =
                 TRUE
                THEN
                    'Debe comprobarse la firma exigida.'

            WHEN item.condition_text
                 IS NOT NULL
                THEN
                    'Debe comprobarse si se cumple la condición de aplicabilidad.'

            ELSE NULL
        END
            AS review_reason,

        CASE
            WHEN item.normalized_document_type
                 IS NULL

              OR LOWER(
                     BTRIM(
                         COALESCE(
                             item.normalized_document_type,
                             ''
                         )
                     )
                 ) = 'other'

              OR item.requires_entity_template = TRUE

              OR item.requires_notarization = TRUE

              OR item.requires_translation = TRUE

              OR item.requires_original = TRUE

              OR candidate.match_method =
                 'candidate_only'
                THEN FALSE

            ELSE TRUE
        END
            AS is_automatic,

        jsonb_build_object(
            'candidate_count',
            COALESCE(
                candidate_count.candidate_count,
                0
            ),

            'selected_document_id',
            candidate.document_id,

            'selected_document_name',
            candidate.document_name,

            'candidate_score',
            candidate.candidate_score,

            'mapping_priority',
            candidate.mapping_priority,

            'matrix_item_conflict_status',
            item.conflict_status,

            'matrix_item_confidence_score',
            item.confidence_score,

            'evaluated_by',
            'WF-017',

            'evaluation_method',
            v_evaluation_method,

            'evaluation_version',
            p_evaluation_version
        )
            AS evidence,

        jsonb_build_object(
            'canonical_requirement_key',
            item.canonical_requirement_key,

            'source_requirement_count',
            item.source_requirement_count,

            'source_document_count',
            item.source_document_count
        )
            AS metadata

    FROM saas.opportunity_requirement_matrix_items
        AS item

    LEFT JOIN selected_candidates
        AS candidate

        ON candidate.matrix_item_id =
           item.id

    LEFT JOIN candidate_counts
        AS candidate_count

        ON candidate_count.matrix_item_id =
           item.id

    WHERE item.matrix_id =
          v_matrix.id

      AND item.item_status =
          'active';


    /*
     * --------------------------------------------------------
     * 7. Calcular métricas
     * --------------------------------------------------------
     */

    SELECT
        COUNT(*)::INTEGER,

        COUNT(*) FILTER (
            WHERE result.is_bid_requirement =
                  TRUE
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'compliant'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'expiring'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'expired'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'missing'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'non_compliant'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'manual_review'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.compliance_status =
                  'not_applicable'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.selected_document_id
                  IS NOT NULL

              AND result.document_verification_status =
                  'pending'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.is_bid_requirement = TRUE

              AND result.mandatory = TRUE

              AND result.compliance_status IN (
                  'missing',
                  'expired',
                  'non_compliant'
              )
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.is_bid_requirement = TRUE

              AND result.mandatory = TRUE

              AND result.compliance_status =
                  'manual_review'
        )::INTEGER,

        COUNT(*) FILTER (
            WHERE result.is_bid_requirement = TRUE

              AND (
                  result.compliance_status =
                      'expiring'

                  OR result.requires_review =
                      TRUE
              )
        )::INTEGER

    INTO
        v_total_requirement_count,
        v_bid_requirement_count,

        v_compliant_count,
        v_expiring_count,
        v_expired_count,
        v_missing_count,
        v_non_compliant_count,
        v_manual_review_count,
        v_not_applicable_count,
        v_verification_pending_count,

        v_mandatory_bid_blocker_count,
        v_mandatory_bid_review_count,
        v_warning_count

    FROM tmp_wf017_results
        AS result;


    v_overall_status :=
        CASE
            WHEN v_mandatory_bid_blocker_count > 0
                THEN 'not_ready'

            WHEN v_mandatory_bid_review_count > 0
                THEN 'manual_review'

            WHEN v_warning_count > 0
                THEN 'ready_with_warnings'

            ELSE 'ready'
        END;


    SELECT
        COALESCE(
            ROUND(
                (
                    SUM(
                        CASE
                            WHEN result.compliance_status =
                                 'compliant'

                             AND result.document_verification_status =
                                 'pending'
                                THEN 0.90

                            WHEN result.compliance_status =
                                 'compliant'
                                THEN 1.00

                            WHEN result.compliance_status =
                                 'expiring'
                                THEN 0.80

                            WHEN result.compliance_status =
                                 'manual_review'
                                THEN 0.50

                            ELSE 0.00
                        END
                    )
                    *
                    100.00
                )
                /
                NULLIF(
                    COUNT(*)::NUMERIC,
                    0
                ),

                2
            ),

            100.00
        )

    INTO v_compliance_score

    FROM tmp_wf017_results
        AS result

    WHERE result.is_bid_requirement =
          TRUE

      AND result.mandatory =
          TRUE

      AND result.compliance_status <>
          'not_applicable';


    /*
     * --------------------------------------------------------
     * 8. Vista previa
     * --------------------------------------------------------
     */

    IF p_apply_changes = FALSE THEN
        RETURN QUERY

        SELECT
            NULL::UUID,

            v_matrix.id,

            v_matrix.organization_id,

            v_matrix.opportunity_analysis_id,

            v_matrix.process_reference,

            'preview'::TEXT,

            v_overall_status,

            v_compliance_score,

            v_total_requirement_count,

            v_bid_requirement_count,

            v_compliant_count,

            v_expiring_count,

            v_expired_count,

            v_missing_count,

            v_non_compliant_count,

            v_manual_review_count,

            v_not_applicable_count,

            v_verification_pending_count,

            v_input_hash,

            'preview_completed'::TEXT,

            FALSE;

        RETURN;
    END IF;


    /*
     * --------------------------------------------------------
     * 9. Archivar evaluación actual anterior
     * --------------------------------------------------------
     */

    UPDATE saas.opportunity_compliance_evaluations
        AS evaluation

    SET
        is_current =
            FALSE,

        evaluation_status =
            CASE
                WHEN evaluation.evaluation_status =
                     'completed'
                    THEN 'archived'

                ELSE evaluation.evaluation_status
            END,

        updated_at =
            NOW()

    WHERE evaluation.organization_id =
          v_matrix.organization_id

      AND evaluation.opportunity_analysis_id =
          v_matrix.opportunity_analysis_id

      AND evaluation.is_current =
          TRUE

      AND (
          v_existing.id IS NULL

          OR evaluation.id <>
             v_existing.id
      );


    /*
     * --------------------------------------------------------
     * 10. Crear o reconstruir cabecera
     * --------------------------------------------------------
     */

    IF v_existing.id IS NULL THEN
        INSERT INTO
            saas.opportunity_compliance_evaluations
        (
            organization_id,
            opportunity_analysis_id,
            process_id,
            process_reference,
            matrix_id,

            evaluation_version,
            evaluation_method,
            input_hash_sha256,

            evaluation_status,
            is_current,
            overall_status,

            n8n_execution_id,
            started_at,

            metadata,

            created_at,
            updated_at
        )

        VALUES
        (
            v_matrix.organization_id,
            v_matrix.opportunity_analysis_id,
            v_matrix.process_id,
            v_matrix.process_reference,
            v_matrix.id,

            p_evaluation_version,
            v_evaluation_method,
            v_input_hash,

            'building',
            TRUE,
            'pending',

            NULLIF(
                BTRIM(
                    COALESCE(
                        p_n8n_execution_id,
                        ''
                    )
                ),
                ''
            ),

            NOW(),

            jsonb_build_object(
                'workflow_code',
                'WF-017',

                'matrix_input_hash',
                v_matrix.input_hash_sha256,

                'created_by',
                'WF-017'
            ),

            NOW(),
            NOW()
        )

        RETURNING id
        INTO v_evaluation_id;

    ELSE
        v_evaluation_id :=
            v_existing.id;

        UPDATE saas.opportunity_compliance_evaluations
            AS evaluation

        SET
            evaluation_status =
                'building',

            is_current =
                TRUE,

            overall_status =
                'pending',

            n8n_execution_id =
                NULLIF(
                    BTRIM(
                        COALESCE(
                            p_n8n_execution_id,
                            ''
                        )
                    ),
                    ''
                ),

            started_at =
                NOW(),

            finished_at =
                NULL,

            error_message =
                NULL,

            metadata =
                COALESCE(
                    evaluation.metadata,
                    '{}'::JSONB
                )
                ||
                jsonb_build_object(
                    'rebuild_started_at',
                    NOW(),

                    'rebuild_execution_id',
                    p_n8n_execution_id,

                    'rebuilt_by',
                    'WF-017'
                ),

            updated_at =
                NOW()

        WHERE evaluation.id =
              v_evaluation_id;


        DELETE FROM
            saas.opportunity_compliance_evaluation_items
                AS evaluation_item

        WHERE evaluation_item.evaluation_id =
              v_evaluation_id;
    END IF;


    /*
     * --------------------------------------------------------
     * 11. Insertar resultados individuales
     * --------------------------------------------------------
     */

    DROP TABLE IF EXISTS
        tmp_wf017_item_map;


    CREATE TEMP TABLE
        tmp_wf017_item_map

    ON COMMIT DROP

    AS

    WITH inserted_items AS (
        INSERT INTO
            saas.opportunity_compliance_evaluation_items
        (
            evaluation_id,
            matrix_item_id,
            matrix_id,

            organization_id,
            opportunity_analysis_id,
            process_id,

            requirement_name,
            requirement_category,
            normalized_document_type,

            mandatory,
            requirement_stage,
            is_bid_requirement,
            applies_to,
            condition_text,

            maximum_age_days,

            requires_signature,
            requires_entity_template,
            requires_original,
            requires_notarization,
            requires_translation,

            compliance_status,
            result_code,

            selected_document_id,
            matched_document_type,
            match_method,

            document_issue_date,
            document_expiration_date,
            document_renewal_status,
            document_verification_status,
            document_age_days,

            age_compliant,

            requires_review,
            review_reason,
            is_automatic,

            evidence,
            metadata,

            evaluated_at,
            created_at,
            updated_at
        )

        SELECT
            v_evaluation_id,
            result.matrix_item_id,
            result.matrix_id,

            result.organization_id,
            result.opportunity_analysis_id,
            result.process_id,

            result.requirement_name,
            result.requirement_category,
            result.normalized_document_type,

            result.mandatory,
            result.requirement_stage,
            result.is_bid_requirement,
            result.applies_to,
            result.condition_text,

            result.maximum_age_days,

            result.requires_signature,
            result.requires_entity_template,
            result.requires_original,
            result.requires_notarization,
            result.requires_translation,

            result.compliance_status,
            result.result_code,

            result.selected_document_id,
            result.matched_document_type,
            result.match_method,

            result.document_issue_date,
            result.document_expiration_date,
            result.document_renewal_status,
            result.document_verification_status,
            result.document_age_days,

            result.age_compliant,

            result.requires_review,
            result.review_reason,
            result.is_automatic,

            result.evidence,
            result.metadata,

            NOW(),
            NOW(),
            NOW()

        FROM tmp_wf017_results
            AS result

        RETURNING
            id,
            matrix_item_id
    )

    SELECT
        inserted.id
            AS evaluation_item_id,

        inserted.matrix_item_id

    FROM inserted_items
        AS inserted;


    /*
     * --------------------------------------------------------
     * 12. Guardar candidatos considerados
     * --------------------------------------------------------
     */

    INSERT INTO
        saas.opportunity_compliance_evaluation_documents
    (
        evaluation_item_id,
        organization_document_id,

        match_rank,
        is_selected,

        match_method,
        candidate_status,
        candidate_score,

        exclusion_reason,

        document_snapshot,
        metadata,

        created_at
    )

    SELECT
        item_map.evaluation_item_id,

        candidate.document_id,

        candidate.match_rank,

        candidate.match_rank = 1,

        candidate.match_method,

        CASE
            WHEN candidate.match_rank = 1
                THEN 'selected'

            WHEN candidate.verification_status =
                 'rejected'
                THEN 'verification_rejected'

            WHEN candidate.age_compliant =
                 FALSE
                THEN 'age_exceeded'

            WHEN candidate.renewal_status =
                 'expired'
                THEN 'expired'

            WHEN candidate.match_method =
                 'candidate_only'
                THEN 'manual_review'

            ELSE 'eligible'
        END,

        candidate.candidate_score,

        CASE
            WHEN candidate.match_rank = 1
                THEN NULL

            ELSE
                'Existe otro documento con una puntuación superior.'
        END,

        jsonb_build_object(
            'document_type',
            candidate.document_type,

            'document_name',
            candidate.document_name,

            'issue_date',
            candidate.issue_date,

            'expiration_date',
            candidate.expiration_date,

            'renewal_due_date',
            candidate.renewal_due_date,

            'renewal_status',
            candidate.renewal_status,

            'verification_status',
            candidate.verification_status,

            'document_age_days',
            candidate.document_age_days,

            'age_compliant',
            candidate.age_compliant
        ),

        jsonb_build_object(
            'evaluated_by',
            'WF-017',

            'evaluation_version',
            p_evaluation_version
        ),

        NOW()

    FROM tmp_wf017_candidates
        AS candidate

    JOIN tmp_wf017_item_map
        AS item_map

        ON item_map.matrix_item_id =
           candidate.matrix_item_id;


    /*
     * --------------------------------------------------------
     * 13. Finalizar cabecera
     * --------------------------------------------------------
     */

    UPDATE saas.opportunity_compliance_evaluations
        AS evaluation

    SET
        evaluation_status =
            'completed',

        is_current =
            TRUE,

        total_requirement_count =
            v_total_requirement_count,

        bid_requirement_count =
            v_bid_requirement_count,

        compliant_count =
            v_compliant_count,

        expiring_count =
            v_expiring_count,

        expired_count =
            v_expired_count,

        missing_count =
            v_missing_count,

        non_compliant_count =
            v_non_compliant_count,

        manual_review_count =
            v_manual_review_count,

        not_applicable_count =
            v_not_applicable_count,

        verification_pending_count =
            v_verification_pending_count,

        overall_status =
            v_overall_status,

        compliance_score =
            v_compliance_score,

        finished_at =
            NOW(),

        error_message =
            NULL,

        summary =
            jsonb_build_object(
                'mandatory_bid_blocker_count',
                v_mandatory_bid_blocker_count,

                'mandatory_bid_review_count',
                v_mandatory_bid_review_count,

                'warning_count',
                v_warning_count,

                'selected_document_count',
                (
                    SELECT COUNT(*)::INTEGER

                    FROM tmp_wf017_results
                        AS result

                    WHERE result.selected_document_id
                          IS NOT NULL
                ),

                'evaluated_at',
                NOW(),

                'evaluation_version',
                p_evaluation_version,

                'evaluation_method',
                v_evaluation_method
            ),

        metadata =
            COALESCE(
                evaluation.metadata,
                '{}'::JSONB
            )
            ||
            jsonb_build_object(
                'completed_by',
                'WF-017',

                'completed_execution_id',
                p_n8n_execution_id,

                'completed_at',
                NOW()
            ),

        updated_at =
            NOW()

    WHERE evaluation.id =
          v_evaluation_id;


    /*
     * --------------------------------------------------------
     * 14. Resultado
     * --------------------------------------------------------
     */

    RETURN QUERY

    SELECT
        v_evaluation_id,

        v_matrix.id,

        v_matrix.organization_id,

        v_matrix.opportunity_analysis_id,

        v_matrix.process_reference,

        'completed'::TEXT,

        v_overall_status,

        v_compliance_score,

        v_total_requirement_count,

        v_bid_requirement_count,

        v_compliant_count,

        v_expiring_count,

        v_expired_count,

        v_missing_count,

        v_non_compliant_count,

        v_manual_review_count,

        v_not_applicable_count,

        v_verification_pending_count,

        v_input_hash,

        'evaluation_completed'::TEXT,

        TRUE;

END;

$$;


COMMENT ON FUNCTION
    saas.evaluate_opportunity_compliance_v1
    (
        UUID,
        TEXT,
        INTEGER,
        TEXT,
        BOOLEAN
    )

IS
    'WF-017 V1: evalúa determinísticamente una empresa frente a una matriz consolidada, selecciona documentos candidatos y calcula preparación para presentar oferta.';


-- ============================================================
-- Fuente auditada: Crear motor V3 WF-017
-- ============================================================

/*
 * ============================================================
 * WF-017
 * MOTOR DE EVALUACIÓN DE CUMPLIMIENTO V3
 * ============================================================
 */


/*
 * ------------------------------------------------------------
 * 1. Reglas adicionales para requisitos especializados
 * ------------------------------------------------------------
 */

INSERT INTO saas.requirement_evaluation_rules
(
    requirement_document_type,
    applies_to,
    evaluation_strategy,
    priority,
    is_active,
    notes,
    metadata,
    created_at,
    updated_at
)

VALUES
(
    'experience_certificate',
    '*',
    'specialized_evaluator',
    20,
    TRUE,
    'La experiencia contractual requiere validar número de contratos, valores, objeto, porcentaje exigido y condiciones específicas del proceso.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'rule_version',
        3
    ),
    NOW(),
    NOW()
),

(
    'technical_certificate',
    '*',
    'specialized_evaluator',
    30,
    TRUE,
    'El requisito técnico puede requerir validación de características, alcance o contenido específico.',
    jsonb_build_object(
        'created_by',
        'WF-017',
        'rule_version',
        3
    ),
    NOW(),
    NOW()
)

ON CONFLICT
(
    requirement_document_type,
    applies_to
)

DO UPDATE

SET
    evaluation_strategy =
        EXCLUDED.evaluation_strategy,

    priority =
        EXCLUDED.priority,

    is_active =
        EXCLUDED.is_active,

    notes =
        EXCLUDED.notes,

    metadata =
        COALESCE(
            saas.requirement_evaluation_rules.metadata,
            '{}'::JSONB
        )
        ||
        EXCLUDED.metadata,

    updated_at =
        NOW();


/*
 * ------------------------------------------------------------
 * 2. Eliminar versión anterior de V3
 * ------------------------------------------------------------
 */

DROP FUNCTION IF EXISTS
    saas.evaluate_opportunity_compliance_v3
    (
        UUID,
        TEXT
    );


/*
 * ------------------------------------------------------------
 * 3. Crear V3
 * ------------------------------------------------------------
 */

CREATE FUNCTION
    saas.evaluate_opportunity_compliance_v3
    (
        p_matrix_id UUID,
        p_n8n_execution_id TEXT
            DEFAULT NULL
    )

RETURNS TABLE
(
    evaluation_id UUID,

    matrix_id UUID,

    organization_id UUID,

    opportunity_analysis_id UUID,

    process_reference TEXT,

    evaluation_status TEXT,

    overall_status TEXT,

    compliance_score NUMERIC,

    total_requirement_count INTEGER,

    bid_requirement_count INTEGER,

    compliant_count INTEGER,

    expiring_count INTEGER,

    expired_count INTEGER,

    missing_count INTEGER,

    non_compliant_count INTEGER,

    manual_review_count INTEGER,

    not_applicable_count INTEGER,

    verification_pending_count INTEGER,

    mandatory_bid_blocker_count INTEGER,

    mandatory_bid_review_count INTEGER,

    warning_count INTEGER,

    base_result_code TEXT,

    result_code TEXT,

    evaluation_version INTEGER,

    evaluation_method TEXT,

    changes_applied BOOLEAN,

    evaluated_at TIMESTAMPTZ
)

LANGUAGE plpgsql

AS
$$

DECLARE

    v_base RECORD;
    v_rules RECORD;

    v_evaluation_id UUID;

    v_total_requirement_count INTEGER := 0;
    v_bid_requirement_count INTEGER := 0;

    v_compliant_count INTEGER := 0;
    v_expiring_count INTEGER := 0;
    v_expired_count INTEGER := 0;
    v_missing_count INTEGER := 0;
    v_non_compliant_count INTEGER := 0;
    v_manual_review_count INTEGER := 0;
    v_not_applicable_count INTEGER := 0;
    v_verification_pending_count INTEGER := 0;

    v_mandatory_bid_blocker_count INTEGER := 0;
    v_mandatory_bid_review_count INTEGER := 0;
    v_warning_count INTEGER := 0;

    v_overall_status TEXT;

    v_compliance_score NUMERIC(5, 2);

BEGIN

    /*
     * --------------------------------------------------------
     * 4. Construcción base
     *
     * V1 sigue siendo el constructor transaccional probado.
     * El workflow productivo solamente invocará V3.
     * --------------------------------------------------------
     */

    SELECT
        base.*

    INTO v_base

    FROM saas.evaluate_opportunity_compliance_v1
    (
        p_matrix_id,
        p_n8n_execution_id,
        3,
        'deterministic_v3',
        TRUE
    )
        AS base

    LIMIT 1;


    IF v_base.evaluation_id IS NULL THEN

        RAISE EXCEPTION
            'WF-017 V3 no recibió evaluation_id para la matriz %',
            p_matrix_id;

    END IF;


    v_evaluation_id :=
        v_base.evaluation_id;


    /*
     * --------------------------------------------------------
     * 5. Aplicar reglas semánticas V2 previamente validadas
     * --------------------------------------------------------
     */

    SELECT
        rules.*

    INTO v_rules

    FROM saas.apply_opportunity_compliance_rules_v2
    (
        v_evaluation_id,
        TRUE
    )
        AS rules

    LIMIT 1;


    /*
     * --------------------------------------------------------
     * 6. Crear resultado determinístico final V3
     * --------------------------------------------------------
     */

    DROP TABLE IF EXISTS
        tmp_wf017_v3_results;


    CREATE TEMP TABLE
        tmp_wf017_v3_results

    ON COMMIT DROP

    AS

    SELECT

        item.id
            AS evaluation_item_id,

        item.evaluation_id,
        item.matrix_item_id,
        item.matrix_id,

        item.organization_id,
        item.opportunity_analysis_id,
        item.process_id,

        item.requirement_name,
        item.requirement_category,
        item.normalized_document_type,

        item.mandatory,
        item.is_bid_requirement,
        item.requirement_stage,
        item.applies_to,

        item.condition_text,
        item.maximum_age_days,

        item.requires_signature,
        item.requires_entity_template,
        item.requires_original,
        item.requires_notarization,
        item.requires_translation,

        item.selected_document_id,

        document.document_type
            AS actual_document_type,

        document.document_name
            AS actual_document_name,

        document.issue_date
            AS actual_issue_date,

        document.expiration_date
            AS actual_expiration_date,

        document.renewal_due_date
            AS actual_renewal_due_date,

        document.alert_due_date
            AS actual_alert_due_date,

        document.renewal_status
            AS stored_renewal_status,

        document.verification_status
            AS actual_verification_status,

        document.document_status
            AS actual_document_status,

        item.match_method,

        rule.evaluation_strategy,

        /*
         * Edad real del documento.
         */

        CASE

            WHEN document.issue_date IS NULL
                THEN NULL

            ELSE
                (
                    CURRENT_DATE
                    -
                    document.issue_date
                )::INTEGER

        END
            AS effective_document_age_days,


        /*
         * Cumplimiento de antigüedad máxima.
         */

        CASE

            WHEN item.maximum_age_days IS NULL
                THEN NULL

            WHEN document.issue_date IS NULL
                THEN FALSE

            ELSE

                (
                    CURRENT_DATE
                    -
                    document.issue_date
                )
                <=
                item.maximum_age_days

        END
            AS effective_age_compliant,


        /*
         * Estado real de vigencia.
         *
         * NO dependemos exclusivamente de renewal_status.
         */

        CASE

            WHEN document.id IS NULL
                THEN NULL

            WHEN document.expiration_date IS NOT NULL
             AND CURRENT_DATE >=
                 document.expiration_date
                THEN 'expired'

            WHEN document.renewal_status =
                 'expired'
                THEN 'expired'

            WHEN document.alert_due_date IS NOT NULL
             AND CURRENT_DATE >=
                 document.alert_due_date

             AND (
                 document.expiration_date IS NULL

                 OR CURRENT_DATE <
                    document.expiration_date
             )
                THEN 'expiring'

            WHEN document.renewal_status =
                 'expiring'
                THEN 'expiring'

            ELSE 'current'

        END
            AS effective_renewal_status,


        /*
         * ====================================================
         * RESULTADO FINAL
         * ====================================================
         *
         * Orden de precedencia:
         *
         * 1. No aplica a presentación.
         * 2. Documento/formato que debe prepararse.
         * 3. Documento faltante.
         * 4. Verificación rechazada.
         * 5. Antigüedad incumplida.
         * 6. Documento vencido.
         * 7. Documento por vencer.
         * 8. Candidate only.
         * 9. Formalidades.
         * 10. Cumplimiento.
         * ====================================================
         */

        CASE

            /*
             * Requisitos posteriores a presentación.
             */

            WHEN item.is_bid_requirement =
                 FALSE
                THEN 'not_applicable'


            /*
             * Formato propio de la entidad.
             */

            WHEN item.requires_entity_template =
                 TRUE
                THEN 'manual_review'


            /*
             * Documento a preparar específicamente.
             */

            WHEN rule.evaluation_strategy =
                 'prepare_for_opportunity'
                THEN 'manual_review'


            /*
             * Evaluador especializado.
             */

            WHEN rule.evaluation_strategy =
                 'specialized_evaluator'
                THEN 'manual_review'


            /*
             * Regla de revisión manual.
             */

            WHEN rule.evaluation_strategy =
                 'manual_review'
                THEN 'manual_review'


            /*
             * Documento faltante pero requisito condicional
             * o no obligatorio.
             */

            WHEN document.id IS NULL

             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN 'manual_review'


            /*
             * Documento obligatorio realmente faltante.
             */

            WHEN document.id IS NULL
                THEN 'missing'


            /*
             * Documento rechazado.
             */

            WHEN document.verification_status =
                 'rejected'
                THEN 'non_compliant'


            /*
             * Exige antigüedad máxima pero falta fecha.
             */

            WHEN item.maximum_age_days IS NOT NULL

             AND document.issue_date IS NULL
                THEN 'manual_review'


            /*
             * Supera máxima antigüedad.
             */

            WHEN item.maximum_age_days IS NOT NULL

             AND (
                 CURRENT_DATE
                 -
                 document.issue_date
             ) >
             item.maximum_age_days
                THEN 'non_compliant'


            /*
             * Documento realmente vencido.
             */

            WHEN document.expiration_date IS NOT NULL

             AND CURRENT_DATE >=
                 document.expiration_date
                THEN 'expired'


            WHEN document.renewal_status =
                 'expired'
                THEN 'expired'


            /*
             * Documento próximo a vencerse.
             */

            WHEN document.alert_due_date IS NOT NULL

             AND CURRENT_DATE >=
                 document.alert_due_date

             AND (
                 document.expiration_date IS NULL

                 OR CURRENT_DATE <
                    document.expiration_date
             )
                THEN 'expiring'


            WHEN document.renewal_status =
                 'expiring'
                THEN 'expiring'


            /*
             * Documento candidato no concluyente.
             *
             * IMPORTANTE:
             * se evalúa DESPUÉS de vencimiento y antigüedad.
             */

            WHEN item.match_method =
                 'candidate_only'
                THEN 'manual_review'


            /*
             * Formalidades que requieren inspección.
             */

            WHEN item.requires_signature = TRUE

              OR item.requires_original = TRUE

              OR item.requires_notarization = TRUE

              OR item.requires_translation = TRUE
                THEN 'manual_review'


            /*
             * Documento válido.
             */

            ELSE 'compliant'

        END::VARCHAR(40)
            AS final_compliance_status,


        /*
         * ====================================================
         * CÓDIGO EXPLICATIVO FINAL
         * ====================================================
         */

        CASE

            WHEN item.is_bid_requirement =
                 FALSE
                THEN
                    'POST_AWARD_REQUIREMENT'


            WHEN item.requires_entity_template =
                 TRUE
                THEN
                    'ENTITY_TEMPLATE_TO_PREPARE'


            WHEN rule.evaluation_strategy =
                 'prepare_for_opportunity'
                THEN
                    'DOCUMENT_TO_PREPARE'


            WHEN rule.evaluation_strategy =
                 'specialized_evaluator'
                THEN
                    'SPECIALIZED_EVALUATOR_REQUIRED'


            WHEN rule.evaluation_strategy =
                 'manual_review'
                THEN
                    'MANUAL_REVIEW_REQUIRED'


            WHEN document.id IS NULL

             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN
                    'CONDITIONAL_REQUIREMENT_REVIEW'


            WHEN document.id IS NULL
                THEN
                    'DOCUMENT_MISSING'


            WHEN document.verification_status =
                 'rejected'
                THEN
                    'DOCUMENT_VERIFICATION_REJECTED'


            WHEN item.maximum_age_days IS NOT NULL

             AND document.issue_date IS NULL
                THEN
                    'ISSUE_DATE_REQUIRED_FOR_MAXIMUM_AGE'


            WHEN item.maximum_age_days IS NOT NULL

             AND (
                 CURRENT_DATE
                 -
                 document.issue_date
             ) >
             item.maximum_age_days
                THEN
                    'MAXIMUM_AGE_EXCEEDED'


            WHEN document.expiration_date IS NOT NULL

             AND CURRENT_DATE >=
                 document.expiration_date
                THEN
                    'DOCUMENT_EXPIRED'


            WHEN document.renewal_status =
                 'expired'
                THEN
                    'DOCUMENT_EXPIRED'


            WHEN document.alert_due_date IS NOT NULL

             AND CURRENT_DATE >=
                 document.alert_due_date

             AND (
                 document.expiration_date IS NULL

                 OR CURRENT_DATE <
                    document.expiration_date
             )
                THEN
                    'DOCUMENT_EXPIRING'


            WHEN document.renewal_status =
                 'expiring'
                THEN
                    'DOCUMENT_EXPIRING'


            WHEN item.match_method =
                 'candidate_only'
                THEN
                    'CANDIDATE_DOCUMENT_REQUIRES_REVIEW'


            WHEN item.requires_notarization =
                 TRUE
                THEN
                    'NOTARIZATION_REVIEW_REQUIRED'


            WHEN item.requires_translation =
                 TRUE
                THEN
                    'TRANSLATION_REVIEW_REQUIRED'


            WHEN item.requires_original =
                 TRUE
                THEN
                    'ORIGINAL_DOCUMENT_REVIEW_REQUIRED'


            WHEN item.requires_signature =
                 TRUE
                THEN
                    'SIGNATURE_REVIEW_REQUIRED'


            WHEN document.verification_status =
                 'pending'
                THEN
                    'DOCUMENT_CURRENT_VERIFICATION_PENDING'


            ELSE
                'DOCUMENT_CURRENT'

        END::VARCHAR(100)
            AS final_result_code,


        /*
         * Revisión humana.
         */

        CASE

            WHEN item.is_bid_requirement =
                 FALSE
                THEN FALSE

            WHEN item.requires_entity_template =
                 TRUE
                THEN TRUE

            WHEN rule.evaluation_strategy IN (
                'prepare_for_opportunity',
                'specialized_evaluator',
                'manual_review'
            )
                THEN TRUE

            WHEN document.id IS NULL

             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN TRUE

            WHEN item.maximum_age_days IS NOT NULL

             AND document.issue_date IS NULL
                THEN TRUE

            WHEN item.match_method =
                 'candidate_only'
                THEN TRUE

            WHEN item.requires_signature = TRUE

              OR item.requires_original = TRUE

              OR item.requires_notarization = TRUE

              OR item.requires_translation = TRUE
                THEN TRUE

            WHEN document.verification_status =
                 'pending'
                THEN TRUE

            ELSE FALSE

        END
            AS final_requires_review,


        /*
         * Razón de revisión.
         */

        CASE

            WHEN item.is_bid_requirement =
                 FALSE
                THEN NULL

            WHEN item.requires_entity_template =
                 TRUE
                THEN
                    'Debe diligenciarse y validarse el formato oficial de la entidad.'

            WHEN rule.evaluation_strategy =
                 'prepare_for_opportunity'
                THEN
                    COALESCE(
                        rule.notes,
                        'El documento debe prepararse para esta oportunidad.'
                    )

            WHEN rule.evaluation_strategy =
                 'specialized_evaluator'
                THEN
                    COALESCE(
                        rule.notes,
                        'El requisito requiere evaluación especializada.'
                    )

            WHEN rule.evaluation_strategy =
                 'manual_review'
                THEN
                    COALESCE(
                        rule.notes,
                        'El requisito requiere revisión manual.'
                    )

            WHEN document.id IS NULL

             AND (
                 item.condition_text IS NOT NULL

                 OR item.mandatory = FALSE
             )
                THEN
                    'Debe comprobarse si la condición aplica.'

            WHEN item.maximum_age_days IS NOT NULL

             AND document.issue_date IS NULL
                THEN
                    'No puede comprobarse la antigüedad máxima porque falta la fecha de expedición.'

            WHEN item.match_method =
                 'candidate_only'
                THEN
                    'Existe un documento candidato, pero debe comprobarse su contenido.'

            WHEN item.requires_notarization =
                 TRUE
                THEN
                    'Debe verificarse la notarización exigida.'

            WHEN item.requires_translation =
                 TRUE
                THEN
                    'Debe verificarse la traducción exigida.'

            WHEN item.requires_original =
                 TRUE
                THEN
                    'Debe verificarse el requisito de documento original.'

            WHEN item.requires_signature =
                 TRUE
                THEN
                    'Debe verificarse la firma exigida.'

            WHEN document.verification_status =
                 'pending'
                THEN
                    'El documento empresarial tiene verificación pendiente.'

            ELSE NULL

        END
            AS final_review_reason

    FROM
        saas.opportunity_compliance_evaluation_items
            AS item


    LEFT JOIN
        saas.organization_documents
            AS document

        ON document.id =
           item.selected_document_id


    LEFT JOIN LATERAL
    (
        SELECT
            evaluation_rule.evaluation_strategy,
            evaluation_rule.notes,
            evaluation_rule.priority

        FROM saas.requirement_evaluation_rules
            AS evaluation_rule

        WHERE evaluation_rule.is_active =
              TRUE

          AND LOWER(
                  BTRIM(
                      evaluation_rule.requirement_document_type
                  )
              ) =
              LOWER(
                  BTRIM(
                      COALESCE(
                          item.normalized_document_type,
                          ''
                      )
                  )
              )

          AND
          (
              evaluation_rule.applies_to =
                  '*'

              OR

              evaluation_rule.applies_to =
                  COALESCE(
                      item.applies_to,
                      ''
                  )
          )

        ORDER BY

            CASE

                WHEN evaluation_rule.applies_to =
                     COALESCE(
                         item.applies_to,
                         ''
                     )
                    THEN 0

                ELSE 1

            END,

            evaluation_rule.priority,

            evaluation_rule.id

        LIMIT 1
    )
        AS rule

        ON TRUE

    WHERE item.evaluation_id =
          v_evaluation_id;


    /*
     * --------------------------------------------------------
     * 7. Persistir decisión V3
     * --------------------------------------------------------
     */

    UPDATE
        saas.opportunity_compliance_evaluation_items
            AS item

    SET

        compliance_status =
            result.final_compliance_status,

        result_code =
            result.final_result_code,

        requires_review =
            result.final_requires_review,

        review_reason =
            result.final_review_reason,

        is_automatic =
            CASE

                WHEN result.final_compliance_status =
                     'manual_review'
                    THEN FALSE

                ELSE TRUE

            END,

        matched_document_type =
            result.actual_document_type,

        document_issue_date =
            result.actual_issue_date,

        document_expiration_date =
            result.actual_expiration_date,

        document_renewal_status =
            result.effective_renewal_status,

        document_verification_status =
            result.actual_verification_status,

        document_age_days =
            result.effective_document_age_days,

        age_compliant =
            result.effective_age_compliant,

        evidence =
            COALESCE(
                item.evidence,
                '{}'::JSONB
            )
            ||
            jsonb_build_object(

                'wf017_engine_version',
                3,

                'effective_renewal_status',
                result.effective_renewal_status,

                'effective_document_age_days',
                result.effective_document_age_days,

                'effective_age_compliant',
                result.effective_age_compliant,

                'evaluation_strategy',
                result.evaluation_strategy,

                'evaluated_date',
                CURRENT_DATE,

                'evaluated_at',
                NOW()
            ),

        metadata =
            COALESCE(
                item.metadata,
                '{}'::JSONB
            )
            ||
            jsonb_build_object(

                'wf017_engine',
                'deterministic_v3',

                'wf017_engine_version',
                3,

                'wf017_v3_updated_at',
                NOW()
            ),

        updated_at =
            NOW()

    FROM tmp_wf017_v3_results
        AS result

    WHERE item.id =
          result.evaluation_item_id;


    /*
     * --------------------------------------------------------
     * 8. Recalcular métricas definitivas
     * --------------------------------------------------------
     */

    SELECT

        COUNT(*)::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.is_bid_requirement =
                  TRUE
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'compliant'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'expiring'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'expired'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'missing'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'non_compliant'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'manual_review'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.final_compliance_status =
                  'not_applicable'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.selected_document_id
                  IS NOT NULL

              AND result.actual_verification_status =
                  'pending'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.is_bid_requirement =
                  TRUE

              AND result.mandatory =
                  TRUE

              AND result.final_compliance_status
                  IN
                  (
                      'missing',
                      'expired',
                      'non_compliant'
                  )
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.is_bid_requirement =
                  TRUE

              AND result.mandatory =
                  TRUE

              AND result.final_compliance_status =
                  'manual_review'
        )::INTEGER,


        COUNT(*) FILTER
        (
            WHERE result.is_bid_requirement =
                  TRUE

              AND
              (
                  result.final_compliance_status =
                      'expiring'

                  OR

                  (
                      result.final_compliance_status =
                          'compliant'

                      AND result.final_requires_review =
                          TRUE
                  )
              )
        )::INTEGER

    INTO

        v_total_requirement_count,

        v_bid_requirement_count,

        v_compliant_count,

        v_expiring_count,

        v_expired_count,

        v_missing_count,

        v_non_compliant_count,

        v_manual_review_count,

        v_not_applicable_count,

        v_verification_pending_count,

        v_mandatory_bid_blocker_count,

        v_mandatory_bid_review_count,

        v_warning_count

    FROM tmp_wf017_v3_results
        AS result;


    /*
     * --------------------------------------------------------
     * 9. Estado general
     * --------------------------------------------------------
     */

    v_overall_status :=

        CASE

            WHEN v_mandatory_bid_blocker_count > 0
                THEN
                    'not_ready'

            WHEN v_mandatory_bid_review_count > 0
                THEN
                    'manual_review'

            WHEN v_warning_count > 0
                THEN
                    'ready_with_warnings'

            ELSE
                'ready'

        END;


    /*
     * --------------------------------------------------------
     * 10. Puntaje
     * --------------------------------------------------------
     */

    SELECT

        COALESCE
        (
            ROUND
            (
                (
                    SUM
                    (
                        CASE

                            WHEN result.final_compliance_status =
                                 'compliant'

                             AND result.actual_verification_status =
                                 'pending'
                                THEN 0.90


                            WHEN result.final_compliance_status =
                                 'compliant'
                                THEN 1.00


                            WHEN result.final_compliance_status =
                                 'expiring'
                                THEN 0.80


                            WHEN result.final_compliance_status =
                                 'manual_review'
                                THEN 0.50


                            ELSE 0.00

                        END
                    )
                    *
                    100.00
                )
                /
                NULLIF
                (
                    COUNT(*)::NUMERIC,
                    0
                ),

                2
            ),

            100.00
        )

    INTO v_compliance_score

    FROM tmp_wf017_v3_results
        AS result

    WHERE result.is_bid_requirement =
          TRUE

      AND result.mandatory =
          TRUE

      AND result.final_compliance_status <>
          'not_applicable';


    /*
     * --------------------------------------------------------
     * 11. Actualizar cabecera definitiva
     * --------------------------------------------------------
     */

    UPDATE
        saas.opportunity_compliance_evaluations
            AS evaluation

    SET

        evaluation_status =
            'completed',

        evaluation_method =
            'deterministic_v3',

        total_requirement_count =
            v_total_requirement_count,

        bid_requirement_count =
            v_bid_requirement_count,

        compliant_count =
            v_compliant_count,

        expiring_count =
            v_expiring_count,

        expired_count =
            v_expired_count,

        missing_count =
            v_missing_count,

        non_compliant_count =
            v_non_compliant_count,

        manual_review_count =
            v_manual_review_count,

        not_applicable_count =
            v_not_applicable_count,

        verification_pending_count =
            v_verification_pending_count,

        overall_status =
            v_overall_status,

        compliance_score =
            v_compliance_score,

        finished_at =
            NOW(),

        error_message =
            NULL,

        summary =
            COALESCE(
                evaluation.summary,
                '{}'::JSONB
            )
            ||
            jsonb_build_object(

                'mandatory_bid_blocker_count',
                v_mandatory_bid_blocker_count,

                'mandatory_bid_review_count',
                v_mandatory_bid_review_count,

                'warning_count',
                v_warning_count,

                'evaluation_engine',
                'deterministic_v3',

                'evaluation_version',
                3,

                'effective_evaluation_date',
                CURRENT_DATE,

                'completed_at',
                NOW()
            ),

        metadata =
            COALESCE(
                evaluation.metadata,
                '{}'::JSONB
            )
            ||
            jsonb_build_object(

                'workflow_code',
                'WF-017',

                'engine_version',
                3,

                'engine_method',
                'deterministic_v3',

                'last_v3_execution_id',
                p_n8n_execution_id,

                'last_v3_evaluated_at',
                NOW()
            ),

        updated_at =
            NOW()

    WHERE evaluation.id =
          v_evaluation_id;


    /*
     * --------------------------------------------------------
     * 12. Resultado final
     * --------------------------------------------------------
     */

    RETURN QUERY

    SELECT

        evaluation.id,

        evaluation.matrix_id,

        evaluation.organization_id,

        evaluation.opportunity_analysis_id,

        evaluation.process_reference,

        evaluation.evaluation_status::TEXT,

        evaluation.overall_status::TEXT,

        evaluation.compliance_score,

        evaluation.total_requirement_count,

        evaluation.bid_requirement_count,

        evaluation.compliant_count,

        evaluation.expiring_count,

        evaluation.expired_count,

        evaluation.missing_count,

        evaluation.non_compliant_count,

        evaluation.manual_review_count,

        evaluation.not_applicable_count,

        evaluation.verification_pending_count,

        v_mandatory_bid_blocker_count,

        v_mandatory_bid_review_count,

        v_warning_count,

        v_base.result_code::TEXT,

        'evaluation_v3_completed'::TEXT,

        3,

        'deterministic_v3'::TEXT,

        TRUE,

        NOW()

    FROM saas.opportunity_compliance_evaluations
        AS evaluation

    WHERE evaluation.id =
          v_evaluation_id;


END;

$$;


/*
 * ------------------------------------------------------------
 * 13. Documentación
 * ------------------------------------------------------------
 */

COMMENT ON FUNCTION
    saas.evaluate_opportunity_compliance_v3
    (
        UUID,
        TEXT
    )

IS
    'WF-017 V3: punto único de evaluación productiva. Resuelve reglas, fechas efectivas, antigüedad, vigencia, equivalencias y precedencia definitiva de cumplimiento.';


-- ============================================================
-- Fuente auditada: Crear estructura base WF-018
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =========================================================
-- 1. PLAN GENERAL DE ACCIÓN POR OPORTUNIDAD
-- =========================================================

CREATE TABLE IF NOT EXISTS saas.opportunity_action_plans
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    organization_id UUID NOT NULL,

    opportunity_analysis_id UUID NOT NULL,

    matrix_id UUID NOT NULL,

    evaluation_id UUID NOT NULL,

    process_reference TEXT,

    plan_version INTEGER NOT NULL
        DEFAULT 1,

    generation_method VARCHAR(80) NOT NULL
        DEFAULT 'deterministic_v1',

    plan_status VARCHAR(40) NOT NULL
        DEFAULT 'generated',

    priority_level VARCHAR(20) NOT NULL
        DEFAULT 'medium',

    compliance_score NUMERIC(7,2),

    total_action_count INTEGER NOT NULL
        DEFAULT 0,

    open_action_count INTEGER NOT NULL
        DEFAULT 0,

    completed_action_count INTEGER NOT NULL
        DEFAULT 0,

    critical_action_count INTEGER NOT NULL
        DEFAULT 0,

    high_action_count INTEGER NOT NULL
        DEFAULT 0,

    medium_action_count INTEGER NOT NULL
        DEFAULT 0,

    low_action_count INTEGER NOT NULL
        DEFAULT 0,

    blocker_action_count INTEGER NOT NULL
        DEFAULT 0,

    manual_review_action_count INTEGER NOT NULL
        DEFAULT 0,

    expired_action_count INTEGER NOT NULL
        DEFAULT 0,

    expiring_action_count INTEGER NOT NULL
        DEFAULT 0,

    missing_action_count INTEGER NOT NULL
        DEFAULT 0,

    non_compliant_action_count INTEGER NOT NULL
        DEFAULT 0,

    input_hash_sha256 CHAR(64),

    summary JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    generation_status VARCHAR(30) NOT NULL
        DEFAULT 'completed',

    error_message TEXT,

    is_current BOOLEAN NOT NULL
        DEFAULT TRUE,

    generated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    superseded_at TIMESTAMPTZ,

    n8n_execution_id TEXT,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT opportunity_action_plans_evaluation_fk
        FOREIGN KEY (evaluation_id)
        REFERENCES saas.opportunity_compliance_evaluations(id)
        ON DELETE RESTRICT,

    CONSTRAINT opportunity_action_plan_status_check
        CHECK (
            plan_status IN (
                'generated',
                'ready',
                'needs_action',
                'blocked',
                'manual_review',
                'completed'
            )
        ),

    CONSTRAINT opportunity_action_plan_priority_check
        CHECK (
            priority_level IN (
                'critical',
                'high',
                'medium',
                'low',
                'none'
            )
        ),

    CONSTRAINT opportunity_action_plan_generation_status_check
        CHECK (
            generation_status IN (
                'pending',
                'processing',
                'completed',
                'failed'
            )
        ),

    CONSTRAINT opportunity_action_plan_version_check
        CHECK (
            plan_version >= 1
        ),

    CONSTRAINT opportunity_action_plan_score_check
        CHECK (
            compliance_score IS NULL
            OR (
                compliance_score >= 0
                AND compliance_score <= 100
            )
        ),

    CONSTRAINT opportunity_action_plan_counts_check
        CHECK (
            total_action_count >= 0
            AND open_action_count >= 0
            AND completed_action_count >= 0
            AND critical_action_count >= 0
            AND high_action_count >= 0
            AND medium_action_count >= 0
            AND low_action_count >= 0
            AND blocker_action_count >= 0
            AND manual_review_action_count >= 0
            AND expired_action_count >= 0
            AND expiring_action_count >= 0
            AND missing_action_count >= 0
            AND non_compliant_action_count >= 0
        )
);


-- =========================================================
-- 2. ACCIONES INDIVIDUALES
-- =========================================================

CREATE TABLE IF NOT EXISTS saas.opportunity_action_items
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    action_plan_id UUID NOT NULL,

    evaluation_id UUID NOT NULL,

    evaluation_item_id UUID,

    matrix_item_id UUID,

    requirement_id TEXT,

    requirement_name TEXT,

    requirement_category TEXT,

    normalized_document_type TEXT,

    source_status VARCHAR(40) NOT NULL,

    action_type VARCHAR(60) NOT NULL,

    action_status VARCHAR(30) NOT NULL
        DEFAULT 'open',

    priority_level VARCHAR(20) NOT NULL
        DEFAULT 'medium',

    priority_score INTEGER NOT NULL
        DEFAULT 500,

    is_mandatory BOOLEAN NOT NULL
        DEFAULT FALSE,

    is_blocker BOOLEAN NOT NULL
        DEFAULT FALSE,

    requires_human_action BOOLEAN NOT NULL
        DEFAULT TRUE,

    is_automatable BOOLEAN NOT NULL
        DEFAULT FALSE,

    action_title TEXT NOT NULL,

    action_description TEXT,

    recommended_action TEXT,

    blocking_reason TEXT,

    due_date DATE,

    alert_date DATE,

    expiration_date DATE,

    days_remaining INTEGER,

    resolution_note TEXT,

    resolved_at TIMESTAMPTZ,

    resolved_by TEXT,

    source_snapshot JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    metadata JSONB NOT NULL
        DEFAULT '{}'::JSONB,

    dedupe_key TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT opportunity_action_items_plan_fk
        FOREIGN KEY (action_plan_id)
        REFERENCES saas.opportunity_action_plans(id)
        ON DELETE CASCADE,

    CONSTRAINT opportunity_action_items_evaluation_fk
        FOREIGN KEY (evaluation_id)
        REFERENCES saas.opportunity_compliance_evaluations(id)
        ON DELETE RESTRICT,

    CONSTRAINT opportunity_action_items_evaluation_item_fk
        FOREIGN KEY (evaluation_item_id)
        REFERENCES saas.opportunity_compliance_evaluation_items(id)
        ON DELETE SET NULL,

    CONSTRAINT opportunity_action_item_source_status_check
        CHECK (
            source_status IN (
                'compliant',
                'expiring',
                'expired',
                'missing',
                'non_compliant',
                'manual_review',
                'not_applicable',
                'verification_pending'
            )
        ),

    CONSTRAINT opportunity_action_item_type_check
        CHECK (
            action_type IN (
                'upload_document',
                'renew_document',
                'replace_document',
                'verify_document',
                'correct_document',
                'prepare_entity_template',
                'review_experience',
                'review_technical_requirement',
                'specialized_review',
                'manual_review',
                'monitor_expiration',
                'no_action'
            )
        ),

    CONSTRAINT opportunity_action_item_status_check
        CHECK (
            action_status IN (
                'open',
                'in_progress',
                'completed',
                'dismissed',
                'not_applicable'
            )
        ),

    CONSTRAINT opportunity_action_item_priority_check
        CHECK (
            priority_level IN (
                'critical',
                'high',
                'medium',
                'low',
                'none'
            )
        ),

    CONSTRAINT opportunity_action_item_priority_score_check
        CHECK (
            priority_score >= 1
            AND priority_score <= 1000
        )
);


-- =========================================================
-- 3. ÍNDICES DEL PLAN
-- =========================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_opportunity_action_plan_current

ON saas.opportunity_action_plans
(
    organization_id,
    opportunity_analysis_id
)

WHERE is_current = TRUE;


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_plans_evaluation

ON saas.opportunity_action_plans
(
    evaluation_id
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_plans_matrix

ON saas.opportunity_action_plans
(
    matrix_id
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_plans_status

ON saas.opportunity_action_plans
(
    organization_id,
    plan_status,
    priority_level
)

WHERE is_current = TRUE;


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_plans_generated_at

ON saas.opportunity_action_plans
(
    generated_at DESC
);


-- =========================================================
-- 4. ÍNDICES DE LAS ACCIONES
-- =========================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_opportunity_action_item_dedupe

ON saas.opportunity_action_items
(
    action_plan_id,
    dedupe_key
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_items_plan

ON saas.opportunity_action_items
(
    action_plan_id
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_items_evaluation

ON saas.opportunity_action_items
(
    evaluation_id
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_items_open

ON saas.opportunity_action_items
(
    action_plan_id,
    priority_score,
    priority_level
)

WHERE action_status IN (
    'open',
    'in_progress'
);


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_items_blockers

ON saas.opportunity_action_items
(
    action_plan_id,
    is_blocker
)

WHERE is_blocker = TRUE
  AND action_status IN (
      'open',
      'in_progress'
  );


CREATE INDEX IF NOT EXISTS
    idx_opportunity_action_items_due_date

ON saas.opportunity_action_items
(
    due_date
)

WHERE action_status IN (
    'open',
    'in_progress'
);


-- =========================================================
-- 5. RESULTADO DEL NODO
-- =========================================================

SELECT
    TRUE
        AS structure_ready,

    'WF-018'
        AS workflow_code,

    'opportunity_action_plans'
        AS plan_table,

    'opportunity_action_items'
        AS item_table,

    NOW()
        AS created_or_verified_at;


-- ============================================================
-- Fuente auditada: Crear motor V1 WF-018
-- ============================================================

CREATE OR REPLACE FUNCTION
saas.generate_opportunity_action_plan_v1
(
    p_evaluation_id UUID,
    p_n8n_execution_id TEXT DEFAULT NULL
)
RETURNS TABLE
(
    action_plan_id UUID,
    evaluation_id UUID,
    process_reference TEXT,

    result_code TEXT,

    plan_status TEXT,
    priority_level TEXT,

    compliance_score NUMERIC,

    total_action_count INTEGER,
    open_action_count INTEGER,

    blocker_action_count INTEGER,

    critical_action_count INTEGER,
    high_action_count INTEGER,
    medium_action_count INTEGER,
    low_action_count INTEGER,

    manual_review_action_count INTEGER,

    input_hash_sha256 TEXT,

    plan_version INTEGER,

    changes_applied BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_evaluation
        saas.opportunity_compliance_evaluations%ROWTYPE;

    v_current_plan
        saas.opportunity_action_plans%ROWTYPE;

    v_new_plan_id UUID;

    v_input_hash TEXT;

    v_next_version INTEGER := 1;

BEGIN

    -- =====================================================
    -- 1. RECUPERAR EVALUACIÓN ACTUAL DE WF-017
    -- =====================================================

    SELECT
        evaluation.*

    INTO
        v_evaluation

    FROM saas.opportunity_compliance_evaluations
        AS evaluation

    WHERE evaluation.id =
          p_evaluation_id

      AND evaluation.is_current =
          TRUE

      AND evaluation.evaluation_status =
          'completed'

    LIMIT 1;


    -- =====================================================
    -- 2. EVALUACIÓN NO DISPONIBLE
    -- =====================================================

    IF NOT FOUND THEN

        RETURN QUERY

        SELECT
            NULL::UUID,
            p_evaluation_id,
            NULL::TEXT,

            'evaluation_not_available'::TEXT,

            NULL::TEXT,
            NULL::TEXT,

            NULL::NUMERIC,

            0::INTEGER,
            0::INTEGER,

            0::INTEGER,

            0::INTEGER,
            0::INTEGER,
            0::INTEGER,
            0::INTEGER,

            0::INTEGER,

            NULL::TEXT,

            0::INTEGER,

            FALSE;

        RETURN;

    END IF;


    -- =====================================================
    -- 3. HASH DEL ESTADO DE WF-017
    -- =====================================================

    SELECT
        ENCODE(
            DIGEST(
                CONVERT_TO(
                    CONCAT_WS(
                        '|',

                        v_evaluation.id::TEXT,

                        COALESCE(
                            v_evaluation.updated_at::TEXT,
                            ''
                        ),

                        COALESCE(
                            v_evaluation.overall_status,
                            ''
                        ),

                        COALESCE(
                            v_evaluation.compliance_score::TEXT,
                            ''
                        ),

                        COALESCE(
                            (
                                SELECT
                                    STRING_AGG(
                                        TO_JSONB(item)::TEXT,
                                        '|'
                                        ORDER BY item.id
                                    )

                                FROM
                                    saas.opportunity_compliance_evaluation_items
                                        AS item

                                WHERE item.evaluation_id =
                                      v_evaluation.id
                            ),
                            ''
                        )
                    ),

                    'UTF8'
                ),

                'sha256'
            ),

            'hex'
        )

    INTO
        v_input_hash;


    -- =====================================================
    -- 4. PLAN ACTUAL
    -- =====================================================

    SELECT
        plan.*

    INTO
        v_current_plan

    FROM saas.opportunity_action_plans
        AS plan

    WHERE plan.organization_id =
          v_evaluation.organization_id

      AND plan.opportunity_analysis_id =
          v_evaluation.opportunity_analysis_id

      AND plan.is_current =
          TRUE

    ORDER BY
        plan.created_at DESC

    LIMIT 1;


    -- =====================================================
    -- 5. IDEMPOTENCIA
    -- =====================================================

    IF FOUND
       AND v_current_plan.input_hash_sha256 =
           v_input_hash
       AND v_current_plan.generation_status =
           'completed'
    THEN

        RETURN QUERY

        SELECT
            v_current_plan.id,

            v_current_plan.evaluation_id,

            v_current_plan.process_reference,

            'already_current'::TEXT,

            v_current_plan.plan_status::TEXT,

            v_current_plan.priority_level::TEXT,

            v_current_plan.compliance_score,

            v_current_plan.total_action_count,

            v_current_plan.open_action_count,

            v_current_plan.blocker_action_count,

            v_current_plan.critical_action_count,

            v_current_plan.high_action_count,

            v_current_plan.medium_action_count,

            v_current_plan.low_action_count,

            v_current_plan.manual_review_action_count,

            v_current_plan.input_hash_sha256::TEXT,

            v_current_plan.plan_version,

            FALSE;

        RETURN;

    END IF;


    -- =====================================================
    -- 6. VERSIONADO DEL PLAN
    -- =====================================================

    IF v_current_plan.id
       IS NOT NULL
    THEN

        v_next_version :=
            COALESCE(
                v_current_plan.plan_version,
                0
            ) + 1;

        UPDATE
            saas.opportunity_action_plans

        SET
            is_current =
                FALSE,

            superseded_at =
                NOW(),

            updated_at =
                NOW()

        WHERE organization_id =
              v_evaluation.organization_id

          AND opportunity_analysis_id =
              v_evaluation.opportunity_analysis_id

          AND is_current =
              TRUE;

    END IF;


    -- =====================================================
    -- 7. CREAR NUEVO PLAN
    -- =====================================================

    INSERT INTO
        saas.opportunity_action_plans
    (
        organization_id,
        opportunity_analysis_id,
        matrix_id,
        evaluation_id,

        process_reference,

        plan_version,
        generation_method,

        plan_status,
        priority_level,

        compliance_score,

        input_hash_sha256,

        summary,
        metadata,

        generation_status,

        is_current,

        generated_at,

        n8n_execution_id,

        created_at,
        updated_at
    )

    VALUES
    (
        v_evaluation.organization_id,

        v_evaluation.opportunity_analysis_id,

        v_evaluation.matrix_id,

        v_evaluation.id,

        v_evaluation.process_reference,

        v_next_version,

        'deterministic_v1',

        'generated',

        'none',

        v_evaluation.compliance_score,

        v_input_hash,

        '{}'::JSONB,

        jsonb_strip_nulls(
            jsonb_build_object(
                'workflow_code',
                'WF-018',

                'source_workflow',
                'WF-017',

                'source_evaluation_id',
                v_evaluation.id,

                'source_overall_status',
                v_evaluation.overall_status,

                'source_evaluation_version',
                v_evaluation.evaluation_version,

                'source_evaluation_method',
                v_evaluation.evaluation_method,

                'generated_by',
                'saas.generate_opportunity_action_plan_v1',

                'n8n_execution_id',
                p_n8n_execution_id,

                'generated_at',
                NOW()
            )
        ),

        'processing',

        TRUE,

        NOW(),

        p_n8n_execution_id,

        NOW(),
        NOW()
    )

    RETURNING
        id

    INTO
        v_new_plan_id;


    -- =====================================================
    -- 8. GENERAR ACCIONES DESDE ITEMS DE WF-017
    -- =====================================================

    WITH source_items AS
    (
        SELECT
            item.id
                AS evaluation_item_id,

            TO_JSONB(item)
                AS evaluation_json,

            CASE
                WHEN COALESCE(
                    TO_JSONB(item)
                        ->> 'matrix_item_id',
                    ''
                )
                ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

                THEN
                    (
                        TO_JSONB(item)
                            ->> 'matrix_item_id'
                    )::UUID

                ELSE
                    NULL::UUID
            END
                AS matrix_item_id

        FROM
            saas.opportunity_compliance_evaluation_items
                AS item

        WHERE item.evaluation_id =
              v_evaluation.id
    ),

    source_with_matrix AS
    (
        SELECT
            source.*,

            TO_JSONB(matrix_item)
                AS matrix_json

        FROM source_items
            AS source

        LEFT JOIN
            saas.opportunity_requirement_matrix_items
                AS matrix_item

            ON matrix_item.id =
               source.matrix_item_id
    ),

    normalized AS
    (
        SELECT
            source.evaluation_item_id,

            source.matrix_item_id,

            source.evaluation_json,

            source.matrix_json,

            LOWER(
                COALESCE(
                    NULLIF(
                        source.evaluation_json
                            ->> 'final_status',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'compliance_status',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'requirement_status',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'item_status',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'evaluation_result',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'status',
                        ''
                    ),

                    NULLIF(
                        source.evaluation_json
                            ->> 'evaluation_status',
                        ''
                    ),

                    'manual_review'
                )
            )
                AS raw_status,

            COALESCE(
                NULLIF(
                    source.evaluation_json
                        ->> 'requirement_id',
                    ''
                ),

                NULLIF(
                    source.matrix_json
                        ->> 'requirement_id',
                    ''
                ),

                source.evaluation_item_id::TEXT
            )
                AS requirement_id,

            COALESCE(
                NULLIF(
                    source.evaluation_json
                        ->> 'requirement_name',
                    ''
                ),

                NULLIF(
                    source.matrix_json
                        ->> 'requirement_name',
                    ''
                ),

                'Requisito sin nombre'
            )
                AS requirement_name,

            COALESCE(
                NULLIF(
                    source.evaluation_json
                        ->> 'requirement_category',
                    ''
                ),

                NULLIF(
                    source.matrix_json
                        ->> 'requirement_category',
                    ''
                )
            )
                AS requirement_category,

            COALESCE(
                NULLIF(
                    source.evaluation_json
                        ->> 'normalized_document_type',
                    ''
                ),

                NULLIF(
                    source.matrix_json
                        ->> 'normalized_document_type',
                    ''
                )
            )
                AS normalized_document_type,

            (
                LOWER(
                    COALESCE(
                        NULLIF(
                            source.evaluation_json
                                ->> 'mandatory',
                            ''
                        ),

                        NULLIF(
                            source.evaluation_json
                                ->> 'is_mandatory',
                            ''
                        ),

                        NULLIF(
                            source.matrix_json
                                ->> 'mandatory',
                            ''
                        ),

                        'false'
                    )
                )
                IN (
                    'true',
                    '1',
                    'yes',
                    't'
                )
            )
                AS is_mandatory,

            (
                LOWER(
                    COALESCE(
                        NULLIF(
                            source.evaluation_json
                                ->> 'requires_entity_template',
                            ''
                        ),

                        NULLIF(
                            source.matrix_json
                                ->> 'requires_entity_template',
                            ''
                        ),

                        'false'
                    )
                )
                IN (
                    'true',
                    '1',
                    'yes',
                    't'
                )
            )
                AS requires_entity_template,

            COALESCE(
                NULLIF(
                    source.evaluation_json
                        ->> 'evaluation_strategy',
                    ''
                ),

                NULLIF(
                    source.matrix_json
                        ->> 'evaluation_strategy',
                    ''
                )
            )
                AS evaluation_strategy,

            CASE
                WHEN COALESCE(
                    source.evaluation_json
                        ->> 'expiration_date',

                    source.evaluation_json
                        ->> 'effective_expiration_date',

                    source.matrix_json
                        ->> 'expiration_date',

                    ''
                )
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

                THEN
                    COALESCE(
                        source.evaluation_json
                            ->> 'expiration_date',

                        source.evaluation_json
                            ->> 'effective_expiration_date',

                        source.matrix_json
                            ->> 'expiration_date'
                    )::DATE

                ELSE
                    NULL::DATE
            END
                AS expiration_date,

            CASE
                WHEN COALESCE(
                    source.evaluation_json
                        ->> 'alert_date',

                    source.evaluation_json
                        ->> 'alert_due_date',

                    source.matrix_json
                        ->> 'alert_date',

                    ''
                )
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

                THEN
                    COALESCE(
                        source.evaluation_json
                            ->> 'alert_date',

                        source.evaluation_json
                            ->> 'alert_due_date',

                        source.matrix_json
                            ->> 'alert_date'
                    )::DATE

                ELSE
                    NULL::DATE
            END
                AS alert_date

        FROM source_with_matrix
            AS source
    ),

    statuses AS
    (
        SELECT
            normalized.*,

            CASE

                WHEN raw_status IN (
                    'compliant',
                    'expiring',
                    'expired',
                    'missing',
                    'non_compliant',
                    'manual_review',
                    'not_applicable',
                    'verification_pending'
                )
                    THEN raw_status

                WHEN raw_status IN (
                    'noncompliant',
                    'non-compliant'
                )
                    THEN 'non_compliant'

                WHEN raw_status IN (
                    'pending_verification',
                    'verification_required'
                )
                    THEN 'verification_pending'

                WHEN raw_status IN (
                    'not-applicable',
                    'na'
                )
                    THEN 'not_applicable'

                ELSE
                    'manual_review'

            END
                AS source_status

        FROM normalized
    ),

    classified AS
    (
        SELECT
            status_data.*,

            CASE

                WHEN source_status =
                     'missing'
                     AND requires_entity_template
                    THEN 'prepare_entity_template'

                WHEN source_status =
                     'missing'
                    THEN 'upload_document'

                WHEN source_status =
                     'expired'
                    THEN 'renew_document'

                WHEN source_status =
                     'expiring'
                    THEN 'renew_document'

                WHEN source_status =
                     'non_compliant'
                    THEN 'correct_document'

                WHEN source_status =
                     'verification_pending'
                    THEN 'verify_document'

                WHEN source_status =
                     'manual_review'
                     AND requires_entity_template
                    THEN 'prepare_entity_template'

                WHEN source_status =
                     'manual_review'
                     AND normalized_document_type =
                         'experience_certificate'
                    THEN 'review_experience'

                WHEN source_status =
                     'manual_review'
                     AND normalized_document_type =
                         'technical_certificate'
                    THEN 'review_technical_requirement'

                WHEN source_status =
                     'manual_review'
                     AND evaluation_strategy =
                         'specialized_evaluator'
                    THEN 'specialized_review'

                ELSE 'manual_review'

            END
                AS action_type,

            (
                is_mandatory
                AND source_status IN (
                    'missing',
                    'expired',
                    'non_compliant'
                )
            )
                AS is_blocker

        FROM statuses
            AS status_data

        WHERE source_status
              NOT IN (
                  'compliant',
                  'not_applicable'
              )
    ),

    prioritized AS
    (
        SELECT
            classified.*,

            CASE

                WHEN is_blocker
                    THEN 'critical'

                WHEN source_status =
                     'expired'
                    THEN 'high'

                WHEN source_status =
                     'missing'
                    THEN 'high'

                WHEN source_status =
                     'non_compliant'
                    THEN 'high'

                WHEN source_status =
                     'manual_review'
                     AND is_mandatory
                    THEN 'high'

                WHEN source_status =
                     'verification_pending'
                     AND is_mandatory
                    THEN 'high'

                WHEN source_status =
                     'expiring'
                     AND is_mandatory
                    THEN 'high'

                WHEN source_status IN (
                    'expiring',
                    'manual_review',
                    'verification_pending'
                )
                    THEN 'medium'

                ELSE 'low'

            END
                AS priority_level,

            CASE

                WHEN is_blocker
                    THEN 1000

                WHEN source_status IN (
                    'expired',
                    'missing',
                    'non_compliant'
                )
                    THEN 850

                WHEN source_status =
                     'manual_review'
                     AND is_mandatory
                    THEN 800

                WHEN source_status =
                     'verification_pending'
                     AND is_mandatory
                    THEN 750

                WHEN source_status =
                     'expiring'
                     AND is_mandatory
                    THEN 700

                WHEN source_status =
                     'expiring'
                    THEN 600

                WHEN source_status =
                     'manual_review'
                    THEN 500

                WHEN source_status =
                     'verification_pending'
                    THEN 450

                ELSE 250

            END
                AS priority_score

        FROM classified
    ),

    prepared AS
    (
        SELECT
            prioritized.*,

            CASE action_type

                WHEN 'upload_document'
                    THEN
                    'Subir documento faltante'

                WHEN 'renew_document'
                    THEN
                    CASE
                        WHEN source_status =
                             'expired'
                            THEN
                            'Renovar documento vencido'

                        ELSE
                            'Renovar documento próximo a vencer'
                    END

                WHEN 'correct_document'
                    THEN
                    'Corregir documento o evidencia'

                WHEN 'verify_document'
                    THEN
                    'Verificar documento'

                WHEN 'prepare_entity_template'
                    THEN
                    'Preparar formato de la entidad'

                WHEN 'review_experience'
                    THEN
                    'Revisar experiencia contractual'

                WHEN 'review_technical_requirement'
                    THEN
                    'Revisar requisito técnico'

                WHEN 'specialized_review'
                    THEN
                    'Realizar revisión especializada'

                ELSE
                    'Realizar revisión manual'

            END
                AS action_title,

            CASE action_type

                WHEN 'upload_document'
                    THEN
                    'El requisito no cuenta con un documento válido disponible para esta oportunidad.'

                WHEN 'renew_document'
                    THEN
                    'El documento requiere renovación para mantener la oportunidad habilitada.'

                WHEN 'correct_document'
                    THEN
                    'La evidencia disponible no cumple completamente el requisito evaluado.'

                WHEN 'verify_document'
                    THEN
                    'Existe evidencia disponible, pero requiere verificación antes de considerarla definitiva.'

                WHEN 'prepare_entity_template'
                    THEN
                    'El proceso exige un formato o documento específico que debe prepararse para esta oportunidad.'

                WHEN 'review_experience'
                    THEN
                    'La experiencia debe compararse contra las condiciones específicas exigidas por el proceso.'

                WHEN 'review_technical_requirement'
                    THEN
                    'El requisito técnico requiere validación especializada antes de confirmar cumplimiento.'

                WHEN 'specialized_review'
                    THEN
                    'El requisito necesita un evaluador especializado antes de tomar una decisión definitiva.'

                ELSE
                    'El requisito necesita revisión humana antes de confirmar el cumplimiento.'

            END
                AS action_description,

            CASE action_type

                WHEN 'upload_document'
                    THEN
                    'Conseguir y cargar el documento requerido.'

                WHEN 'renew_document'
                    THEN
                    'Generar una versión vigente del documento y reemplazar la anterior.'

                WHEN 'correct_document'
                    THEN
                    'Revisar el requisito y cargar una evidencia que cumpla completamente sus condiciones.'

                WHEN 'verify_document'
                    THEN
                    'Validar autenticidad, vigencia y correspondencia del documento.'

                WHEN 'prepare_entity_template'
                    THEN
                    'Descargar o preparar el formato exigido por la entidad y completarlo para la oferta.'

                WHEN 'review_experience'
                    THEN
                    'Comparar contratos y certificaciones de experiencia contra el requisito específico.'

                WHEN 'review_technical_requirement'
                    THEN
                    'Validar técnicamente la evidencia disponible contra las especificaciones del proceso.'

                WHEN 'specialized_review'
                    THEN
                    'Enviar este requisito al evaluador especializado correspondiente.'

                ELSE
                    'Revisar manualmente la evidencia y confirmar el resultado.'

            END
                AS recommended_action

        FROM prioritized
    )

    INSERT INTO
        saas.opportunity_action_items
    (
        action_plan_id,

        evaluation_id,

        evaluation_item_id,

        matrix_item_id,

        requirement_id,

        requirement_name,

        requirement_category,

        normalized_document_type,

        source_status,

        action_type,

        action_status,

        priority_level,

        priority_score,

        is_mandatory,

        is_blocker,

        requires_human_action,

        is_automatable,

        action_title,

        action_description,

        recommended_action,

        blocking_reason,

        due_date,

        alert_date,

        expiration_date,

        days_remaining,

        source_snapshot,

        metadata,

        dedupe_key,

        created_at,
        updated_at
    )

    SELECT
        v_new_plan_id,

        v_evaluation.id,

        prepared.evaluation_item_id,

        prepared.matrix_item_id,

        prepared.requirement_id,

        prepared.requirement_name,

        prepared.requirement_category,

        prepared.normalized_document_type,

        prepared.source_status,

        prepared.action_type,

        'open',

        prepared.priority_level,

        prepared.priority_score,

        prepared.is_mandatory,

        prepared.is_blocker,

        TRUE,

        FALSE,

        prepared.action_title,

        prepared.action_description,

        prepared.recommended_action,

        CASE
            WHEN prepared.is_blocker
                THEN
                'Requisito obligatorio que actualmente impide considerar la oportunidad lista.'

            ELSE
                NULL
        END,

        CASE

            WHEN prepared.is_blocker
                THEN CURRENT_DATE

            WHEN prepared.source_status =
                 'expiring'
                THEN prepared.expiration_date

            ELSE NULL

        END,

        prepared.alert_date,

        prepared.expiration_date,

        CASE
            WHEN prepared.expiration_date
                 IS NOT NULL

                THEN
                    prepared.expiration_date
                    - CURRENT_DATE

            ELSE NULL
        END,

        jsonb_build_object(
            'evaluation_item',
            prepared.evaluation_json,

            'matrix_item',
            prepared.matrix_json,

            'source_status',
            prepared.source_status
        ),

        jsonb_strip_nulls(
            jsonb_build_object(
                'workflow_code',
                'WF-018',

                'generation_method',
                'deterministic_v1',

                'source_evaluation_id',
                v_evaluation.id,

                'generated_at',
                NOW()
            )
        ),

        ENCODE(
            DIGEST(
                CONVERT_TO(
                    CONCAT_WS(
                        '|',

                        prepared.evaluation_item_id::TEXT,

                        prepared.requirement_id,

                        prepared.source_status,

                        prepared.action_type
                    ),

                    'UTF8'
                ),

                'sha256'
            ),

            'hex'
        ),

        NOW(),
        NOW()

    FROM prepared;


       -- =====================================================
    -- 9. RECALCULAR RESUMEN
    -- =====================================================

    WITH metrics AS
    (
        SELECT
            COUNT(*)::INTEGER
                AS total_action_count,

            COUNT(*) FILTER (
                WHERE action.action_status IN (
                    'open',
                    'in_progress'
                )
            )::INTEGER
                AS open_action_count,

            COUNT(*) FILTER (
                WHERE action.action_status =
                      'completed'
            )::INTEGER
                AS completed_action_count,

            COUNT(*) FILTER (
                WHERE action.priority_level =
                      'critical'
            )::INTEGER
                AS critical_action_count,

            COUNT(*) FILTER (
                WHERE action.priority_level =
                      'high'
            )::INTEGER
                AS high_action_count,

            COUNT(*) FILTER (
                WHERE action.priority_level =
                      'medium'
            )::INTEGER
                AS medium_action_count,

            COUNT(*) FILTER (
                WHERE action.priority_level =
                      'low'
            )::INTEGER
                AS low_action_count,

            COUNT(*) FILTER (
                WHERE action.is_blocker =
                      TRUE
            )::INTEGER
                AS blocker_action_count,

            COUNT(*) FILTER (
                WHERE action.source_status =
                      'manual_review'
            )::INTEGER
                AS manual_review_action_count,

            COUNT(*) FILTER (
                WHERE action.source_status =
                      'expired'
            )::INTEGER
                AS expired_action_count,

            COUNT(*) FILTER (
                WHERE action.source_status =
                      'expiring'
            )::INTEGER
                AS expiring_action_count,

            COUNT(*) FILTER (
                WHERE action.source_status =
                      'missing'
            )::INTEGER
                AS missing_action_count,

            COUNT(*) FILTER (
                WHERE action.source_status =
                      'non_compliant'
            )::INTEGER
                AS non_compliant_action_count

        FROM
            saas.opportunity_action_items
                AS action

        WHERE action.action_plan_id =
              v_new_plan_id
    )

    UPDATE
        saas.opportunity_action_plans
            AS target_plan

    SET
        total_action_count =
            metrics.total_action_count,

        open_action_count =
            metrics.open_action_count,

        completed_action_count =
            metrics.completed_action_count,

        critical_action_count =
            metrics.critical_action_count,

        high_action_count =
            metrics.high_action_count,

        medium_action_count =
            metrics.medium_action_count,

        low_action_count =
            metrics.low_action_count,

        blocker_action_count =
            metrics.blocker_action_count,

        manual_review_action_count =
            metrics.manual_review_action_count,

        expired_action_count =
            metrics.expired_action_count,

        expiring_action_count =
            metrics.expiring_action_count,

        missing_action_count =
            metrics.missing_action_count,

        non_compliant_action_count =
            metrics.non_compliant_action_count,

        plan_status =
            CASE

                WHEN metrics.blocker_action_count > 0
                    THEN 'blocked'

                WHEN metrics.manual_review_action_count > 0
                    THEN 'manual_review'

                WHEN metrics.total_action_count > 0
                    THEN 'needs_action'

                ELSE 'completed'

            END,

        priority_level =
            CASE

                WHEN metrics.critical_action_count > 0
                    THEN 'critical'

                WHEN metrics.high_action_count > 0
                    THEN 'high'

                WHEN metrics.medium_action_count > 0
                    THEN 'medium'

                WHEN metrics.low_action_count > 0
                    THEN 'low'

                ELSE 'none'

            END,

        summary =
            jsonb_build_object(
                'process_reference',
                v_evaluation.process_reference,

                'source_overall_status',
                v_evaluation.overall_status,

                'compliance_score',
                v_evaluation.compliance_score,

                'total_actions',
                metrics.total_action_count,

                'open_actions',
                metrics.open_action_count,

                'blockers',
                metrics.blocker_action_count,

                'critical',
                metrics.critical_action_count,

                'high',
                metrics.high_action_count,

                'medium',
                metrics.medium_action_count,

                'low',
                metrics.low_action_count,

                'manual_reviews',
                metrics.manual_review_action_count,

                'missing',
                metrics.missing_action_count,

                'expired',
                metrics.expired_action_count,

                'expiring',
                metrics.expiring_action_count,

                'non_compliant',
                metrics.non_compliant_action_count
            ),

        generation_status =
            'completed',

        generated_at =
            NOW(),

        updated_at =
            NOW()

    FROM metrics

    WHERE target_plan.id =
          v_new_plan_id;
    -- =====================================================
    -- 10. DEVOLVER RESULTADO
    -- =====================================================

    RETURN QUERY

    SELECT
        plan.id,

        plan.evaluation_id,

        plan.process_reference,

        'action_plan_generated'::TEXT,

        plan.plan_status::TEXT,

        plan.priority_level::TEXT,

        plan.compliance_score,

        plan.total_action_count,

        plan.open_action_count,

        plan.blocker_action_count,

        plan.critical_action_count,

        plan.high_action_count,

        plan.medium_action_count,

        plan.low_action_count,

        plan.manual_review_action_count,

        plan.input_hash_sha256::TEXT,

        plan.plan_version,

        TRUE

    FROM
        saas.opportunity_action_plans
            AS plan

    WHERE plan.id =
          v_new_plan_id;

END;
$$;


SELECT
    TRUE
        AS motor_created,

    'WF-018'
        AS workflow_code,

    'saas.generate_opportunity_action_plan_v1'
        AS function_name,

    'deterministic_v1'
        AS generation_method,

    NOW()
        AS created_at;

