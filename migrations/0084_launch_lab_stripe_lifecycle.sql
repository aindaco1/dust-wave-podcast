PRAGMA foreign_keys = ON;

-- A single reusable test-mode Product/Price prevents scheduled rehearsals from
-- creating unbounded provider catalog objects. The signed staging-only Launch
-- Lab boundary validates both objects before every use.
CREATE TABLE launch_lab_stripe_fixture_config (
  id TEXT PRIMARY KEY CHECK (id = 'subscription_monthly_v1'),
  provider_product_id TEXT UNIQUE,
  provider_price_id TEXT UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO launch_lab_stripe_fixture_config (id)
VALUES ('subscription_monthly_v1');

-- Provider mutations are split into resumable phases. Object references are
-- test-mode identifiers only; no email, address, card detail, hosted URL, or
-- webhook payload is retained here or exposed by the Launch Lab response.
CREATE TABLE launch_lab_stripe_lifecycles (
  run_id TEXT PRIMARY KEY
    REFERENCES launch_lab_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'new'
    CHECK (phase IN (
      'new',
      'product_ready',
      'price_ready',
      'clock_ready',
      'customer_ready',
      'subscription_created',
      'initial_active',
      'renewal_advancing',
      'renewed',
      'failure_payment_method_ready',
      'failure_payment_method_set',
      'failure_advancing',
      'failed_payment',
      'recovery_payment_method_ready',
      'recovery_payment_method_set',
      'recovery_invoice_ready',
      'recovery_payment_requested',
      'recovered',
      'cancellation_requested',
      'canceled',
      'clock_deleted',
      'complete'
    )),
  checkout_attempt_id TEXT NOT NULL UNIQUE,
  provider_clock_id TEXT UNIQUE,
  provider_customer_id TEXT UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  provider_failure_payment_method_id TEXT,
  provider_recovery_payment_method_id TEXT,
  provider_recovery_invoice_id TEXT,
  initial_period_end INTEGER,
  renewal_period_end INTEGER,
  transition_count INTEGER NOT NULL DEFAULT 0
    CHECK (transition_count BETWEEN 0 AND 40),
  last_error_code TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(checkout_attempt_id) BETWEEN 16 AND 160),
  CHECK (initial_period_end IS NULL OR initial_period_end > 0),
  CHECK (renewal_period_end IS NULL OR renewal_period_end > 0),
  CHECK (last_error_code IS NULL OR length(last_error_code) <= 80)
);

CREATE INDEX launch_lab_stripe_lifecycle_phase
  ON launch_lab_stripe_lifecycles(phase, updated_at);
