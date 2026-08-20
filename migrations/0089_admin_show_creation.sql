PRAGMA foreign_keys = ON;

-- Show creation is intentionally retry-safe. The browser supplies an opaque
-- request id and the Worker stores only that id plus a digest of the normalized
-- show metadata; no administrator or subscriber PII is recorded here.
ALTER TABLE shows
  ADD COLUMN creation_request_id TEXT
    CHECK (
      creation_request_id IS NULL
      OR (
        length(creation_request_id) BETWEEN 16 AND 160
        AND creation_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    );

ALTER TABLE shows
  ADD COLUMN creation_request_sha256 TEXT
    CHECK (
      creation_request_sha256 IS NULL
      OR (
        length(creation_request_sha256) = 64
        AND creation_request_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

CREATE UNIQUE INDEX shows_creation_request_unique
  ON shows(creation_request_id)
  WHERE creation_request_id IS NOT NULL;

CREATE TRIGGER shows_creation_request_pair_insert
BEFORE INSERT ON shows
FOR EACH ROW
WHEN
  (NEW.creation_request_id IS NULL)
  IS NOT (NEW.creation_request_sha256 IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'shows.creation_request pair is incomplete');
END;

CREATE TRIGGER shows_creation_request_immutable
BEFORE UPDATE OF creation_request_id, creation_request_sha256 ON shows
FOR EACH ROW
WHEN
  OLD.creation_request_id IS NOT NEW.creation_request_id
  OR OLD.creation_request_sha256 IS NOT NEW.creation_request_sha256
BEGIN
  SELECT RAISE(ABORT, 'shows.creation_request is immutable');
END;

-- Migration 0027 initialized the then-current catalog. Every subsequently
-- created show must receive the same directory-owner checklist.
CREATE TRIGGER show_distribution_setup_insert
AFTER INSERT ON shows
BEGIN
  INSERT INTO show_distribution_destinations (
    show_id,
    destination_id,
    enabled,
    owner_setup_status
  )
  SELECT
    NEW.id,
    id,
    enabled,
    owner_setup_status
  FROM distribution_destinations;
END;

-- Deletion is limited to unused show shells created by the admin workflow.
-- Keep their public identity retired so a previously issued page, feed URL,
-- or Podcast GUID can never be reassigned to unrelated content.
CREATE TABLE deleted_show_identities (
  show_id TEXT PRIMARY KEY
    CHECK (length(show_id) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE
    CHECK (
      length(slug) BETWEEN 1 AND 120
      AND slug = lower(slug)
      AND slug NOT GLOB '*[^a-z0-9-]*'
    ),
  rss_slug TEXT NOT NULL UNIQUE
    CHECK (length(rss_slug) BETWEEN 1 AND 120),
  podcast_guid TEXT NOT NULL UNIQUE
    CHECK (length(podcast_guid) = 36),
  creation_request_id TEXT NOT NULL UNIQUE
    CHECK (length(creation_request_id) BETWEEN 16 AND 160),
  deletion_request_id TEXT NOT NULL UNIQUE
    CHECK (
      length(deletion_request_id) BETWEEN 16 AND 160
      AND deletion_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  deletion_request_sha256 TEXT NOT NULL
    CHECK (
      length(deletion_request_sha256) = 64
      AND deletion_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  deleted_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER deleted_show_identities_immutable
BEFORE UPDATE ON deleted_show_identities
BEGIN
  SELECT RAISE(ABORT, 'deleted_show_identity_immutable');
END;

CREATE TRIGGER deleted_show_identities_undeletable
BEFORE DELETE ON deleted_show_identities
BEGIN
  SELECT RAISE(ABORT, 'deleted_show_identity_undeletable');
END;
