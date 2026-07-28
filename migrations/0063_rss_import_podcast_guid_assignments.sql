PRAGMA foreign_keys = ON;

-- Immutable provenance for a deliberate one-time adoption of an existing
-- host's Podcasting 2.0 channel identity. Opera's launch backfill predates
-- this workflow and therefore has no row here.
CREATE TABLE rss_import_podcast_guid_assignments (
  show_id TEXT PRIMARY KEY
    REFERENCES shows(id) ON DELETE RESTRICT,
  podcast_guid TEXT NOT NULL UNIQUE
    CHECK (
      length(podcast_guid) = 36
      AND podcast_guid = lower(podcast_guid)
      AND substr(podcast_guid, 9, 1) = '-'
      AND substr(podcast_guid, 14, 1) = '-'
      AND substr(podcast_guid, 19, 1) = '-'
      AND substr(podcast_guid, 24, 1) = '-'
      AND length(replace(podcast_guid, '-', '')) = 32
      AND replace(podcast_guid, '-', '') NOT GLOB '*[^0-9a-f]*'
      AND substr(podcast_guid, 15, 1) = '5'
      AND substr(podcast_guid, 20, 1) IN ('8', '9', 'a', 'b')
    ),
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
  assigned_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER rss_import_podcast_guid_assignment_matches_show
BEFORE INSERT ON rss_import_podcast_guid_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM shows
  WHERE id = NEW.show_id
    AND podcast_guid = NEW.podcast_guid
)
BEGIN
  SELECT RAISE(
    ABORT,
    'rss_import_podcast_guid_assignment_show_mismatch'
  );
END;

CREATE TRIGGER rss_import_podcast_guid_assignments_immutable
BEFORE UPDATE ON rss_import_podcast_guid_assignments
BEGIN
  SELECT RAISE(ABORT, 'rss_import_podcast_guid_assignments_immutable');
END;

CREATE TRIGGER rss_import_podcast_guid_assignments_undeletable
BEFORE DELETE ON rss_import_podcast_guid_assignments
BEGIN
  SELECT RAISE(ABORT, 'rss_import_podcast_guid_assignments_undeletable');
END;
