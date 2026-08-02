PRAGMA foreign_keys = ON;

-- Durable, content-minimal reminders for human decisions that cannot be
-- automated safely. Recipient addresses, login tokens, media keys, and
-- provider response bodies are intentionally excluded.
CREATE TABLE admin_action_notifications (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  action_kind TEXT NOT NULL
    CHECK (action_kind IN ('working_master_decision')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 160),
  action_digest TEXT NOT NULL UNIQUE
    CHECK (
      length(action_digest) = 64
      AND action_digest NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'resolved', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 20 AND 100),
  lease_expires_at TEXT,
  provider_id TEXT
    CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 160),
  failure_code TEXT
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 120),
  sent_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (action_kind, target_id, action_digest),
  CHECK (
    (status = 'sending' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status != 'sending'
  ),
  CHECK (status != 'sent' OR sent_at IS NOT NULL),
  CHECK (status != 'resolved' OR resolved_at IS NOT NULL)
);

CREATE INDEX admin_action_notifications_due
  ON admin_action_notifications(status, next_attempt_at, created_at);

CREATE INDEX admin_action_notifications_target
  ON admin_action_notifications(action_kind, target_id, status);
