PRAGMA foreign_keys = ON;

ALTER TABLE episode_chapters
  ADD COLUMN chapter_key TEXT
    CHECK (
      chapter_key IS NULL
      OR (
        length(chapter_key) BETWEEN 1 AND 128
        AND chapter_key NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    );

ALTER TABLE episode_chapters
  ADD COLUMN toc INTEGER NOT NULL DEFAULT 1
    CHECK (toc IN (0, 1));

CREATE TABLE episode_chapter_sets (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  content_sha256 TEXT
    CHECK (
      content_sha256 IS NULL
      OR (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  approved_revision INTEGER
    CHECK (approved_revision IS NULL OR approved_revision > 0),
  approved_at TEXT,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preserve any chapters authored before the review workflow. They begin as a
-- revision-zero draft and become immutable only after an explicit save/review.
INSERT OR IGNORE INTO episode_chapter_sets (episode_id)
SELECT DISTINCT episode_id
FROM episode_chapters;

CREATE TABLE episode_chapter_mutations (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL
    REFERENCES episode_chapter_sets(episode_id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision = base_revision + 1),
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, base_revision)
);

CREATE TABLE episode_chapter_revisions (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, revision)
);

CREATE TABLE episode_chapter_approvals (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, revision)
);

CREATE INDEX episode_chapter_revision_history
  ON episode_chapter_revisions(episode_id, revision DESC);

CREATE INDEX episode_chapter_review_queue
  ON episode_chapter_sets(status, updated_at DESC);

CREATE UNIQUE INDEX episode_chapter_keys
  ON episode_chapters(episode_id, chapter_key)
  WHERE chapter_key IS NOT NULL;
