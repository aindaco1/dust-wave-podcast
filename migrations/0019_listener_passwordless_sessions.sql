PRAGMA foreign_keys = ON;

CREATE TABLE listener_login_tokens (
  token_hash TEXT PRIMARY KEY
    CHECK (length(token_hash) = 64),
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX listener_login_tokens_expiry
  ON listener_login_tokens(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE listener_sessions (
  token_hash TEXT PRIMARY KEY
    CHECK (length(token_hash) = 64),
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL
    CHECK (length(csrf_token_hash) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX listener_sessions_listener
  ON listener_sessions(listener_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX listener_sessions_expiry
  ON listener_sessions(expires_at);

CREATE TABLE listener_auth_rate_limit_buckets (
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

CREATE INDEX listener_auth_rate_limit_expiry
  ON listener_auth_rate_limit_buckets(expires_at);

CREATE INDEX private_feed_tokens_listener_active
  ON private_feed_tokens(listener_id, show_id, created_at DESC)
  WHERE revoked_at IS NULL;
