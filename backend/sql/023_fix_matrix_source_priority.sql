-- Preserve source ordering within the existing 0..100 priority constraint.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION saas.consolidate_opportunity_requirement_matrix_v1(p_organization_id uuid, p_opportunity_analysis_id uuid, p_process_id uuid, p_process_reference text, p_input_hash_sha256 text, p_expected_source_document_count integer, p_expected_source_requirement_count integer, p_consolidation_version integer, p_consolidation_method text, p_execution_id text)
 RETURNS TABLE(matrix_id uuid, organization_id uuid, opportunity_analysis_id uuid, process_id uuid, process_reference text, matrix_version integer, consolidation_version integer, consolidation_method text, matrix_status text, is_current boolean, source_document_count integer, source_requirement_count integer, consolidated_requirement_count integer, bid_requirement_count integer, non_bid_requirement_count integer, conditional_requirement_count integer, review_required_count integer, started_at timestamp with time zone, finished_at timestamp with time zone, matrix_stored boolean, consolidation_result text)
 LANGUAGE plpgsql
AS $function$

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

$function$;


COMMIT;
