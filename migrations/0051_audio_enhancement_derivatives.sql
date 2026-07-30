PRAGMA foreign_keys = ON;

CREATE TABLE audio_enhancement_derivatives (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  selected_preview_id TEXT NOT NULL
    REFERENCES audio_enhancement_previews(id) ON DELETE RESTRICT,
  source_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE RESTRICT,
  source_upload_id TEXT NOT NULL
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
  source_quality_control_run_id TEXT NOT NULL
    REFERENCES audio_qc_runs(id) ON DELETE RESTRICT,
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
  source_quality_control_report_sha256 TEXT NOT NULL
    CHECK (
      length(source_quality_control_report_sha256) = 64
      AND source_quality_control_report_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  selected_preview_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(selected_preview_manifest_sha256) = 64
      AND selected_preview_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  selected_preview_report_sha256 TEXT NOT NULL
    CHECK (
      length(selected_preview_report_sha256) = 64
      AND selected_preview_report_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  selected_preview_enhanced_sha256 TEXT NOT NULL
    CHECK (
      length(selected_preview_enhanced_sha256) = 64
      AND selected_preview_enhanced_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recipe_json TEXT NOT NULL
    CHECK (json_valid(recipe_json) AND length(recipe_json) <= 10000),
  recipe_sha256 TEXT NOT NULL
    CHECK (
      length(recipe_sha256) = 64
      AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  output_object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL
    CHECK (length(r2_upload_id) BETWEEN 1 AND 1024),
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
        'quality_control_failed',
        'approved',
        'failed',
        'stale'
      )
    ),
  output_upload_id TEXT UNIQUE
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
  derivative_quality_control_run_id TEXT UNIQUE
    REFERENCES audio_qc_runs(id) ON DELETE RESTRICT,
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
  processor_report_sha256 TEXT
    CHECK (
      processor_report_sha256 IS NULL
      OR (
        length(processor_report_sha256) = 64
        AND processor_report_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'processor_failed',
        'source_invalid',
        'render_failed',
        'output_invalid',
        'multipart_unavailable'
      )
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approval_reason TEXT
    CHECK (
      approval_reason IS NULL
      OR length(approval_reason) BETWEEN 1 AND 500
    ),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (
    episode_id,
    selected_preview_id,
    source_master_id,
    recipe_sha256
  ),
  CHECK (
    (
      status IN ('queued', 'rendering', 'completing')
      AND output_upload_id IS NULL
      AND derivative_quality_control_run_id IS NULL
      AND output_object_bytes IS NULL
      AND output_object_etag IS NULL
      AND output_sha256 IS NULL
      AND output_duration_ms IS NULL
      AND processor_version IS NULL
      AND processor_report_json IS NULL
      AND processor_report_sha256 IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
      AND approved_by_admin_user_id IS NULL
      AND approval_reason IS NULL
      AND approved_at IS NULL
    )
    OR (
      status IN ('ready', 'quality_control_failed', 'approved')
      AND output_upload_id IS NOT NULL
      AND derivative_quality_control_run_id IS NOT NULL
      AND output_object_bytes IS NOT NULL
      AND output_object_etag IS NOT NULL
      AND output_sha256 IS NOT NULL
      AND output_duration_ms IS NOT NULL
      AND processor_version IS NOT NULL
      AND processor_report_json IS NOT NULL
      AND processor_report_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
      AND (
        (
          status = 'ready'
          AND approved_by_admin_user_id IS NULL
          AND approval_reason IS NULL
          AND approved_at IS NULL
        )
        OR (
          status = 'quality_control_failed'
          AND approved_by_admin_user_id IS NULL
          AND approval_reason IS NULL
          AND approved_at IS NULL
        )
        OR (
          status = 'approved'
          AND approval_reason IS NOT NULL
          AND approved_at IS NOT NULL
        )
      )
    )
    OR (
      status = 'failed'
      AND output_upload_id IS NULL
      AND derivative_quality_control_run_id IS NULL
      AND output_object_bytes IS NULL
      AND output_object_etag IS NULL
      AND output_sha256 IS NULL
      AND output_duration_ms IS NULL
      AND processor_version IS NULL
      AND processor_report_json IS NULL
      AND processor_report_sha256 IS NULL
      AND failure_code IS NOT NULL
      AND completed_at IS NOT NULL
      AND approved_by_admin_user_id IS NULL
      AND approval_reason IS NULL
      AND approved_at IS NULL
    )
    OR status = 'stale'
  )
);

CREATE INDEX audio_enhancement_derivatives_episode
  ON audio_enhancement_derivatives(
    episode_id,
    requested_at DESC,
    id DESC
  );

CREATE INDEX audio_enhancement_derivatives_status
  ON audio_enhancement_derivatives(status, requested_at);

CREATE UNIQUE INDEX audio_enhancement_derivatives_one_active_selection
  ON audio_enhancement_derivatives(
    episode_id,
    selected_preview_id,
    source_master_id
  )
  WHERE status IN ('queued', 'rendering', 'completing', 'ready');

CREATE TABLE audio_enhancement_derivative_parts (
  derivative_id TEXT NOT NULL
    REFERENCES audio_enhancement_derivatives(id) ON DELETE CASCADE,
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
  PRIMARY KEY (derivative_id, part_number)
);

CREATE TRIGGER audio_enhancement_derivative_source_insert
BEFORE INSERT ON audio_enhancement_derivatives
WHEN NOT EXISTS (
  SELECT 1
  FROM audio_enhancement_previews preview
  JOIN episode_working_master_states state
    ON state.episode_id = NEW.episode_id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.id = NEW.source_master_id
   AND master.episode_id = NEW.episode_id
  WHERE preview.id = NEW.selected_preview_id
    AND preview.episode_id = NEW.episode_id
    AND preview.status = 'ready'
    AND preview.source_upload_id = NEW.source_upload_id
    AND preview.quality_control_run_id = NEW.source_quality_control_run_id
    AND preview.source_object_key = NEW.source_object_key
    AND preview.source_object_bytes = NEW.source_object_bytes
    AND preview.source_object_etag = NEW.source_object_etag
    AND preview.source_mime_type = NEW.source_mime_type
    AND preview.source_sha256 = NEW.source_sha256
    AND preview.quality_control_report_sha256 =
      NEW.source_quality_control_report_sha256
    AND preview.processor_manifest_sha256 =
      NEW.selected_preview_manifest_sha256
    AND preview.processor_report_sha256 =
      NEW.selected_preview_report_sha256
    AND preview.enhanced_sha256 =
      NEW.selected_preview_enhanced_sha256
    AND master.source_upload_id = NEW.source_upload_id
    AND master.quality_control_run_id =
      NEW.source_quality_control_run_id
    AND master.object_key = NEW.source_object_key
    AND master.object_bytes = NEW.source_object_bytes
    AND master.object_etag = NEW.source_object_etag
    AND master.mime_type = NEW.source_mime_type
    AND master.source_sha256 = NEW.source_sha256
    AND master.quality_control_report_sha256 =
      NEW.source_quality_control_report_sha256
)
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative source evidence is invalid'
  );
END;

CREATE TRIGGER audio_enhancement_derivative_qc_update
BEFORE UPDATE OF derivative_quality_control_run_id
  ON audio_enhancement_derivatives
WHEN NEW.derivative_quality_control_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM audio_qc_runs qc
    WHERE qc.id = NEW.derivative_quality_control_run_id
      AND qc.episode_id = NEW.episode_id
      AND qc.source_upload_id = NEW.output_upload_id
      AND qc.source_object_key = NEW.output_object_key
      AND qc.source_object_bytes = NEW.output_object_bytes
      AND qc.source_object_etag = NEW.output_object_etag
      AND qc.source_mime_type = 'audio/mpeg'
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative QC evidence is invalid'
  );
END;

CREATE TRIGGER audio_enhancement_derivative_approval
BEFORE UPDATE OF status ON audio_enhancement_derivatives
WHEN NEW.status = 'approved'
  AND OLD.status IS NOT 'approved'
  AND NOT EXISTS (
    SELECT 1
    FROM audio_qc_runs qc
    JOIN show_audio_qc_policies policy
      ON policy.show_id = (
        SELECT show_id FROM episodes WHERE id = NEW.episode_id
      )
    JOIN episode_working_master_states state
      ON state.episode_id = NEW.episode_id
    WHERE qc.id = NEW.derivative_quality_control_run_id
      AND qc.status = 'succeeded'
      AND qc.blocker_count = 0
      AND qc.policy_revision = policy.revision
      AND qc.source_sha256 = NEW.output_sha256
      AND state.current_master_id = NEW.source_master_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative approval evidence is invalid'
  );
END;

CREATE TRIGGER audio_enhancement_derivative_qc_failed
AFTER UPDATE OF status ON audio_qc_runs
WHEN NEW.status = 'failed' AND OLD.status IS NOT 'failed'
BEGIN
  UPDATE audio_enhancement_derivatives
  SET
    status = 'quality_control_failed',
    updated_at = datetime('now')
  WHERE derivative_quality_control_run_id = NEW.id
    AND status = 'ready';
END;

CREATE TRIGGER audio_enhancement_derivative_master_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE audio_enhancement_derivatives
  SET status = 'stale', updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id
    AND source_master_id IS NOT NEW.current_master_id
    AND status IN ('queued', 'rendering', 'completing', 'ready');
END;
