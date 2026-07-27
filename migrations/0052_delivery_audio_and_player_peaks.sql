CREATE TABLE delivery_audio_jobs (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL
    REFERENCES episodes(id) ON DELETE CASCADE,
  source_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE RESTRICT,
  source_object_key TEXT NOT NULL,
  source_object_bytes INTEGER NOT NULL CHECK (source_object_bytes > 0),
  source_object_etag TEXT NOT NULL,
  source_mime_type TEXT NOT NULL,
  source_sha256 TEXT NOT NULL
    CHECK (
      length(source_sha256) = 64
      AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  source_duration_ms INTEGER NOT NULL CHECK (source_duration_ms > 0),
  stream_profile TEXT NOT NULL
    CHECK (stream_profile = 'mp3-44100-stereo-cbr128-frame-v1'),
  output_object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL,
  peaks_object_key TEXT NOT NULL UNIQUE,
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
        'approved',
        'failed',
        'stale'
      )
    ),
  output_object_bytes INTEGER CHECK (output_object_bytes > 0),
  output_object_etag TEXT,
  output_sha256 TEXT
    CHECK (
      output_sha256 IS NULL
      OR (
        length(output_sha256) = 64
        AND output_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  output_duration_ms INTEGER CHECK (output_duration_ms > 0),
  peaks_object_bytes INTEGER
    CHECK (peaks_object_bytes BETWEEN 1 AND 125000),
  peaks_object_etag TEXT,
  peaks_sha256 TEXT
    CHECK (
      peaks_sha256 IS NULL
      OR (
        length(peaks_sha256) = 64
        AND peaks_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  peaks_length INTEGER CHECK (peaks_length BETWEEN 1 AND 8192),
  processor_version TEXT,
  processor_report_json TEXT
    CHECK (
      processor_report_json IS NULL
      OR (
        json_valid(processor_report_json)
        AND length(processor_report_json) <= 125000
      )
    ),
  processor_report_sha256 TEXT
    CHECK (
      processor_report_sha256 IS NULL
      OR (
        length(processor_report_sha256) = 64
        AND processor_report_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  failure_code TEXT,
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approval_reason TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX delivery_audio_jobs_active
  ON delivery_audio_jobs(
    episode_id,
    source_master_id,
    stream_profile
  )
  WHERE status IN (
    'queued',
    'rendering',
    'completing',
    'ready',
    'approved'
  );

CREATE INDEX delivery_audio_jobs_episode_history
  ON delivery_audio_jobs(episode_id, requested_at DESC, id DESC);

CREATE TABLE delivery_audio_job_parts (
  job_id TEXT NOT NULL
    REFERENCES delivery_audio_jobs(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  uploaded_bytes INTEGER NOT NULL CHECK (uploaded_bytes > 0),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, part_number)
);

CREATE TRIGGER delivery_audio_job_source_insert
BEFORE INSERT ON delivery_audio_jobs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM episodes episode
  JOIN episode_working_master_states state
    ON state.episode_id = episode.id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = episode.id
  JOIN audio_qc_runs qc
    ON qc.id = master.quality_control_run_id
   AND qc.status = 'succeeded'
   AND qc.blocker_count = 0
   AND qc.source_sha256 = master.source_sha256
   AND qc.report_sha256 = master.quality_control_report_sha256
  JOIN show_audio_qc_policies policy
    ON policy.show_id = episode.show_id
   AND policy.revision = qc.policy_revision
  WHERE episode.id = NEW.episode_id
    AND master.id = NEW.source_master_id
    AND master.object_key = NEW.source_object_key
    AND master.object_bytes = NEW.source_object_bytes
    AND master.object_etag = NEW.source_object_etag
    AND master.mime_type = NEW.source_mime_type
    AND master.source_sha256 = NEW.source_sha256
    AND qc.duration_ms = NEW.source_duration_ms
)
BEGIN
  SELECT RAISE(
    ABORT,
    'delivery audio source evidence is invalid'
  );
END;

CREATE TRIGGER delivery_audio_job_ready_evidence
BEFORE UPDATE OF status ON delivery_audio_jobs
FOR EACH ROW
WHEN NEW.status = 'ready'
  AND (
    NEW.output_object_bytes IS NULL
    OR NEW.output_object_etag IS NULL
    OR NEW.output_sha256 IS NULL
    OR NEW.output_duration_ms IS NULL
    OR NEW.peaks_object_bytes IS NULL
    OR NEW.peaks_object_etag IS NULL
    OR NEW.peaks_sha256 IS NULL
    OR NEW.peaks_length IS NULL
    OR NEW.processor_version IS NULL
    OR NEW.processor_report_json IS NULL
    OR NEW.processor_report_sha256 IS NULL
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'delivery audio completion evidence is incomplete'
  );
END;

CREATE TRIGGER delivery_audio_job_approval_evidence
BEFORE UPDATE OF status ON delivery_audio_jobs
FOR EACH ROW
WHEN NEW.status = 'approved'
  AND (
    OLD.status != 'ready'
    OR NEW.approved_by_admin_user_id IS NULL
    OR NEW.approval_reason IS NULL
    OR NEW.approved_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM episode_working_master_states state
      JOIN episodes episode ON episode.id = state.episode_id
      WHERE state.episode_id = NEW.episode_id
        AND state.current_master_id = NEW.source_master_id
        AND episode.audio_key = NEW.output_object_key
        AND episode.audio_bytes = NEW.output_object_bytes
        AND episode.audio_etag = NEW.output_object_etag
        AND episode.audio_mime_type = 'audio/mpeg'
        AND episode.media_status = 'ready'
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'delivery audio approval evidence is invalid'
  );
END;

CREATE TRIGGER delivery_audio_jobs_working_master_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
FOR EACH ROW
WHEN NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE delivery_audio_jobs
  SET
    status = 'stale',
    failure_code = 'working_master_changed',
    completed_at = COALESCE(completed_at, datetime('now')),
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id
    AND status IN ('queued', 'rendering', 'completing', 'ready');
END;

CREATE TRIGGER delivery_audio_jobs_episode_audio_stale
AFTER UPDATE OF
  audio_key,
  audio_bytes,
  audio_etag,
  audio_mime_type
ON episodes
FOR EACH ROW
WHEN
  NEW.audio_key IS NOT OLD.audio_key
  OR NEW.audio_bytes IS NOT OLD.audio_bytes
  OR NEW.audio_etag IS NOT OLD.audio_etag
  OR NEW.audio_mime_type IS NOT OLD.audio_mime_type
BEGIN
  UPDATE delivery_audio_jobs
  SET
    status = 'stale',
    failure_code = 'delivery_audio_replaced',
    updated_at = datetime('now')
  WHERE episode_id = NEW.id
    AND status = 'approved'
    AND (
      output_object_key IS NOT NEW.audio_key
      OR output_object_bytes IS NOT NEW.audio_bytes
      OR output_object_etag IS NOT NEW.audio_etag
    );
END;

CREATE TRIGGER delivery_audio_manual_upload_guard
BEFORE INSERT ON media_uploads
FOR EACH ROW
WHEN NEW.kind = 'delivery_audio'
  AND EXISTS (
    SELECT 1
    FROM episode_working_master_states state
    WHERE state.episode_id = NEW.episode_id
      AND state.current_master_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'delivery audio must be rendered from the current working master'
  );
END;
