PRAGMA foreign_keys = ON;

ALTER TABLE clips
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0);

ALTER TABLE clips
  ADD COLUMN transcript_id TEXT
    REFERENCES transcripts(id) ON DELETE SET NULL;

ALTER TABLE clips
  ADD COLUMN transcript_revision INTEGER
    CHECK (transcript_revision IS NULL OR transcript_revision > 0);

ALTER TABLE clips
  ADD COLUMN transcript_sha256 TEXT
    CHECK (
      transcript_sha256 IS NULL
      OR (
        length(transcript_sha256) = 64
        AND transcript_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE clips
  ADD COLUMN alignment_revision_id TEXT
    REFERENCES transcript_alignment_revisions(id) ON DELETE SET NULL;

ALTER TABLE clips
  ADD COLUMN boundary_mode TEXT
    CHECK (boundary_mode IS NULL OR boundary_mode IN ('segment', 'word'));

ALTER TABLE clips
  ADD COLUMN caption_language TEXT
    CHECK (caption_language IS NULL OR caption_language IN ('en', 'es'));

ALTER TABLE clips
  ADD COLUMN template_id TEXT;

ALTER TABLE clips
  ADD COLUMN recipe_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(recipe_json));

ALTER TABLE clips
  ADD COLUMN recipe_sha256 TEXT
    CHECK (
      recipe_sha256 IS NULL
      OR (
        length(recipe_sha256) = 64
        AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE clips
  ADD COLUMN source_object_key TEXT;

ALTER TABLE clips
  ADD COLUMN source_object_bytes INTEGER
    CHECK (source_object_bytes IS NULL OR source_object_bytes > 0);

ALTER TABLE clips
  ADD COLUMN source_object_etag TEXT;

ALTER TABLE clips
  ADD COLUMN created_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE TABLE clip_mutations (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision = base_revision + 1),
  recipe_sha256 TEXT NOT NULL
    CHECK (
      length(recipe_sha256) = 64
      AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clip_id, base_revision)
);

CREATE TABLE clip_revisions (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  recipe_json TEXT NOT NULL CHECK (json_valid(recipe_json)),
  recipe_sha256 TEXT NOT NULL
    CHECK (
      length(recipe_sha256) = 64
      AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE RESTRICT,
  transcript_revision INTEGER NOT NULL CHECK (transcript_revision > 0),
  transcript_sha256 TEXT NOT NULL
    CHECK (
      length(transcript_sha256) = 64
      AND transcript_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  alignment_revision_id TEXT
    REFERENCES transcript_alignment_revisions(id) ON DELETE SET NULL,
  source_object_key TEXT NOT NULL,
  source_object_bytes INTEGER NOT NULL CHECK (source_object_bytes > 0),
  source_object_etag TEXT NOT NULL,
  created_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clip_id, revision)
);

CREATE TABLE clip_renders (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  clip_revision INTEGER NOT NULL CHECK (clip_revision > 0),
  recipe_sha256 TEXT NOT NULL
    CHECK (
      length(recipe_sha256) = 64
      AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  output_object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  output_object_bytes INTEGER
    CHECK (output_object_bytes IS NULL OR output_object_bytes > 0),
  output_sha256 TEXT
    CHECK (
      output_sha256 IS NULL
      OR (
        length(output_sha256) = 64
        AND output_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  output_mime_type TEXT,
  output_width INTEGER CHECK (output_width IS NULL OR output_width > 0),
  output_height INTEGER CHECK (output_height IS NULL OR output_height > 0),
  output_duration_ms INTEGER
    CHECK (output_duration_ms IS NULL OR output_duration_ms > 0),
  processor_version TEXT,
  failure_code TEXT,
  processor_report_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(processor_report_json)),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clip_id, clip_revision)
);

CREATE INDEX clip_episode_updated
  ON clips(episode_id, updated_at DESC);

CREATE INDEX clip_revision_history
  ON clip_revisions(clip_id, revision DESC);

CREATE INDEX clip_render_status
  ON clip_renders(status, requested_at);
