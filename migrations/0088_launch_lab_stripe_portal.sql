PRAGMA foreign_keys = ON;

-- The Portal rehearsal stores only resumable test-mode identifiers and bounded
-- lifecycle state. Hosted URLs, account data, provider payloads, and browser
-- state are never persisted.
CREATE TABLE launch_lab_stripe_portal_rehearsals (
  run_id TEXT PRIMARY KEY
    REFERENCES launch_lab_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'new'
    CHECK (phase IN (
      'new',
      'customer_ready',
      'portal_verified',
      'customer_deleted',
      'complete',
      'aborted'
    )),
  provider_customer_id TEXT UNIQUE,
  portal_verified INTEGER NOT NULL DEFAULT 0
    CHECK (portal_verified IN (0, 1)),
  customer_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (customer_deleted IN (0, 1)),
  transition_count INTEGER NOT NULL DEFAULT 0
    CHECK (transition_count BETWEEN 0 AND 12),
  last_error_code TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (last_error_code IS NULL OR length(last_error_code) <= 80)
);

CREATE INDEX launch_lab_stripe_portal_phase
  ON launch_lab_stripe_portal_rehearsals(phase, updated_at);
