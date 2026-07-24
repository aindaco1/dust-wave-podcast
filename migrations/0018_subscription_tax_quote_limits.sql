PRAGMA foreign_keys = ON;

ALTER TABLE tax_rate_versions
  ADD COLUMN rate_parts_per_million INTEGER
    CHECK (
      rate_parts_per_million IS NULL
      OR rate_parts_per_million BETWEEN 0 AND 1000000
    );

ALTER TABLE tax_rate_versions
  ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'test'
    CHECK (provider_mode IN ('test', 'live'));

CREATE INDEX tax_rate_versions_quote_lookup
  ON tax_rate_versions(
    jurisdiction_code,
    status,
    provider_mode,
    effective_at,
    expires_at
  );

CREATE TABLE subscription_tax_quote_rate_limits (
  identity_hash TEXT NOT NULL
    CHECK (length(identity_hash) = 64),
  window_started_at INTEGER NOT NULL
    CHECK (window_started_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_count > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (identity_hash, window_started_at)
);

CREATE INDEX subscription_tax_quote_rate_limit_expiry
  ON subscription_tax_quote_rate_limits(expires_at);
