PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_executions (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  plan_id TEXT NOT NULL UNIQUE
    REFERENCES rss_import_plans(id) ON DELETE RESTRICT,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  feed_url_ciphertext TEXT NOT NULL
    CHECK (
      length(feed_url_ciphertext) BETWEEN 32 AND 4_096
      AND (
        substr(feed_url_ciphertext, 1, 11) = 'aes-gcm-v1:'
        OR feed_url_ciphertext =
          'not_retained:rss_import_execution_complete:v1'
        OR feed_url_ciphertext =
          'not_retained:rss_import_execution_expired:v1'
      )
    ),
  feed_url_sha256 TEXT NOT NULL
    CHECK (
      length(feed_url_sha256) = 64
      AND feed_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  feed_sha256 TEXT NOT NULL
    CHECK (
      length(feed_sha256) = 64
      AND feed_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  selection_sha256 TEXT NOT NULL
    CHECK (
      length(selection_sha256) = 64
      AND selection_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN ('queued', 'running', 'succeeded', 'partial', 'failed')
    ),
  expected_item_count INTEGER NOT NULL
    CHECK (expected_item_count BETWEEN 1 AND 25),
  copied_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      copied_item_count BETWEEN 0 AND expected_item_count
    ),
  draft_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      draft_item_count BETWEEN 0 AND expected_item_count
      AND draft_item_count <= copied_item_count
    ),
  failed_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      failed_item_count BETWEEN 0 AND expected_item_count
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  source_url_expires_at TEXT NOT NULL,
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 1 AND 120
        AND last_error_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (copied_item_count + failed_item_count <= expected_item_count)
);

CREATE TABLE rss_import_execution_items (
  execution_id TEXT NOT NULL
    REFERENCES rss_import_executions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  source_identity_sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 24),
  target_episode_id TEXT NOT NULL UNIQUE
    CHECK (
      length(target_episode_id) BETWEEN 1 AND 160
      AND target_episode_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  target_slug TEXT NOT NULL
    CHECK (
      length(target_slug) BETWEEN 1 AND 120
      AND target_slug NOT GLOB '*[^a-z0-9-]*'
      AND substr(target_slug, 1, 1) != '-'
      AND substr(target_slug, -1, 1) != '-'
      AND instr(target_slug, '--') = 0
    ),
  source_language TEXT NOT NULL
    CHECK (source_language IN ('en', 'es')),
  target_object_key TEXT NOT NULL UNIQUE
    CHECK (
      length(target_object_key) BETWEEN 1 AND 1_024
      AND instr(target_object_key, '..') = 0
      AND substr(target_object_key, 1, 1) != '/'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 5),
  queue_sent_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  response_resolved_url_sha256 TEXT
    CHECK (
      response_resolved_url_sha256 IS NULL
      OR (
        length(response_resolved_url_sha256) = 64
        AND response_resolved_url_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  copied_bytes INTEGER CHECK (copied_bytes IS NULL OR copied_bytes > 0),
  copied_sha256 TEXT
    CHECK (
      copied_sha256 IS NULL
      OR (
        length(copied_sha256) = 64
        AND copied_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  copied_etag TEXT CHECK (copied_etag IS NULL OR length(copied_etag) <= 300),
  copied_mime_type TEXT
    CHECK (
      copied_mime_type IS NULL
      OR length(copied_mime_type) BETWEEN 1 AND 120
    ),
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 1 AND 120
        AND last_error_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  PRIMARY KEY (execution_id, source_identity_sha256),
  UNIQUE (execution_id, ordinal),
  UNIQUE (execution_id, target_slug),
  FOREIGN KEY (plan_id, source_identity_sha256)
    REFERENCES rss_import_plan_items(plan_id, source_identity_sha256)
    ON DELETE RESTRICT,
  CHECK (
    status != 'succeeded'
    OR (
      response_resolved_url_sha256 IS NOT NULL
      AND copied_bytes IS NOT NULL
      AND copied_sha256 IS NOT NULL
      AND copied_etag IS NOT NULL
      AND copied_mime_type IS NOT NULL
      AND episode_id = target_episode_id
      AND last_error_code IS NULL
    )
  )
);

CREATE INDEX rss_import_execution_items_recovery
  ON rss_import_execution_items(status, queue_sent_at, attempt_count);

CREATE INDEX rss_import_executions_show_updated
  ON rss_import_executions(show_id, updated_at DESC, id DESC);

CREATE TRIGGER rss_import_execution_identity_immutable
BEFORE UPDATE ON rss_import_executions
WHEN
  OLD.id IS NOT NEW.id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.show_id IS NOT NEW.show_id
  OR OLD.feed_url_sha256 IS NOT NEW.feed_url_sha256
  OR OLD.feed_sha256 IS NOT NEW.feed_sha256
  OR OLD.selection_sha256 IS NOT NEW.selection_sha256
  OR OLD.expected_item_count IS NOT NEW.expected_item_count
  OR OLD.requested_by_admin_user_id IS NOT NEW.requested_by_admin_user_id
  OR OLD.requested_at IS NOT NEW.requested_at
BEGIN
  SELECT RAISE(ABORT, 'rss_import_execution_identity_immutable');
END;

CREATE TRIGGER rss_import_execution_items_identity_immutable
BEFORE UPDATE ON rss_import_execution_items
WHEN
  OLD.execution_id IS NOT NEW.execution_id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.source_identity_sha256 IS NOT NEW.source_identity_sha256
  OR OLD.ordinal IS NOT NEW.ordinal
  OR OLD.target_episode_id IS NOT NEW.target_episode_id
  OR OLD.target_slug IS NOT NEW.target_slug
  OR OLD.source_language IS NOT NEW.source_language
  OR OLD.target_object_key IS NOT NEW.target_object_key
BEGIN
  SELECT RAISE(ABORT, 'rss_import_execution_item_identity_immutable');
END;

CREATE TRIGGER rss_import_executions_immutable_delete
BEFORE DELETE ON rss_import_executions
BEGIN
  SELECT RAISE(ABORT, 'rss_import_executions_immutable');
END;

CREATE TRIGGER rss_import_execution_items_immutable_delete
BEFORE DELETE ON rss_import_execution_items
BEGIN
  SELECT RAISE(ABORT, 'rss_import_execution_items_immutable');
END;

CREATE TRIGGER rss_import_plan_execution_lock
BEFORE UPDATE OF status ON rss_import_plans
WHEN
  NEW.status = 'canceled'
  AND EXISTS (
    SELECT 1
    FROM rss_import_executions execution
    WHERE execution.plan_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plan_has_execution');
END;
