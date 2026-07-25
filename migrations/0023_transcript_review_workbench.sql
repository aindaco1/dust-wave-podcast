PRAGMA foreign_keys = ON;

ALTER TABLE transcripts
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0);

ALTER TABLE transcripts
  ADD COLUMN content_sha256 TEXT
    CHECK (
      content_sha256 IS NULL
      OR (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE transcripts
  ADD COLUMN speaker_labels_confirmed INTEGER NOT NULL DEFAULT 0
    CHECK (speaker_labels_confirmed IN (0, 1));

ALTER TABLE transcripts
  ADD COLUMN approved_revision INTEGER
    CHECK (approved_revision IS NULL OR approved_revision > 0);

ALTER TABLE transcripts
  ADD COLUMN approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE TABLE transcript_mutations (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision = base_revision + 1),
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transcript_id, base_revision)
);

CREATE TABLE transcript_revisions (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  speaker_labels_confirmed INTEGER NOT NULL
    CHECK (speaker_labels_confirmed IN (0, 1)),
  created_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transcript_id, revision)
);

CREATE TABLE transcript_approvals (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transcript_id, revision)
);

CREATE INDEX transcript_revision_history
  ON transcript_revisions(transcript_id, revision DESC);

CREATE INDEX transcript_episode_review
  ON transcripts(episode_id, status, language);
