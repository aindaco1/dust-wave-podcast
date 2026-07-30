PRAGMA foreign_keys = ON;

CREATE TABLE clip_publications (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE RESTRICT,
  clip_revision INTEGER NOT NULL CHECK (clip_revision > 0),
  render_id TEXT NOT NULL UNIQUE
    REFERENCES clip_renders(id) ON DELETE RESTRICT,
  public_slug TEXT NOT NULL
    CHECK (
      length(public_slug) BETWEEN 1 AND 100
      AND public_slug NOT GLOB '*[^a-z0-9-]*'
      AND public_slug NOT LIKE '-%'
      AND public_slug NOT LIKE '%-'
      AND public_slug NOT LIKE '%--%'
    ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1_000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'withdrawn')),
  output_object_key TEXT NOT NULL CHECK (length(output_object_key) <= 1_024),
  output_object_bytes INTEGER NOT NULL
    CHECK (output_object_bytes BETWEEN 1 AND 99614720),
  output_object_etag TEXT NOT NULL
    CHECK (length(output_object_etag) BETWEEN 1 AND 256),
  output_sha256 TEXT NOT NULL
    CHECK (
      length(output_sha256) = 64
      AND output_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  output_mime_type TEXT NOT NULL CHECK (output_mime_type = 'video/mp4'),
  output_width INTEGER NOT NULL CHECK (output_width > 0),
  output_height INTEGER NOT NULL CHECK (output_height > 0),
  output_duration_ms INTEGER NOT NULL CHECK (output_duration_ms > 0),
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  withdrawn_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, episode_id, public_slug),
  CHECK (
    (status = 'draft' AND approved_at IS NULL AND withdrawn_at IS NULL)
    OR (
      status = 'approved'
      AND approved_at IS NOT NULL
      AND withdrawn_at IS NULL
    )
    OR (
      status = 'withdrawn'
      AND approved_at IS NOT NULL
      AND withdrawn_at IS NOT NULL
    )
  )
);

CREATE INDEX clip_publications_public_lookup
  ON clip_publications(
    show_id,
    episode_id,
    status,
    public_slug
  );

