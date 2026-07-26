PRAGMA foreign_keys = ON;

ALTER TABLE show_notification_preferences
  ADD COLUMN unsubscribe_token_hash TEXT
    CHECK (
      unsubscribe_token_hash IS NULL
      OR length(unsubscribe_token_hash) = 64
    );

CREATE TABLE podcast_announcements (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  language TEXT NOT NULL CHECK (language IN ('en', 'es')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  heading TEXT NOT NULL DEFAULT '' CHECK (length(heading) <= 160),
  body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 10000),
  cta_label TEXT NOT NULL DEFAULT '' CHECK (length(cta_label) <= 80),
  cta_url TEXT NOT NULL DEFAULT '' CHECK (length(cta_url) <= 2048),
  announcement_revision TEXT NOT NULL CHECK (length(announcement_revision) = 64),
  audience_revision TEXT NOT NULL CHECK (length(audience_revision) = 64),
  review_hash TEXT NOT NULL CHECK (length(review_hash) = 64),
  eligible_recipient_count INTEGER NOT NULL
    CHECK (eligible_recipient_count >= 0),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('dry_run', 'live')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'partial', 'failed', 'canceled')),
  created_by_admin_user_id TEXT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  approved_by_admin_user_id TEXT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, revision),
  UNIQUE (show_id, review_hash)
);

CREATE TRIGGER podcast_announcements_content_immutable
BEFORE UPDATE OF
  show_id,
  revision,
  language,
  subject,
  heading,
  body_markdown,
  cta_label,
  cta_url,
  announcement_revision,
  audience_revision,
  review_hash,
  eligible_recipient_count,
  delivery_mode,
  created_by_admin_user_id,
  approved_by_admin_user_id,
  approved_at
ON podcast_announcements
BEGIN
  SELECT RAISE(ABORT, 'podcast_announcement_content_immutable');
END;

CREATE TABLE podcast_announcement_deliveries (
  id TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL
    REFERENCES podcast_announcements(id) ON DELETE CASCADE,
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  destination_hash TEXT NOT NULL CHECK (length(destination_hash) = 64),
  preference_updated_at TEXT NOT NULL,
  entitlement_updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'queued',
      'sending',
      'retry',
      'accepted',
      'delivered',
      'dry_run',
      'suppressed',
      'failed',
      'canceled'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_attempt_at TEXT,
  last_attempt_at TEXT,
  provider_id TEXT,
  last_error_code TEXT,
  accepted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (announcement_id, listener_id)
);

CREATE INDEX podcast_announcement_deliveries_due
  ON podcast_announcement_deliveries(
    status,
    next_attempt_at,
    announcement_id,
    id
  );

CREATE INDEX podcast_announcement_deliveries_provider
  ON podcast_announcement_deliveries(provider_id)
  WHERE provider_id IS NOT NULL;

CREATE INDEX podcast_announcements_show_recent
  ON podcast_announcements(show_id, created_at DESC, id DESC);

CREATE TABLE podcast_announcement_suppressions (
  destination_hash TEXT PRIMARY KEY CHECK (length(destination_hash) = 64),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 80),
  provider_id TEXT,
  source_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE podcast_resend_webhook_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  provider_id TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX podcast_resend_webhook_events_processed
  ON podcast_resend_webhook_events(processed_at);
