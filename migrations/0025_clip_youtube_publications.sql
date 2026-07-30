PRAGMA foreign_keys = ON;

CREATE TABLE clip_youtube_publications (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE RESTRICT,
  clip_revision INTEGER NOT NULL CHECK (clip_revision > 0),
  render_id TEXT NOT NULL UNIQUE
    REFERENCES clip_renders(id) ON DELETE RESTRICT,
  channel_url TEXT NOT NULL CHECK (length(channel_url) BETWEEN 1 AND 2000),
  channel_id TEXT
    CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 6 AND 200),
  privacy_status TEXT NOT NULL
    CHECK (privacy_status IN ('private', 'unlisted')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (
      status IN (
        'draft',
        'queued',
        'uploading',
        'uploaded',
        'dry_run',
        'failed',
        'canceled'
      )
    ),
  provider_video_id TEXT UNIQUE
    CHECK (
      provider_video_id IS NULL
      OR length(provider_video_id) BETWEEN 6 AND 64
    ),
  failure_code TEXT
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 160),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'uploaded' AND provider_video_id IS NOT NULL)
    OR (status <> 'uploaded' AND provider_video_id IS NULL)
  ),
  CHECK (
    status NOT IN ('queued', 'uploading', 'uploaded')
    OR channel_id IS NOT NULL
  ),
  CHECK (
    (status = 'failed' AND failure_code IS NOT NULL)
    OR (status <> 'failed' AND failure_code IS NULL)
  )
);

CREATE INDEX clip_youtube_publication_show_status
  ON clip_youtube_publications(show_id, status, updated_at DESC);
