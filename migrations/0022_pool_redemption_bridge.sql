PRAGMA foreign_keys = ON;

ALTER TABLE redemption_codes
  ADD COLUMN provider_grant_id TEXT;

ALTER TABLE redemption_codes
  ADD COLUMN recipient_email_lookup_hash TEXT
    CHECK (
      recipient_email_lookup_hash IS NULL
      OR length(recipient_email_lookup_hash) = 64
    );

ALTER TABLE redemption_codes
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked'));

ALTER TABLE redemption_codes
  ADD COLUMN revoked_at TEXT;

ALTER TABLE redemption_codes
  ADD COLUMN updated_at TEXT;

UPDATE redemption_codes
SET updated_at = COALESCE(updated_at, created_at, datetime('now'));

CREATE UNIQUE INDEX redemption_codes_pool_grant
  ON redemption_codes(provider_grant_id)
  WHERE source = 'pool' AND provider_grant_id IS NOT NULL;

CREATE INDEX redemption_codes_pool_lookup
  ON redemption_codes(code_hash, status, expires_at)
  WHERE source = 'pool';

CREATE TABLE pool_grant_events (
  event_id TEXT PRIMARY KEY,
  provider_grant_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed')),
  failure_code TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX pool_grant_events_grant_action
  ON pool_grant_events(provider_grant_id, action, status, received_at);

CREATE TRIGGER pool_redemption_validate
BEFORE INSERT ON redemptions
WHEN
  (
    SELECT source
    FROM redemption_codes
    WHERE id = NEW.code_id
  ) = 'pool'
  AND NOT EXISTS (
    SELECT 1
    FROM redemption_codes c
    JOIN listener_accounts l ON l.id = NEW.listener_id
    WHERE
      c.id = NEW.code_id
      AND c.source = 'pool'
      AND c.status = 'active'
      AND (
        c.expires_at IS NULL
        OR datetime(c.expires_at) > datetime('now')
      )
      AND c.redemption_count < c.max_redemptions
      AND c.recipient_email_lookup_hash = l.email_lookup_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'pool_redemption_not_available');
END;

CREATE TRIGGER pool_redemption_increment
AFTER INSERT ON redemptions
WHEN (
  SELECT source
  FROM redemption_codes
  WHERE id = NEW.code_id
) = 'pool'
BEGIN
  UPDATE redemption_codes
  SET
    redemption_count = redemption_count + 1,
    updated_at = datetime('now')
  WHERE id = NEW.code_id;
END;
