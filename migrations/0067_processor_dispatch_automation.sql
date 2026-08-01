PRAGMA foreign_keys = ON;

-- Normalize the existing processor-specific tables without moving their
-- business state into a second workflow model. The dispatcher stores only the
-- durable target identity, exact manifest digest, lease, and GitHub run ID.
CREATE VIEW processor_dispatch_sources AS
SELECT
  'audio_qc' AS processor_type,
  id AS target_id,
  processor_manifest_sha256,
  status AS source_status,
  CASE status
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'running'
    WHEN 'succeeded' THEN 'succeeded'
    ELSE 'failed'
  END AS lifecycle_status,
  created_at AS source_requested_at
FROM audio_qc_runs
UNION ALL
SELECT
  'audio_enhancement_preview',
  id,
  processor_manifest_sha256,
  status,
  CASE status
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'running'
    WHEN 'ready' THEN 'succeeded'
    ELSE 'failed'
  END,
  requested_at
FROM audio_enhancement_previews
UNION ALL
SELECT
  'audio_enhancement_derivative',
  id,
  processor_manifest_sha256,
  status,
  CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status IN ('rendering', 'completing') THEN 'running'
    WHEN status IN ('ready', 'approved') THEN 'succeeded'
    WHEN status = 'stale' THEN 'canceled'
    ELSE 'failed'
  END,
  requested_at
FROM audio_enhancement_derivatives
UNION ALL
SELECT
  'delivery_audio',
  id,
  processor_manifest_sha256,
  status,
  CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status IN ('rendering', 'completing') THEN 'running'
    WHEN status IN ('ready', 'approved') THEN 'succeeded'
    WHEN status = 'stale' THEN 'canceled'
    ELSE 'failed'
  END,
  requested_at
FROM delivery_audio_jobs
UNION ALL
SELECT
  'transcription_chunks',
  id,
  processor_manifest_sha256,
  status,
  CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status = 'running' THEN 'running'
    WHEN status = 'ready' THEN 'succeeded'
    WHEN status = 'stale' THEN 'canceled'
    ELSE 'failed'
  END,
  created_at
FROM transcription_chunk_runs
UNION ALL
SELECT
  'alignment',
  id,
  processor_manifest_sha256,
  status,
  CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status = 'running' THEN 'running'
    WHEN status = 'ready' THEN 'succeeded'
    WHEN status = 'stale' THEN 'canceled'
    ELSE 'failed'
  END,
  requested_at
FROM transcript_alignment_jobs
UNION ALL
SELECT
  'clip_render',
  id,
  processor_manifest_sha256,
  status,
  CASE status
    WHEN 'queued' THEN 'pending'
    WHEN 'rendering' THEN 'running'
    WHEN 'ready' THEN 'succeeded'
    ELSE 'failed'
  END,
  requested_at
FROM clip_renders
UNION ALL
SELECT
  'youtube_audio_rendition',
  id,
  processor_manifest_sha256,
  status,
  CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status IN ('rendering', 'completing') THEN 'running'
    WHEN status = 'ready' THEN 'succeeded'
    ELSE 'failed'
  END,
  requested_at
FROM episode_youtube_audio_renditions;

CREATE TABLE processor_dispatches (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 240),
  processor_type TEXT NOT NULL
    CHECK (
      processor_type IN (
        'audio_qc',
        'audio_enhancement_preview',
        'audio_enhancement_derivative',
        'delivery_audio',
        'transcription_chunks',
        'alignment',
        'clip_render',
        'youtube_audio_rendition'
      )
    ),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 160),
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued', 'leased', 'dispatched', 'running',
        'succeeded', 'failed', 'canceled'
      )
    ),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 20 AND 100),
  lease_expires_at TEXT,
  github_run_id TEXT
    CHECK (
      github_run_id IS NULL
      OR (
        length(github_run_id) BETWEEN 1 AND 30
        AND github_run_id NOT GLOB '*[^0-9]*'
      )
    ),
  failure_code TEXT
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 120),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  source_requested_at TEXT NOT NULL,
  leased_at TEXT,
  dispatched_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (processor_type, target_id),
  CHECK (
    (status = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status != 'leased'
  )
);

CREATE INDEX processor_dispatches_due
  ON processor_dispatches(status, next_attempt_at, source_requested_at);

CREATE INDEX processor_dispatches_lease
  ON processor_dispatches(status, lease_expires_at);

CREATE INDEX processor_dispatches_github_run
  ON processor_dispatches(github_run_id)
  WHERE github_run_id IS NOT NULL;
