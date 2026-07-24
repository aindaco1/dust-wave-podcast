PRAGMA foreign_keys = ON;

CREATE TABLE episode_ad_plans (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'pending_processor'
    CHECK (
      status IN (
        'pending_processor', 'needs_review', 'approved', 'rejected',
        'failed', 'superseded'
      )
    ),
  source_object_key TEXT NOT NULL,
  source_object_bytes INTEGER NOT NULL CHECK (source_object_bytes > 0),
  source_object_etag TEXT NOT NULL,
  source_audio_mime_type TEXT NOT NULL CHECK (source_audio_mime_type = 'audio/mpeg'),
  stream_profile TEXT NOT NULL,
  marker_manifest_json TEXT NOT NULL CHECK (json_valid(marker_manifest_json)),
  segment_manifest_json TEXT
    CHECK (segment_manifest_json IS NULL OR json_valid(segment_manifest_json)),
  processor_report_json TEXT
    CHECK (processor_report_json IS NULL OR json_valid(processor_report_json)),
  processor_manifest_sha256 TEXT
    CHECK (
      processor_manifest_sha256 IS NULL
      OR length(processor_manifest_sha256) = 64
    ),
  processor_version TEXT,
  submitted_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  processor_completed_at TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, revision)
);

CREATE INDEX episode_ad_plans_status
  ON episode_ad_plans(episode_id, status, revision DESC);

ALTER TABLE episode_ad_markers
  ADD COLUMN plan_id TEXT
    REFERENCES episode_ad_plans(id) ON DELETE SET NULL;

ALTER TABLE episode_audio_segments
  ADD COLUMN plan_id TEXT
    REFERENCES episode_ad_plans(id) ON DELETE SET NULL;

ALTER TABLE episode_audio_segments
  ADD COLUMN source_etag TEXT;

ALTER TABLE episode_audio_segments
  ADD COLUMN duration_ms INTEGER
    CHECK (duration_ms IS NULL OR duration_ms > 0);

ALTER TABLE episode_audio_segments
  ADD COLUMN frame_count INTEGER
    CHECK (frame_count IS NULL OR frame_count > 0);
