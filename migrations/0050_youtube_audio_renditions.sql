PRAGMA foreign_keys = ON;

ALTER TABLE episodes
  ADD COLUMN youtube_rendition_upload_id TEXT
  REFERENCES media_uploads(id) ON DELETE SET NULL;

CREATE TABLE episode_youtube_audio_renditions (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  working_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE RESTRICT,
  source_object_key TEXT NOT NULL,
  source_object_bytes INTEGER NOT NULL CHECK (source_object_bytes > 0),
  source_object_etag TEXT NOT NULL
    CHECK (length(source_object_etag) BETWEEN 1 AND 256),
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
  source_sha256 TEXT NOT NULL
    CHECK (
      length(source_sha256) = 64
      AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  artwork_url TEXT NOT NULL CHECK (length(artwork_url) BETWEEN 1 AND 2000),
  artwork_object_key TEXT NOT NULL UNIQUE,
  artwork_object_bytes INTEGER NOT NULL CHECK (artwork_object_bytes > 0),
  artwork_object_etag TEXT NOT NULL
    CHECK (length(artwork_object_etag) BETWEEN 1 AND 256),
  artwork_mime_type TEXT NOT NULL
    CHECK (artwork_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  artwork_sha256 TEXT NOT NULL
    CHECK (
      length(artwork_sha256) = 64
      AND artwork_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  output_object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL
    CHECK (length(r2_upload_id) BETWEEN 1 AND 1024),
  output_upload_id TEXT UNIQUE
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'rendering',
        'completing',
        'ready',
        'failed'
      )
    ),
  output_object_bytes INTEGER
    CHECK (
      output_object_bytes IS NULL
      OR output_object_bytes BETWEEN 1 AND 2147483648
    ),
  output_object_etag TEXT
    CHECK (
      output_object_etag IS NULL
      OR length(output_object_etag) BETWEEN 1 AND 256
    ),
  output_sha256 TEXT
    CHECK (
      output_sha256 IS NULL
      OR (
        length(output_sha256) = 64
        AND output_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  output_duration_ms INTEGER
    CHECK (output_duration_ms IS NULL OR output_duration_ms > 0),
  output_width INTEGER
    CHECK (output_width IS NULL OR output_width = 1920),
  output_height INTEGER
    CHECK (output_height IS NULL OR output_height = 1080),
  processor_version TEXT
    CHECK (
      processor_version IS NULL
      OR length(processor_version) BETWEEN 1 AND 240
    ),
  processor_report_json TEXT
    CHECK (
      processor_report_json IS NULL
      OR (
        json_valid(processor_report_json)
        AND length(processor_report_json) <= 100000
      )
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR length(failure_code) BETWEEN 1 AND 160
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (
    episode_id,
    working_master_id,
    source_object_etag,
    artwork_sha256,
    processor_manifest_sha256
  ),
  CHECK (
    (
      status IN ('queued', 'rendering', 'completing')
      AND output_upload_id IS NULL
      AND output_object_bytes IS NULL
      AND output_object_etag IS NULL
      AND output_sha256 IS NULL
      AND output_duration_ms IS NULL
      AND output_width IS NULL
      AND output_height IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'ready'
      AND output_upload_id IS NOT NULL
      AND output_object_bytes IS NOT NULL
      AND output_object_etag IS NOT NULL
      AND output_sha256 IS NOT NULL
      AND output_duration_ms IS NOT NULL
      AND output_width = 1920
      AND output_height = 1080
      AND processor_version IS NOT NULL
      AND processor_report_json IS NOT NULL
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND output_upload_id IS NULL
      AND output_object_bytes IS NULL
      AND output_object_etag IS NULL
      AND output_sha256 IS NULL
      AND output_duration_ms IS NULL
      AND output_width IS NULL
      AND output_height IS NULL
      AND failure_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX episode_youtube_audio_renditions_history
  ON episode_youtube_audio_renditions(
    episode_id,
    requested_at DESC,
    id DESC
  );

CREATE INDEX episode_youtube_audio_renditions_status
  ON episode_youtube_audio_renditions(status, requested_at);

CREATE TABLE episode_youtube_audio_rendition_parts (
  rendition_id TEXT NOT NULL
    REFERENCES episode_youtube_audio_renditions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 256),
  uploaded_bytes INTEGER NOT NULL
    CHECK (uploaded_bytes BETWEEN 1 AND 99614720),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rendition_id, part_number)
);

CREATE TRIGGER episode_youtube_rendition_audio_stale
AFTER UPDATE OF audio_key, audio_bytes, audio_etag, audio_mime_type ON episodes
WHEN NEW.youtube_rendition_upload_id IS NOT NULL
  AND (
    NEW.audio_key IS NOT OLD.audio_key
    OR NEW.audio_bytes IS NOT OLD.audio_bytes
    OR NEW.audio_etag IS NOT OLD.audio_etag
    OR NEW.audio_mime_type IS NOT OLD.audio_mime_type
  )
BEGIN
  UPDATE episodes
  SET
    youtube_rendition_upload_id = NULL,
    publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.id;
END;

CREATE TRIGGER episode_youtube_rendition_master_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE episodes
  SET
    youtube_rendition_upload_id = NULL,
    publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id
    AND youtube_rendition_upload_id IS NOT NULL;
END;

CREATE TRIGGER episode_youtube_rendition_artwork_stale
AFTER UPDATE OF artwork_url ON shows
WHEN NEW.artwork_url IS NOT OLD.artwork_url
BEGIN
  UPDATE episodes
  SET
    youtube_rendition_upload_id = NULL,
    publication_evidence_version = publication_evidence_version + 1
  WHERE show_id = NEW.id
    AND youtube_rendition_upload_id IS NOT NULL;
END;

CREATE TRIGGER episode_youtube_rendition_selected
AFTER UPDATE OF youtube_rendition_upload_id ON episodes
WHEN NEW.youtube_rendition_upload_id IS NOT OLD.youtube_rendition_upload_id
  AND NEW.youtube_rendition_upload_id IS NOT NULL
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.id;
END;
