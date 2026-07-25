PRAGMA foreign_keys = ON;

CREATE TABLE show_notification_preferences (
  listener_id TEXT NOT NULL
    REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL
    REFERENCES shows(id) ON DELETE CASCADE,
  announcements_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (announcements_enabled IN (0, 1)),
  language TEXT NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'es')),
  consent_source TEXT NOT NULL DEFAULT 'member_account'
    CHECK (consent_source = 'member_account'),
  consented_at TEXT,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (listener_id, show_id),
  CHECK (
    announcements_enabled = 0
    OR (consented_at IS NOT NULL AND withdrawn_at IS NULL)
  )
);

CREATE INDEX show_notification_preferences_eligible
  ON show_notification_preferences(
    show_id,
    language,
    updated_at,
    listener_id
  )
  WHERE announcements_enabled = 1 AND withdrawn_at IS NULL;
