PRAGMA foreign_keys = ON;

CREATE TABLE episode_working_master_states (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_master_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO episode_working_master_states (episode_id)
SELECT id FROM episodes;

CREATE TRIGGER episode_working_master_state_insert
AFTER INSERT ON episodes
BEGIN
  INSERT INTO episode_working_master_states (episode_id)
  VALUES (NEW.id);
END;

CREATE TABLE episode_working_masters (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  origin_kind TEXT NOT NULL
    CHECK (origin_kind IN ('source_original', 'enhanced_derivative')),
  source_upload_id TEXT NOT NULL
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
  quality_control_run_id TEXT NOT NULL
    REFERENCES audio_qc_runs(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0),
  object_etag TEXT NOT NULL CHECK (length(object_etag) BETWEEN 1 AND 240),
  mime_type TEXT NOT NULL
    CHECK (
      mime_type IN (
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
  quality_control_report_sha256 TEXT NOT NULL
    CHECK (
      length(quality_control_report_sha256) = 64
      AND quality_control_report_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approval_reason TEXT NOT NULL
    CHECK (length(approval_reason) BETWEEN 1 AND 500),
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, revision),
  UNIQUE (episode_id, quality_control_run_id)
);

CREATE INDEX episode_working_masters_history
  ON episode_working_masters(episode_id, revision DESC);

CREATE TRIGGER episode_working_master_state_reference_insert
BEFORE INSERT ON episode_working_master_states
WHEN NEW.current_master_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'working master state cannot start with a master');
END;

CREATE TRIGGER episode_working_master_state_reference_update
BEFORE UPDATE OF current_master_id ON episode_working_master_states
WHEN NEW.current_master_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM episode_working_masters master
    WHERE master.id = NEW.current_master_id
      AND master.episode_id = NEW.episode_id
      AND master.revision = NEW.revision
  )
BEGIN
  SELECT RAISE(ABORT, 'working master state reference is invalid');
END;

CREATE TRIGGER episode_working_master_evidence_update
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

-- A replacement master preserves authored material and immutable approval
-- history, but makes every derived approval explicitly stale.
CREATE TRIGGER episode_working_master_derivatives_stale
AFTER UPDATE OF current_master_id ON episode_working_master_states
WHEN OLD.current_master_id IS NOT NULL
  AND NEW.current_master_id IS NOT OLD.current_master_id
BEGIN
  UPDATE transcripts
  SET
    status = CASE
      WHEN status = 'failed' THEN status
      ELSE 'needs_review'
    END,
    approved_revision = NULL,
    approved_at = NULL,
    approved_by_admin_user_id = NULL,
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id;

  UPDATE episode_chapter_sets
  SET
    status = 'needs_review',
    approved_revision = NULL,
    approved_at = NULL,
    approved_by_admin_user_id = NULL,
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id;

  UPDATE clips
  SET
    status = 'draft',
    updated_at = datetime('now')
  WHERE episode_id = NEW.episode_id;
END;

CREATE TABLE audio_enhancement_previews (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  source_upload_id TEXT NOT NULL
    REFERENCES media_uploads(id) ON DELETE RESTRICT,
  quality_control_run_id TEXT NOT NULL
    REFERENCES audio_qc_runs(id) ON DELETE RESTRICT,
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
  source_sha256 TEXT NOT NULL
    CHECK (
      length(source_sha256) = 64
      AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  quality_control_report_sha256 TEXT NOT NULL
    CHECK (
      length(quality_control_report_sha256) = 64
      AND quality_control_report_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recipe_json TEXT NOT NULL
    CHECK (json_valid(recipe_json) AND length(recipe_json) <= 10000),
  recipe_sha256 TEXT NOT NULL
    CHECK (
      length(recipe_sha256) = 64
      AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  processor_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(processor_manifest_sha256) = 64
      AND processor_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  original_object_key TEXT NOT NULL UNIQUE,
  enhanced_object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  original_object_bytes INTEGER
    CHECK (original_object_bytes IS NULL OR original_object_bytes > 0),
  original_sha256 TEXT
    CHECK (
      original_sha256 IS NULL
      OR (
        length(original_sha256) = 64
        AND original_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  original_duration_ms INTEGER
    CHECK (original_duration_ms IS NULL OR original_duration_ms > 0),
  enhanced_object_bytes INTEGER
    CHECK (enhanced_object_bytes IS NULL OR enhanced_object_bytes > 0),
  enhanced_sha256 TEXT
    CHECK (
      enhanced_sha256 IS NULL
      OR (
        length(enhanced_sha256) = 64
        AND enhanced_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  enhanced_duration_ms INTEGER
    CHECK (enhanced_duration_ms IS NULL OR enhanced_duration_ms > 0),
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
        'output_invalid'
      )
    ),
  requested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status IN ('queued', 'running')
      AND original_object_bytes IS NULL
      AND original_sha256 IS NULL
      AND original_duration_ms IS NULL
      AND enhanced_object_bytes IS NULL
      AND enhanced_sha256 IS NULL
      AND enhanced_duration_ms IS NULL
      AND processor_version IS NULL
      AND processor_report_json IS NULL
      AND processor_report_sha256 IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'ready'
      AND original_object_bytes IS NOT NULL
      AND original_sha256 IS NOT NULL
      AND original_duration_ms IS NOT NULL
      AND enhanced_object_bytes IS NOT NULL
      AND enhanced_sha256 IS NOT NULL
      AND enhanced_duration_ms IS NOT NULL
      AND processor_version IS NOT NULL
      AND processor_report_json IS NOT NULL
      AND processor_report_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND original_object_bytes IS NULL
      AND original_sha256 IS NULL
      AND original_duration_ms IS NULL
      AND enhanced_object_bytes IS NULL
      AND enhanced_sha256 IS NULL
      AND enhanced_duration_ms IS NULL
      AND processor_version IS NULL
      AND processor_report_json IS NULL
      AND processor_report_sha256 IS NULL
      AND failure_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  UNIQUE (
    episode_id,
    source_object_etag,
    quality_control_report_sha256,
    recipe_sha256
  )
);

CREATE INDEX audio_enhancement_previews_episode
  ON audio_enhancement_previews(episode_id, requested_at DESC, id DESC);

CREATE INDEX audio_enhancement_previews_status
  ON audio_enhancement_previews(status, requested_at);
