PRAGMA foreign_keys = ON;

ALTER TABLE subscription_checkout_attempts
  ADD COLUMN stripe_integration_identifier TEXT
    CHECK (
      stripe_integration_identifier IS NULL
      OR (
        length(stripe_integration_identifier) BETWEEN 12 AND 64
        AND stripe_integration_identifier NOT GLOB '*[^a-z_]*'
      )
    );

CREATE TABLE subscription_invoice_tax_evidence (
  event_id TEXT PRIMARY KEY
    REFERENCES stripe_event_journal(event_id) ON DELETE CASCADE,
  provider_invoice_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL,
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL
    REFERENCES shows(id) ON DELETE CASCADE,
  price_id TEXT REFERENCES show_prices(id) ON DELETE SET NULL,
  provider_mode TEXT NOT NULL
    CHECK (provider_mode IN ('test', 'live')),
  invoice_event_type TEXT NOT NULL,
  invoice_status TEXT NOT NULL,
  billing_reason TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  subtotal_cents INTEGER CHECK (subtotal_cents IS NULL OR subtotal_cents >= 0),
  observed_tax_cents INTEGER
    CHECK (observed_tax_cents IS NULL OR observed_tax_cents >= 0),
  total_cents INTEGER CHECK (total_cents IS NULL OR total_cents >= 0),
  amount_paid_cents INTEGER
    CHECK (amount_paid_cents IS NULL OR amount_paid_cents >= 0),
  period_start TEXT,
  period_end TEXT,
  destination_hash TEXT CHECK (
    destination_hash IS NULL OR length(destination_hash) = 64
  ),
  expected_tax_rate_version_id TEXT
    REFERENCES tax_rate_versions(id) ON DELETE SET NULL,
  expected_jurisdiction_code TEXT,
  expected_rate_parts_per_million INTEGER CHECK (
    expected_rate_parts_per_million IS NULL
    OR expected_rate_parts_per_million BETWEEN 0 AND 1000000
  ),
  expected_tax_behavior TEXT CHECK (
    expected_tax_behavior IS NULL
    OR expected_tax_behavior IN ('exclusive', 'inclusive')
  ),
  expected_subtotal_cents INTEGER CHECK (
    expected_subtotal_cents IS NULL OR expected_subtotal_cents >= 0
  ),
  expected_tax_cents INTEGER CHECK (
    expected_tax_cents IS NULL OR expected_tax_cents >= 0
  ),
  expected_total_cents INTEGER CHECK (
    expected_total_cents IS NULL OR expected_total_cents >= 0
  ),
  expected_stripe_tax_rate_id TEXT,
  observed_tax_rate_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(observed_tax_rate_ids_json)),
  reconciliation_status TEXT NOT NULL CHECK (
    reconciliation_status IN (
      'matched',
      'mismatched',
      'missing_checkout_evidence',
      'missing_provider_tax_evidence'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX subscription_invoice_tax_evidence_show
  ON subscription_invoice_tax_evidence(show_id, created_at DESC, event_id DESC);

CREATE INDEX subscription_invoice_tax_evidence_recent
  ON subscription_invoice_tax_evidence(created_at DESC, event_id DESC);

CREATE INDEX subscription_invoice_tax_evidence_attention
  ON subscription_invoice_tax_evidence(
    reconciliation_status,
    created_at DESC
  )
  WHERE reconciliation_status != 'matched';

CREATE INDEX subscription_invoice_tax_evidence_subscription
  ON subscription_invoice_tax_evidence(
    provider_subscription_id,
    created_at DESC
  );

CREATE TABLE subscription_tax_change_previews (
  event_id TEXT NOT NULL
    REFERENCES stripe_event_journal(event_id) ON DELETE CASCADE,
  provider_subscription_id TEXT NOT NULL,
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL
    REFERENCES shows(id) ON DELETE CASCADE,
  price_id TEXT REFERENCES show_prices(id) ON DELETE SET NULL,
  provider_mode TEXT NOT NULL
    CHECK (provider_mode IN ('test', 'live')),
  destination_hash TEXT CHECK (
    destination_hash IS NULL OR length(destination_hash) = 64
  ),
  prior_destination_hash TEXT CHECK (
    prior_destination_hash IS NULL OR length(prior_destination_hash) = 64
  ),
  prior_tax_rate_version_id TEXT
    REFERENCES tax_rate_versions(id) ON DELETE SET NULL,
  resolved_tax_rate_version_id TEXT
    REFERENCES tax_rate_versions(id) ON DELETE SET NULL,
  prior_jurisdiction_code TEXT,
  resolved_jurisdiction_code TEXT,
  prior_rate_parts_per_million INTEGER CHECK (
    prior_rate_parts_per_million IS NULL
    OR prior_rate_parts_per_million BETWEEN 0 AND 1000000
  ),
  resolved_rate_parts_per_million INTEGER CHECK (
    resolved_rate_parts_per_million IS NULL
    OR resolved_rate_parts_per_million BETWEEN 0 AND 1000000
  ),
  preview_status TEXT NOT NULL CHECK (
    preview_status IN (
      'unchanged',
      'rate_changed',
      'destination_invalid',
      'rate_missing',
      'configuration_mismatch',
      'configuration_missing'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, provider_subscription_id)
);

CREATE INDEX subscription_tax_change_previews_show
  ON subscription_tax_change_previews(show_id, created_at DESC, event_id DESC);

CREATE INDEX subscription_tax_change_previews_attention
  ON subscription_tax_change_previews(preview_status, created_at DESC)
  WHERE preview_status != 'unchanged';

CREATE INDEX subscription_checkout_tax_context
  ON subscription_checkout_attempts(
    listener_id,
    show_id,
    price_id,
    status,
    created_at DESC,
    id DESC
  )
  WHERE listener_id IS NOT NULL;

CREATE INDEX subscription_entitlement_provider_customer
  ON subscription_entitlement_sources(
    provider,
    provider_customer_id,
    show_id
  )
  WHERE provider_customer_id IS NOT NULL;
