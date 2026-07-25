PRAGMA foreign_keys = ON;

CREATE TABLE transcription_chunk_runs (
  id TEXT PRIMARY KEY,
  transcription_job_id TEXT NOT NULL UNIQUE
    REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  processor_manifest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  policy_json TEXT NOT NULL
    CHECK (json_valid(policy_json) AND length(policy_json) <= 10000),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 5),
  plan_json TEXT
    CHECK (
      plan_json IS NULL
      OR (json_valid(plan_json) AND length(plan_json) <= 500000)
    ),
  plan_sha256 TEXT
    CHECK (
      plan_sha256 IS NULL
      OR (
        length(plan_sha256) = 64
        AND plan_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  report_sha256 TEXT
    CHECK (
      report_sha256 IS NULL
      OR (
        length(report_sha256) = 64
        AND report_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  processor_version TEXT
    CHECK (
      processor_version IS NULL
      OR length(processor_version) BETWEEN 1 AND 120
    ),
  chunk_count INTEGER
    CHECK (chunk_count IS NULL OR chunk_count BETWEEN 1 AND 256),
  total_output_bytes INTEGER
    CHECK (total_output_bytes IS NULL OR total_output_bytes > 0),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'processor_failed',
        'source_invalid',
        'plan_invalid',
        'chunk_invalid',
        'upload_failed'
      )
    ),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status IN ('queued', 'running')
      AND plan_json IS NULL
      AND plan_sha256 IS NULL
      AND report_sha256 IS NULL
      AND processor_version IS NULL
      AND chunk_count IS NULL
      AND total_output_bytes IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'ready'
      AND plan_json IS NOT NULL
      AND plan_sha256 IS NOT NULL
      AND report_sha256 IS NOT NULL
      AND processor_version IS NOT NULL
      AND chunk_count IS NOT NULL
      AND total_output_bytes IS NOT NULL
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

CREATE TABLE transcription_chunks (
  run_id TEXT NOT NULL
    REFERENCES transcription_chunk_runs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 255),
  core_starts_at_ms INTEGER NOT NULL CHECK (core_starts_at_ms >= 0),
  core_ends_at_ms INTEGER NOT NULL CHECK (core_ends_at_ms > core_starts_at_ms),
  media_starts_at_ms INTEGER NOT NULL CHECK (media_starts_at_ms >= 0),
  media_ends_at_ms INTEGER NOT NULL
    CHECK (media_ends_at_ms > media_starts_at_ms),
  encoded_duration_ms INTEGER NOT NULL
    CHECK (encoded_duration_ms BETWEEN 1 AND 1802000),
  boundary_kind TEXT NOT NULL
    CHECK (boundary_kind IN ('silence', 'duration', 'end')),
  object_key TEXT NOT NULL UNIQUE,
  object_bytes INTEGER NOT NULL
    CHECK (object_bytes BETWEEN 1 AND 16777216),
  object_etag TEXT NOT NULL CHECK (length(object_etag) BETWEEN 1 AND 240),
  mime_type TEXT NOT NULL CHECK (mime_type = 'audio/mpeg'),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      provider_status IN ('pending', 'running', 'succeeded', 'failed')
    ),
  provider_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (provider_attempt_count BETWEEN 0 AND 5),
  provider_raw_object_key TEXT NOT NULL UNIQUE,
  provider_raw_sha256 TEXT
    CHECK (
      provider_raw_sha256 IS NULL
      OR (
        length(provider_raw_sha256) = 64
        AND provider_raw_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  provider_request_id TEXT
    CHECK (
      provider_request_id IS NULL
      OR length(provider_request_id) BETWEEN 1 AND 240
    ),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, chunk_index),
  CHECK (
    media_starts_at_ms <= core_starts_at_ms
    AND media_ends_at_ms >= core_ends_at_ms
    AND abs(
      encoded_duration_ms - (media_ends_at_ms - media_starts_at_ms)
    ) <= 2000
  ),
  CHECK (
    (
      provider_status IN ('pending', 'running', 'failed')
      AND provider_raw_sha256 IS NULL
      AND provider_request_id IS NULL
    )
    OR (
      provider_status = 'succeeded'
      AND provider_raw_sha256 IS NOT NULL
      AND last_error IS NULL
    )
  )
);

CREATE INDEX transcription_chunk_runs_status
  ON transcription_chunk_runs(status, created_at);

CREATE INDEX transcription_chunks_provider
  ON transcription_chunks(run_id, provider_status, chunk_index);

CREATE TRIGGER transcription_job_chunk_runs_stale
AFTER UPDATE OF status ON transcription_jobs
WHEN NEW.status = 'stale' AND OLD.status IS NOT NEW.status
BEGIN
  UPDATE transcription_chunk_runs
  SET
    status = 'stale',
    failure_code = 'source_invalid',
    last_error = 'The approved working master changed.',
    completed_at = datetime('now'),
    updated_at = datetime('now')
  WHERE transcription_job_id = NEW.id
    AND status IN ('queued', 'running', 'ready');
END;
