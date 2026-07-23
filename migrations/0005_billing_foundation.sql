ALTER TABLE shows ADD COLUMN stripe_product_id TEXT;
ALTER TABLE shows ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'disabled'
  CHECK (billing_mode IN ('disabled', 'test', 'live'));

ALTER TABLE show_prices ADD COLUMN stripe_lookup_key TEXT;
ALTER TABLE show_prices ADD COLUMN tax_behavior TEXT NOT NULL DEFAULT 'exclusive'
  CHECK (tax_behavior IN ('exclusive', 'inclusive'));
ALTER TABLE show_prices ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'test'
  CHECK (provider_mode IN ('test', 'live'));

CREATE UNIQUE INDEX show_prices_lookup_key_unique
  ON show_prices(stripe_lookup_key)
  WHERE stripe_lookup_key IS NOT NULL;

CREATE TABLE stripe_event_journal (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  provider_created_at INTEGER NOT NULL,
  object_id TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX stripe_event_journal_status
  ON stripe_event_journal(status, received_at);

CREATE TABLE subscription_checkout_attempts (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  price_id TEXT NOT NULL REFERENCES show_prices(id),
  listener_id TEXT REFERENCES listener_accounts(id) ON DELETE SET NULL,
  stripe_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'completed', 'expired', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tax_rate_versions (
  id TEXT PRIMARY KEY,
  jurisdiction_code TEXT NOT NULL,
  rate_basis_points INTEGER NOT NULL
    CHECK (rate_basis_points BETWEEN 0 AND 10000),
  inclusive INTEGER NOT NULL DEFAULT 0 CHECK (inclusive IN (0, 1)),
  stripe_tax_rate_id TEXT UNIQUE,
  provider_name TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'retired')),
  approved_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX tax_rate_versions_effective
  ON tax_rate_versions(jurisdiction_code, status, effective_at, expires_at);

CREATE TABLE show_tax_rate_assignments (
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  tax_rate_version_id TEXT NOT NULL REFERENCES tax_rate_versions(id),
  assigned_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (show_id, tax_rate_version_id)
);
