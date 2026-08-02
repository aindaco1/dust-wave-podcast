PRAGMA foreign_keys = ON;

CREATE TABLE provider_access_health (
  provider TEXT PRIMARY KEY
    CHECK(length(provider) BETWEEN 2 AND 40)
    CHECK(provider NOT GLOB '*[^a-z0-9_-]*'),
  account_reference TEXT
    CHECK(
      account_reference IS NULL
      OR length(account_reference) BETWEEN 1 AND 200
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'ready', 'failed')),
  failure_code TEXT
    CHECK(
      failure_code IS NULL
      OR (
        length(failure_code) BETWEEN 1 AND 80
        AND failure_code NOT GLOB '*[^a-z0-9_-]*'
      )
    ),
  checked_at TEXT
    CHECK(checked_at IS NULL OR julianday(checked_at) IS NOT NULL),
  last_success_at TEXT
    CHECK(last_success_at IS NULL OR julianday(last_success_at) IS NOT NULL),
  next_check_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK(julianday(next_check_at) IS NOT NULL),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK(consecutive_failures BETWEEN 0 AND 1000000),
  lease_token TEXT
    CHECK(
      lease_token IS NULL
      OR (
        length(lease_token) = 32
        AND lease_token NOT GLOB '*[^a-f0-9]*'
      )
    ),
  lease_expires_at TEXT
    CHECK(
      lease_expires_at IS NULL
      OR julianday(lease_expires_at) IS NOT NULL
    ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK(
    status = 'pending'
    OR (
      status = 'ready'
      AND account_reference IS NOT NULL
      AND failure_code IS NULL
      AND checked_at IS NOT NULL
      AND last_success_at IS NOT NULL
      AND consecutive_failures = 0
    )
    OR (
      status = 'failed'
      AND failure_code IS NOT NULL
      AND checked_at IS NOT NULL
      AND consecutive_failures > 0
    )
  )
);

CREATE INDEX idx_provider_access_health_due
  ON provider_access_health(next_check_at, lease_expires_at);
