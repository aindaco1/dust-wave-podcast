PRAGMA foreign_keys = ON;

CREATE TABLE transcript_alignment_revisions (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  source_audio_sha256 TEXT NOT NULL,
  transcript_revision_sha256 TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'es')),
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  settings_version TEXT NOT NULL,
  runner_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN (
      'processing', 'needs_review', 'passed', 'failed', 'superseded'
    )),
  result_manifest_key TEXT,
  quality_report_json TEXT NOT NULL DEFAULT '{}',
  input_fingerprint TEXT NOT NULL UNIQUE,
  completed_at TEXT,
  approved_at TEXT,
  approved_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX transcript_alignment_revision_lookup
  ON transcript_alignment_revisions(transcript_id, status, created_at DESC);

ALTER TABLE transcript_words
  ADD COLUMN alignment_revision_id TEXT
    REFERENCES transcript_alignment_revisions(id) ON DELETE SET NULL;

ALTER TABLE transcript_words
  ADD COLUMN cue_id TEXT;

ALTER TABLE transcript_words
  ADD COLUMN timing_status TEXT NOT NULL DEFAULT 'unaligned'
    CHECK (timing_status IN ('aligned', 'unaligned', 'editor_adjusted'));

ALTER TABLE transcript_words
  ADD COLUMN timing_origin TEXT
    CHECK (timing_origin IN (
      'forced_alignment', 'model', 'editor', 'interpolated'
    ));

ALTER TABLE transcript_words
  ADD COLUMN unaligned_reason TEXT;

CREATE INDEX transcript_word_alignment_lookup
  ON transcript_words(alignment_revision_id, cue_id, position);

CREATE TABLE alignment_benchmark_runs (
  id TEXT PRIMARY KEY,
  corpus_version TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  settings_version TEXT NOT NULL,
  runner_digest TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'passed', 'failed')),
  report_json TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  clean_environment_reproduced INTEGER NOT NULL DEFAULT 0
    CHECK (clean_environment_reproduced IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX alignment_benchmark_adapter_history
  ON alignment_benchmark_runs(
    adapter, adapter_version, model_version, created_at DESC
  );
