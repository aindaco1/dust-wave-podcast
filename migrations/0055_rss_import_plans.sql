PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_plans (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  requested_feed_url_sha256 TEXT NOT NULL
    CHECK (
      length(requested_feed_url_sha256) = 64
      AND requested_feed_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  requested_feed_display_url TEXT NOT NULL
    CHECK (
      length(requested_feed_display_url) BETWEEN 8 AND 2_048
      AND substr(requested_feed_display_url, 1, 8) = 'https://'
      AND instr(requested_feed_display_url, '?') = 0
      AND instr(requested_feed_display_url, '#') = 0
    ),
  resolved_feed_url_sha256 TEXT NOT NULL
    CHECK (
      length(resolved_feed_url_sha256) = 64
      AND resolved_feed_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  resolved_feed_display_url TEXT NOT NULL
    CHECK (
      length(resolved_feed_display_url) BETWEEN 8 AND 2_048
      AND substr(resolved_feed_display_url, 1, 8) = 'https://'
      AND instr(resolved_feed_display_url, '?') = 0
      AND instr(resolved_feed_display_url, '#') = 0
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
  feed_title TEXT NOT NULL CHECK (length(feed_title) BETWEEN 1 AND 240),
  feed_item_count INTEGER NOT NULL
    CHECK (feed_item_count BETWEEN 1 AND 500),
  migratable_item_count INTEGER NOT NULL
    CHECK (
      migratable_item_count BETWEEN 1 AND feed_item_count
    ),
  selected_item_count INTEGER NOT NULL
    CHECK (
      selected_item_count BETWEEN 1 AND 25
      AND selected_item_count <= migratable_item_count
    ),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewed', 'canceled')),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  canceled_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  cancellation_reason_sha256 TEXT
    CHECK (
      cancellation_reason_sha256 IS NULL
      OR (
        length(cancellation_reason_sha256) = 64
        AND cancellation_reason_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  canceled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, feed_sha256, selection_sha256),
  CHECK (
    (
      status = 'draft'
      AND reviewed_at IS NULL
      AND canceled_at IS NULL
      AND cancellation_reason_sha256 IS NULL
    )
    OR (
      status = 'reviewed'
      AND reviewed_at IS NOT NULL
      AND canceled_at IS NULL
      AND cancellation_reason_sha256 IS NULL
    )
    OR (
      status = 'canceled'
      AND canceled_at IS NOT NULL
      AND cancellation_reason_sha256 IS NOT NULL
    )
  )
);

CREATE TABLE rss_import_plan_items (
  plan_id TEXT NOT NULL
    REFERENCES rss_import_plans(id) ON DELETE RESTRICT,
  source_identity_sha256 TEXT NOT NULL
    CHECK (
      length(source_identity_sha256) = 64
      AND source_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 499),
  metadata_sha256 TEXT NOT NULL
    CHECK (
      length(metadata_sha256) = 64
      AND metadata_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 4_000),
  published_at TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds > 0),
  explicit INTEGER CHECK (explicit IS NULL OR explicit IN (0, 1)),
  canonical_display_url TEXT
    CHECK (
      canonical_display_url IS NULL
      OR (
        length(canonical_display_url) BETWEEN 8 AND 2_048
        AND substr(canonical_display_url, 1, 8) = 'https://'
        AND instr(canonical_display_url, '?') = 0
        AND instr(canonical_display_url, '#') = 0
      )
    ),
  enclosure_url_sha256 TEXT NOT NULL
    CHECK (
      length(enclosure_url_sha256) = 64
      AND enclosure_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  enclosure_display_url TEXT NOT NULL
    CHECK (
      length(enclosure_display_url) BETWEEN 8 AND 2_048
      AND substr(enclosure_display_url, 1, 8) = 'https://'
      AND instr(enclosure_display_url, '?') = 0
      AND instr(enclosure_display_url, '#') = 0
    ),
  enclosure_mime_type TEXT NOT NULL
    CHECK (length(enclosure_mime_type) BETWEEN 1 AND 120),
  enclosure_bytes INTEGER NOT NULL CHECK (enclosure_bytes > 0),
  warnings_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(warnings_json) <= 2_000),
  PRIMARY KEY (plan_id, source_identity_sha256),
  UNIQUE (plan_id, ordinal)
);

CREATE INDEX rss_import_plans_show_updated
  ON rss_import_plans(show_id, updated_at DESC, id DESC);

CREATE TRIGGER rss_import_plan_items_immutable_update
BEFORE UPDATE ON rss_import_plan_items
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plan_items_immutable');
END;

CREATE TRIGGER rss_import_plan_items_immutable_delete
BEFORE DELETE ON rss_import_plan_items
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plan_items_immutable');
END;

CREATE TRIGGER rss_import_plans_evidence_immutable
BEFORE UPDATE ON rss_import_plans
WHEN
  OLD.id IS NOT NEW.id
  OR OLD.show_id IS NOT NEW.show_id
  OR OLD.requested_feed_url_sha256 IS NOT NEW.requested_feed_url_sha256
  OR OLD.requested_feed_display_url IS NOT NEW.requested_feed_display_url
  OR OLD.resolved_feed_url_sha256 IS NOT NEW.resolved_feed_url_sha256
  OR OLD.resolved_feed_display_url IS NOT NEW.resolved_feed_display_url
  OR OLD.feed_sha256 IS NOT NEW.feed_sha256
  OR OLD.selection_sha256 IS NOT NEW.selection_sha256
  OR OLD.feed_title IS NOT NEW.feed_title
  OR OLD.feed_item_count IS NOT NEW.feed_item_count
  OR OLD.migratable_item_count IS NOT NEW.migratable_item_count
  OR OLD.selected_item_count IS NOT NEW.selected_item_count
  OR OLD.requested_by_admin_user_id IS NOT NEW.requested_by_admin_user_id
  OR OLD.requested_at IS NOT NEW.requested_at
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plan_evidence_immutable');
END;

CREATE TRIGGER rss_import_plans_immutable_delete
BEFORE DELETE ON rss_import_plans
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plans_immutable');
END;
