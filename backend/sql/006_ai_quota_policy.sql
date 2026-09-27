BEGIN;

CREATE TABLE IF NOT EXISTS ops.ai_quota_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  rpm_limit INTEGER NOT NULL CHECK (rpm_limit BETWEEN 1 AND 10000),
  rpd_limit INTEGER NOT NULL CHECK (rpd_limit BETWEEN 1 AND 10000000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, model_name)
);

INSERT INTO ops.ai_quota_policies
  (provider, model_name, rpm_limit, rpd_limit, is_active, notes)
VALUES
  (
    'google',
    'models/gemini-3.1-flash-lite',
    8,
    400,
    TRUE,
    'Valores iniciales conservadores. Confirmar y ajustar con los límites vigentes del proyecto en Google AI Studio.'
  )
ON CONFLICT (provider, model_name) DO NOTHING;

COMMIT;
