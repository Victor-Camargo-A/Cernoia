BEGIN;

ALTER TABLE saas.organizations
  ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'unconfirmed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_organization_type_check'
      AND conrelid = 'saas.organizations'::regclass
  ) THEN
    ALTER TABLE saas.organizations
      ADD CONSTRAINT organizations_organization_type_check
      CHECK (organization_type IN (
        'unconfirmed',
        'legal_entity',
        'natural_person',
        'consortium',
        'temporary_union',
        'nonprofit',
        'other'
      ));
  END IF;
END $$;

COMMENT ON COLUMN saas.organizations.organization_type IS
  'Tipo de proponente confirmado por un usuario autorizado. Las inferencias documentales son solo sugerencias.';

COMMIT;
