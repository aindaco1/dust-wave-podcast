PRAGMA foreign_keys = ON;

CREATE TABLE subscription_entitlement_sources (
  id TEXT PRIMARY KEY,
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL
    REFERENCES shows(id) ON DELETE CASCADE,
  price_id TEXT REFERENCES show_prices(id),
  provider TEXT NOT NULL
    CHECK (provider IN ('stripe', 'pool', 'manual')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'active',
        'past_due',
        'paused',
        'canceled',
        'expired'
      )
    ),
  current_period_end TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listener_id, show_id, provider)
);

CREATE UNIQUE INDEX subscription_entitlement_provider_subscription
  ON subscription_entitlement_sources(provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX subscription_entitlement_projection
  ON subscription_entitlement_sources(
    listener_id,
    show_id,
    status,
    current_period_end
  );

INSERT INTO subscription_entitlement_sources (
  id,
  listener_id,
  show_id,
  price_id,
  provider,
  provider_customer_id,
  provider_subscription_id,
  status,
  current_period_end,
  canceled_at,
  created_at,
  updated_at
)
SELECT
  'source_' || id,
  listener_id,
  show_id,
  price_id,
  provider,
  provider_customer_id,
  provider_subscription_id,
  status,
  current_period_end,
  canceled_at,
  created_at,
  updated_at
FROM subscriptions;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN email_lookup_hash TEXT
    CHECK (
      email_lookup_hash IS NULL
      OR length(email_lookup_hash) = 64
    );

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN destination_hash TEXT
    CHECK (
      destination_hash IS NULL
      OR length(destination_hash) = 64
    );

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN provider_customer_id TEXT;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN provider_mode TEXT
    CHECK (provider_mode IS NULL OR provider_mode IN ('test', 'live'));

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_rate_version_id TEXT
    REFERENCES tax_rate_versions(id);

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN jurisdiction_code TEXT;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_rate_parts_per_million INTEGER
    CHECK (
      tax_rate_parts_per_million IS NULL
      OR tax_rate_parts_per_million BETWEEN 0 AND 1000000
    );

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_behavior TEXT
    CHECK (
      tax_behavior IS NULL
      OR tax_behavior IN ('exclusive', 'inclusive')
    );

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN subtotal_cents INTEGER
    CHECK (subtotal_cents IS NULL OR subtotal_cents >= 0);

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_cents INTEGER
    CHECK (tax_cents IS NULL OR tax_cents >= 0);

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN total_cents INTEGER
    CHECK (total_cents IS NULL OR total_cents >= 0);

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_provider_name TEXT;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN tax_source_reference TEXT;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN failure_code TEXT;

CREATE UNIQUE INDEX subscription_checkout_one_active
  ON subscription_checkout_attempts(show_id, email_lookup_hash)
  WHERE status = 'created' AND email_lookup_hash IS NOT NULL;

CREATE INDEX subscription_checkout_listener_lookup
  ON subscription_checkout_attempts(email_lookup_hash, created_at);

CREATE TABLE subscription_billing_rate_limits (
  action TEXT NOT NULL,
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (action, identity_hash, window_started_at)
);

CREATE INDEX subscription_billing_rate_limit_expiry
  ON subscription_billing_rate_limits(expires_at);
