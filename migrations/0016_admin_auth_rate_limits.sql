PRAGMA foreign_keys = ON;

CREATE TABLE admin_auth_rate_limit_buckets (
  action TEXT NOT NULL
    CHECK (action IN ('start_client', 'start_email', 'exchange_client')),
  identity_hash TEXT NOT NULL
    CHECK (length(identity_hash) = 64),
  window_started_at INTEGER NOT NULL
    CHECK (window_started_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_count > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (action, identity_hash, window_started_at)
);

CREATE INDEX admin_auth_rate_limit_expiry
  ON admin_auth_rate_limit_buckets(expires_at);

CREATE INDEX admin_sessions_expiry
  ON admin_sessions(expires_at);
