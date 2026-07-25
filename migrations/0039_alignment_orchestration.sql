PRAGMA foreign_keys = ON;

DROP INDEX transcript_word_alignment_lookup;

ALTER TABLE transcript_words RENAME TO transcript_words_legacy;

CREATE TABLE transcript_words (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  word TEXT NOT NULL CHECK (length(word) BETWEEN 1 AND 500),
  starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= 0),
  ends_at_ms INTEGER CHECK (ends_at_ms IS NULL OR ends_at_ms > 0),
  confidence REAL
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  alignment_revision_id TEXT
    REFERENCES transcript_alignment_revisions(id) ON DELETE CASCADE,
  cue_id TEXT CHECK (cue_id IS NULL OR length(cue_id) BETWEEN 1 AND 128),
  timing_status TEXT NOT NULL DEFAULT 'unaligned'
    CHECK (timing_status IN ('aligned', 'unaligned', 'editor_adjusted')),
  timing_origin TEXT
    CHECK (timing_origin IN (
      'forced_alignment', 'model', 'editor', 'interpolated'
    )),
  unaligned_reason TEXT
    CHECK (
      unaligned_reason IS NULL
      OR length(unaligned_reason) BETWEEN 1 AND 120
    ),
  UNIQUE (alignment_revision_id, position),
  CHECK (
    (
      timing_status IN ('aligned', 'editor_adjusted')
      AND alignment_revision_id IS NOT NULL
      AND cue_id IS NOT NULL
      AND starts_at_ms IS NOT NULL
      AND ends_at_ms > starts_at_ms
      AND timing_origin IN ('forced_alignment', 'model', 'editor')
      AND unaligned_reason IS NULL
    )
    OR (
      timing_status = 'unaligned'
      AND (
        (
          timing_origin = 'interpolated'
          AND starts_at_ms IS NOT NULL
          AND ends_at_ms > starts_at_ms
          AND unaligned_reason IS NULL
        )
        OR (
          timing_origin IS NULL
          AND starts_at_ms IS NULL
          AND ends_at_ms IS NULL
          AND confidence IS NULL
          AND unaligned_reason IS NOT NULL
        )
        OR (
          alignment_revision_id IS NULL
          AND timing_origin IS NULL
          AND starts_at_ms IS NULL
          AND ends_at_ms IS NULL
        )
      )
    )
  )
);

INSERT INTO transcript_words (
  id, transcript_id, position, word, starts_at_ms, ends_at_ms, confidence,
  alignment_revision_id, cue_id, timing_status, timing_origin,
  unaligned_reason
)
SELECT
  id,
  transcript_id,
  position,
  word,
  CASE WHEN timing_status = 'unaligned' THEN NULL ELSE starts_at_ms END,
  CASE WHEN timing_status = 'unaligned' THEN NULL ELSE ends_at_ms END,
  CASE WHEN timing_status = 'unaligned' THEN NULL ELSE confidence END,
  alignment_revision_id,
  cue_id,
  timing_status,
  CASE WHEN timing_status = 'unaligned' THEN NULL ELSE timing_origin END,
  unaligned_reason
FROM transcript_words_legacy;

DROP TABLE transcript_words_legacy;

CREATE INDEX transcript_word_alignment_lookup
  ON transcript_words(alignment_revision_id, cue_id, position);

CREATE INDEX transcript_word_transcript_lookup
  ON transcript_words(transcript_id, alignment_revision_id, position);

CREATE TABLE transcript_alignment_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  alignment_revision_id TEXT NOT NULL UNIQUE
    REFERENCES transcript_alignment_revisions(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  working_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE RESTRICT,
  source_object_key TEXT NOT NULL,
  source_object_bytes INTEGER NOT NULL CHECK (source_object_bytes > 0),
  source_object_etag TEXT NOT NULL
    CHECK (length(source_object_etag) BETWEEN 1 AND 240),
  source_mime_type TEXT NOT NULL
    CHECK (
      source_mime_type IN (
        'audio/mpeg',
        'audio/mp4',
        'audio/wav',
        'audio/x-wav',
        'audio/flac',
        'audio/x-flac'
      )
    ),
  source_duration_ms INTEGER NOT NULL
    CHECK (source_duration_ms BETWEEN 1 AND 86400000),
  source_audio_sha256 TEXT NOT NULL
    CHECK (
      length(source_audio_sha256) = 64
      AND source_audio_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transcript_revision INTEGER NOT NULL CHECK (transcript_revision > 0),
  transcript_content_sha256 TEXT NOT NULL
    CHECK (
      length(transcript_content_sha256) = 64
      AND transcript_content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transcript_projection_json TEXT NOT NULL
    CHECK (
      json_valid(transcript_projection_json)
      AND length(transcript_projection_json) <= 5000000
    ),
  transcript_projection_sha256 TEXT NOT NULL
    CHECK (
      length(transcript_projection_sha256) = 64
      AND transcript_projection_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  language TEXT NOT NULL CHECK (language IN ('en', 'es')),
  adapter TEXT NOT NULL CHECK (adapter IN ('stable-ts', 'whisperx')),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 200),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 200),
  settings_version TEXT NOT NULL
    CHECK (length(settings_version) BETWEEN 1 AND 200),
  runner_revision TEXT NOT NULL
    CHECK (
      length(runner_revision) = 40
      AND runner_revision NOT GLOB '*[^0-9a-f]*'
    ),
  runner_digest TEXT NOT NULL
    CHECK (
      length(runner_digest) = 71
      AND runner_digest GLOB 'sha256:*'
      AND substr(runner_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  processor_manifest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  result_object_key TEXT NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL UNIQUE
    CHECK (
      length(input_fingerprint) = 64
      AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 5),
  result_manifest_sha256 TEXT
    CHECK (
      result_manifest_sha256 IS NULL
      OR (
        length(result_manifest_sha256) = 64
        AND result_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  quality_report_json TEXT
    CHECK (
      quality_report_json IS NULL
      OR (
        json_valid(quality_report_json)
        AND length(quality_report_json) <= 10000
      )
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'processor_failed',
        'source_invalid',
        'transcript_invalid',
        'adapter_failed',
        'result_invalid',
        'storage_failed',
        'working_master_changed',
        'transcript_changed'
      )
    ),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status IN ('queued', 'running')
      AND result_manifest_sha256 IS NULL
      AND quality_report_json IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'ready'
      AND result_manifest_sha256 IS NOT NULL
      AND quality_report_json IS NOT NULL
      AND failure_code IS NULL
      AND last_error IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status IN ('failed', 'stale')
      AND failure_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX transcript_alignment_jobs_episode
  ON transcript_alignment_jobs(episode_id, requested_at DESC);

CREATE INDEX transcript_alignment_jobs_recovery
  ON transcript_alignment_jobs(status, attempt_count, requested_at);

CREATE TABLE transcript_alignment_approvals (
  id TEXT PRIMARY KEY,
  alignment_revision_id TEXT NOT NULL UNIQUE
    REFERENCES transcript_alignment_revisions(id) ON DELETE CASCADE,
  benchmark_run_id TEXT NOT NULL
    REFERENCES alignment_benchmark_runs(id) ON DELETE RESTRICT,
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER transcript_alignment_approval_exact_gate
BEFORE INSERT ON transcript_alignment_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM transcript_alignment_revisions revision
  JOIN transcript_alignment_jobs job
    ON job.alignment_revision_id = revision.id
  JOIN alignment_benchmark_runs benchmark
    ON benchmark.id = NEW.benchmark_run_id
  JOIN transcripts transcript
    ON transcript.id = job.transcript_id
  JOIN episode_working_master_states master_state
    ON master_state.episode_id = job.episode_id
  WHERE revision.id = NEW.alignment_revision_id
    AND revision.status = 'needs_review'
    AND job.status = 'ready'
    AND json_extract(job.quality_report_json, '$.structurallyEligible') = 1
    AND transcript.status = 'approved'
    AND transcript.revision = job.transcript_revision
    AND transcript.content_sha256 = job.transcript_content_sha256
    AND master_state.current_master_id = job.working_master_id
    AND benchmark.status = 'passed'
    AND benchmark.clean_environment_reproduced = 1
    AND benchmark.adapter = job.adapter
    AND benchmark.adapter_version = job.adapter_version
    AND benchmark.model = job.model
    AND benchmark.model_version = job.model_version
    AND benchmark.settings_version = job.settings_version
    AND benchmark.runner_digest = job.runner_digest
)
BEGIN
  SELECT RAISE(
    ABORT,
    'alignment approval requires exact current inputs and a passed benchmark'
  );
END;

CREATE TRIGGER transcript_alignment_pass_requires_approval
BEFORE UPDATE OF status ON transcript_alignment_revisions
WHEN NEW.status = 'passed'
  AND OLD.status IS NOT NEW.status
  AND NOT EXISTS (
    SELECT 1
    FROM transcript_alignment_approvals approval
    WHERE approval.alignment_revision_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'alignment pass requires an exact approval');
END;

CREATE TRIGGER transcript_alignment_revision_job_stale
AFTER UPDATE OF status ON transcript_alignment_revisions
WHEN NEW.status = 'superseded' AND OLD.status IS NOT NEW.status
BEGIN
  UPDATE transcript_alignment_jobs
  SET
    status = 'stale',
    failure_code = 'transcript_changed',
    last_error = 'The reviewed transcript changed.',
    completed_at = datetime('now'),
    updated_at = datetime('now')
  WHERE alignment_revision_id = NEW.id
    AND status IN ('queued', 'running', 'ready');
END;

CREATE TRIGGER transcript_alignment_working_master_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN OLD.current_master_id IS NOT NULL
  AND NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE transcript_alignment_jobs
  SET
    status = 'stale',
    failure_code = 'working_master_changed',
    last_error = 'The approved working master changed.',
    completed_at = datetime('now'),
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id
    AND status IN ('queued', 'running', 'ready');

  UPDATE transcript_alignment_revisions
  SET
    status = 'superseded',
    updated_at = datetime('now')
  WHERE id IN (
    SELECT alignment_revision_id
    FROM transcript_alignment_jobs
    WHERE episode_id = NEW.episode_id
  )
    AND status IN ('processing', 'needs_review', 'passed');
END;
