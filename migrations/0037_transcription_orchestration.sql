PRAGMA foreign_keys = ON;

ALTER TABLE episodes
  ADD COLUMN source_language TEXT
    CHECK (source_language IS NULL OR source_language IN ('en', 'es'));

UPDATE episodes
SET source_language = (
  SELECT CASE
    WHEN lower(shows.language) = 'en' THEN 'en'
    ELSE 'es'
  END
  FROM shows
  WHERE shows.id = episodes.show_id
)
WHERE source_language IS NULL;

CREATE TABLE show_transcription_settings (
  show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  model TEXT NOT NULL DEFAULT '@cf/openai/whisper-large-v3-turbo'
    CHECK (model = '@cf/openai/whisper-large-v3-turbo'),
  settings_version TEXT NOT NULL DEFAULT 'whisper-source-v1'
    CHECK (length(settings_version) BETWEEN 1 AND 120),
  vocabulary_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(vocabulary_json)
      AND json_type(vocabulary_json) = 'array'
      AND length(vocabulary_json) <= 10000
    ),
  updated_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO show_transcription_settings (show_id)
SELECT id FROM shows;

CREATE TRIGGER show_transcription_settings_insert
AFTER INSERT ON shows
BEGIN
  INSERT INTO show_transcription_settings (show_id)
  VALUES (NEW.id);
END;

CREATE TABLE transcription_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  working_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE RESTRICT,
  working_master_sha256 TEXT NOT NULL
    CHECK (
      length(working_master_sha256) = 64
      AND working_master_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
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
  language TEXT NOT NULL CHECK (language IN ('en', 'es')),
  adapter TEXT NOT NULL DEFAULT 'workers_ai'
    CHECK (adapter = 'workers_ai'),
  model TEXT NOT NULL
    CHECK (model = '@cf/openai/whisper-large-v3-turbo'),
  settings_revision INTEGER NOT NULL CHECK (settings_revision > 0),
  settings_version TEXT NOT NULL
    CHECK (length(settings_version) BETWEEN 1 AND 120),
  settings_json TEXT NOT NULL
    CHECK (json_valid(settings_json) AND length(settings_json) <= 20000),
  input_fingerprint TEXT NOT NULL UNIQUE
    CHECK (
      length(input_fingerprint) = 64
      AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  base_transcript_revision INTEGER NOT NULL DEFAULT 0
    CHECK (base_transcript_revision >= 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  raw_response_object_key TEXT NOT NULL UNIQUE,
  normalized_object_key TEXT NOT NULL UNIQUE,
  webvtt_object_key TEXT NOT NULL UNIQUE,
  srt_object_key TEXT NOT NULL UNIQUE,
  plain_text_object_key TEXT NOT NULL UNIQUE,
  raw_response_sha256 TEXT
    CHECK (
      raw_response_sha256 IS NULL
      OR (
        length(raw_response_sha256) = 64
        AND raw_response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  normalized_sha256 TEXT
    CHECK (
      normalized_sha256 IS NULL
      OR (
        length(normalized_sha256) = 64
        AND normalized_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  transcript_revision INTEGER
    CHECK (transcript_revision IS NULL OR transcript_revision > 0),
  transcript_sha256 TEXT
    CHECK (
      transcript_sha256 IS NULL
      OR (
        length(transcript_sha256) = 64
        AND transcript_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  provider_request_id TEXT
    CHECK (
      provider_request_id IS NULL
      OR length(provider_request_id) BETWEEN 1 AND 240
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'working_master_changed',
        'source_missing',
        'source_changed',
        'source_requires_chunking',
        'provider_failed',
        'provider_response_invalid',
        'storage_failed',
        'transcript_changed'
      )
    ),
  last_error TEXT
    CHECK (last_error IS NULL OR length(last_error) <= 500),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status IN ('queued', 'running')
      AND raw_response_sha256 IS NULL
      AND normalized_sha256 IS NULL
      AND transcript_id IS NULL
      AND transcript_revision IS NULL
      AND transcript_sha256 IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'succeeded'
      AND raw_response_sha256 IS NOT NULL
      AND normalized_sha256 IS NOT NULL
      AND transcript_id IS NOT NULL
      AND transcript_revision IS NOT NULL
      AND transcript_sha256 IS NOT NULL
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

CREATE INDEX transcription_jobs_episode
  ON transcription_jobs(episode_id, requested_at DESC, id DESC);

CREATE INDEX transcription_jobs_recovery
  ON transcription_jobs(status, requested_at)
  WHERE status IN ('queued', 'running', 'failed');

CREATE TRIGGER working_master_transcription_jobs_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN OLD.current_master_id IS NOT NULL
  AND NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE transcription_jobs
  SET
    status = 'stale',
    failure_code = 'working_master_changed',
    last_error = 'The approved working master changed.',
    completed_at = datetime('now'),
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id
    AND status IN ('queued', 'running');
END;
