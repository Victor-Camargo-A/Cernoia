BEGIN;

CREATE TABLE IF NOT EXISTS saas.subscription_plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  amount_cop BIGINT NOT NULL CHECK (amount_cop > 0),
  billing_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly')),
  protected_price_months INTEGER CHECK (protected_price_months IS NULL OR protected_price_months > 0),
  customer_limit INTEGER CHECK (customer_limit IS NULL OR customer_limit > 0),
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  features JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO saas.subscription_plans
  (code, name, description, amount_cop, protected_price_months, customer_limit, is_public, features)
VALUES
  (
    'founders_2026',
    'Plan Fundadores',
    'Precio protegido durante doce meses para las primeras cien organizaciones con pago aprobado.',
    250000,
    12,
    100,
    TRUE,
    jsonb_build_object(
      'chat_cernoia', TRUE,
      'heatmap', TRUE,
      'document_automation', TRUE,
      'proposal_generation', TRUE,
      'market_intelligence', TRUE,
      'team_access', TRUE
    )
  ),
  (
    'business_2026',
    'Plan Empresarial',
    'Acceso mensual completo a CernoIA después del cierre del cupo fundador.',
    1200000,
    NULL,
    NULL,
    TRUE,
    jsonb_build_object(
      'chat_cernoia', TRUE,
      'heatmap', TRUE,
      'document_automation', TRUE,
      'proposal_generation', TRUE,
      'market_intelligence', TRUE,
      'team_access', TRUE
    )
  )
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  amount_cop = EXCLUDED.amount_cop,
  protected_price_months = EXCLUDED.protected_price_months,
  customer_limit = EXCLUDED.customer_limit,
  is_public = EXCLUDED.is_public,
  features = EXCLUDED.features,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS saas.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES saas.organizations(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES saas.subscription_plans(code),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'past_due', 'suspended', 'cancelled', 'expired')),
  founder_number SMALLINT UNIQUE CHECK (founder_number IS NULL OR founder_number BETWEEN 1 AND 100),
  founder_price_starts_at TIMESTAMPTZ,
  founder_price_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  next_payment_due_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  paid_cycles INTEGER NOT NULL DEFAULT 0 CHECK (paid_cycles >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_due
  ON saas.subscriptions (status, next_payment_due_at);

CREATE TABLE IF NOT EXISTS saas.billing_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES saas.subscriptions(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'bold' CHECK (provider IN ('bold')),
  reference TEXT NOT NULL UNIQUE,
  plan_code TEXT NOT NULL REFERENCES saas.subscription_plans(code),
  billing_reason TEXT NOT NULL DEFAULT 'initial'
    CHECK (billing_reason IN ('initial', 'renewal', 'reactivation', 'manual_adjustment')),
  amount_cop BIGINT NOT NULL CHECK (amount_cop > 0),
  currency TEXT NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  founder_number SMALLINT CHECK (founder_number IS NULL OR founder_number BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'link_created', 'pending', 'approved', 'rejected', 'expired', 'cancelled', 'error')),
  provider_link_id TEXT UNIQUE,
  provider_transaction_id TEXT,
  checkout_url TEXT,
  payer_email TEXT,
  payment_method TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  raw_create_response JSONB NOT NULL DEFAULT '{}'::JSONB,
  raw_payment_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_orders_org_created
  ON saas.billing_orders (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_orders_status_expiry
  ON saas.billing_orders (status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_founder_reservation
  ON saas.billing_orders (founder_number)
  WHERE founder_number IS NOT NULL
    AND status IN ('draft', 'link_created', 'pending');

CREATE TABLE IF NOT EXISTS saas.bold_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_transaction_id TEXT,
  provider_link_id TEXT,
  signature_valid BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'ignored', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bold_webhook_pending
  ON saas.bold_webhook_events (processing_status, received_at)
  WHERE processing_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS saas.subscription_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES saas.subscriptions(id) ON DELETE SET NULL,
  billing_order_id UUID REFERENCES saas.billing_orders(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_org
  ON saas.subscription_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas.chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Nueva conversación',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  context_mode TEXT NOT NULL DEFAULT 'organization'
    CHECK (context_mode IN ('organization', 'opportunity', 'documents', 'market')),
  process_id UUID REFERENCES secop.processes(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_org_user
  ON saas.chat_threads (organization_id, created_by_user_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS saas.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES saas.chat_threads(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 12000),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'ready', 'failed', 'blocked')),
  citations JSONB NOT NULL DEFAULT '[]'::JSONB,
  context_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  model_provider TEXT,
  model_name TEXT,
  quota_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  workflow_execution_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON saas.chat_messages (thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_messages_org_created
  ON saas.chat_messages (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas.notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email', 'whatsapp')),
  destination TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'active', 'disabled', 'failed')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by_user_id UUID REFERENCES saas.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, channel_type, destination)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_notification_channel
  ON saas.notification_channels (organization_id, channel_type)
  WHERE is_primary = TRUE AND status = 'active';

CREATE TABLE IF NOT EXISTS saas.notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES saas.notification_channels(id) ON DELETE SET NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email', 'whatsapp', 'in_app')),
  event_type TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body_text TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  sent_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_queue
  ON saas.notification_outbox (status, scheduled_at)
  WHERE status IN ('queued', 'failed');

CREATE TABLE IF NOT EXISTS saas.notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES saas.notification_outbox(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES saas.organizations(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  response_code TEXT,
  response_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org
  ON saas.notification_deliveries (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES saas.organizations(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  source_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retrying', 'resolved', 'discarded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL,
  next_retry_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_open
  ON ops.dead_letter_jobs (status, next_retry_at, created_at)
  WHERE status IN ('open', 'retrying');

CREATE TABLE IF NOT EXISTS ops.service_health_snapshots (
  id BIGSERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'offline', 'unknown')),
  latency_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_health_latest
  ON ops.service_health_snapshots (service_name, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_processes_market_heatmap
  ON secop.processes (publication_date DESC, department, city);

CREATE INDEX IF NOT EXISTS idx_processes_market_payer
  ON secop.processes (entity_nit, publication_date DESC);

COMMIT;
