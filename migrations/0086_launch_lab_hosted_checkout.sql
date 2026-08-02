PRAGMA foreign_keys = ON;

-- Hosted Checkout is rehearsed only through the isolated staging fixture.
-- The lifecycle stores resumable test-mode identifiers, never the hosted URL,
-- email, address, payment method, Checkout payload, or browser state.
CREATE TABLE launch_lab_stripe_checkouts (
  run_id TEXT PRIMARY KEY
    REFERENCES launch_lab_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'new'
    CHECK (phase IN (
      'new',
      'customer_ready',
      'attempt_ready',
      'session_open',
      'checkout_completed',
      'cancellation_requested',
      'canceled',
      'customer_deleted',
      'complete',
      'aborted'
    )),
  checkout_attempt_id TEXT NOT NULL UNIQUE,
  provider_customer_id TEXT UNIQUE,
  provider_session_id TEXT UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  cleanup_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cleanup_requested IN (0, 1)),
  customer_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (customer_deleted IN (0, 1)),
  transition_count INTEGER NOT NULL DEFAULT 0
    CHECK (transition_count BETWEEN 0 AND 30),
  last_error_code TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(checkout_attempt_id) BETWEEN 16 AND 160),
  CHECK (last_error_code IS NULL OR length(last_error_code) <= 80)
);

CREATE INDEX launch_lab_stripe_checkout_phase
  ON launch_lab_stripe_checkouts(phase, cleanup_requested, updated_at);
