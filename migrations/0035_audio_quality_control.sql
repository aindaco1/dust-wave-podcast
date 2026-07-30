PRAGMA foreign_keys = ON;

CREATE TABLE show_audio_qc_policies (
  show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  mono_integrated_lufs REAL NOT NULL DEFAULT -19
    CHECK (mono_integrated_lufs BETWEEN -40 AND -5),
  stereo_integrated_lufs REAL NOT NULL DEFAULT -16
    CHECK (stereo_integrated_lufs BETWEEN -40 AND -5),
  integrated_lufs_tolerance REAL NOT NULL DEFAULT 1
    CHECK (integrated_lufs_tolerance BETWEEN 0.1 AND 10),
  maximum_true_peak_dbtp REAL NOT NULL DEFAULT -1
    CHECK (maximum_true_peak_dbtp BETWEEN -12 AND 0),
  maximum_dc_offset REAL NOT NULL DEFAULT 0.01
    CHECK (maximum_dc_offset BETWEEN 0 AND 0.25),
  maximum_channel_imbalance_lu REAL NOT NULL DEFAULT 2
    CHECK (maximum_channel_imbalance_lu BETWEEN 0 AND 24),
  maximum_leading_silence_ms INTEGER NOT NULL DEFAULT 2000
    CHECK (maximum_leading_silence_ms BETWEEN 0 AND 60000),
  maximum_trailing_silence_ms INTEGER NOT NULL DEFAULT 3000
    CHECK (maximum_trailing_silence_ms BETWEEN 0 AND 60000),
  maximum_internal_silence_ms INTEGER NOT NULL DEFAULT 5000
    CHECK (maximum_internal_silence_ms BETWEEN 0 AND 120000),
  silence_threshold_db REAL NOT NULL DEFAULT -50
    CHECK (silence_threshold_db BETWEEN -100 AND -10),
  updated_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO show_audio_qc_policies (show_id)
SELECT id FROM shows;

CREATE TRIGGER show_audio_qc_policy_insert
AFTER INSERT ON shows
BEGIN
  INSERT INTO show_audio_qc_policies (show_id)
  VALUES (NEW.id);
END;

CREATE TABLE audio_qc_runs (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  source_upload_id TEXT NOT NULL
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
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
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  policy_json TEXT NOT NULL
    CHECK (json_valid(policy_json) AND length(policy_json) <= 10000),
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  source_sha256 TEXT
    CHECK (
      source_sha256 IS NULL
      OR (
        length(source_sha256) = 64
        AND source_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  report_json TEXT
    CHECK (
      report_json IS NULL
      OR (json_valid(report_json) AND length(report_json) <= 250000)
    ),
  report_sha256 TEXT
    CHECK (
      report_sha256 IS NULL
      OR (
        length(report_sha256) = 64
        AND report_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  blocker_count INTEGER CHECK (blocker_count IS NULL OR blocker_count >= 0),
  warning_count INTEGER CHECK (warning_count IS NULL OR warning_count >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  integrated_lufs REAL,
  true_peak_dbtp REAL,
  processor_version TEXT
    CHECK (
      processor_version IS NULL
      OR length(processor_version) BETWEEN 1 AND 240
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'processor_failed',
        'source_invalid',
        'measurement_failed',
        'report_invalid'
      )
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  CHECK (
    (
      status IN ('queued', 'running')
      AND source_sha256 IS NULL
      AND report_json IS NULL
      AND report_sha256 IS NULL
      AND blocker_count IS NULL
      AND warning_count IS NULL
      AND duration_ms IS NULL
      AND integrated_lufs IS NULL
      AND true_peak_dbtp IS NULL
      AND processor_version IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'succeeded'
      AND source_sha256 IS NOT NULL
      AND report_json IS NOT NULL
      AND report_sha256 IS NOT NULL
      AND blocker_count IS NOT NULL
      AND warning_count IS NOT NULL
      AND duration_ms IS NOT NULL
      AND integrated_lufs IS NOT NULL
      AND true_peak_dbtp IS NOT NULL
      AND processor_version IS NOT NULL
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND source_sha256 IS NULL
      AND report_json IS NULL
      AND report_sha256 IS NULL
      AND blocker_count IS NULL
      AND warning_count IS NULL
      AND duration_ms IS NULL
      AND integrated_lufs IS NULL
      AND true_peak_dbtp IS NULL
      AND processor_version IS NULL
      AND failure_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX audio_qc_runs_episode
  ON audio_qc_runs(episode_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX audio_qc_runs_one_active_source_policy
  ON audio_qc_runs(
    episode_id,
    source_object_key,
    source_object_etag,
    policy_revision
  )
  WHERE status IN ('queued', 'running', 'succeeded');

CREATE INDEX audio_qc_runs_active_source
  ON audio_qc_runs(
    episode_id,
    source_object_etag,
    policy_revision,
    status,
    created_at DESC
  );
