PRAGMA foreign_keys = ON;

ALTER TABLE audio_enhancement_derivatives
  ADD COLUMN rejected_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE RESTRICT;

ALTER TABLE audio_enhancement_derivatives
  ADD COLUMN rejection_reason TEXT
    CHECK (
      rejection_reason IS NULL
      OR length(rejection_reason) BETWEEN 10 AND 500
    );

ALTER TABLE audio_enhancement_derivatives
  ADD COLUMN rejected_at TEXT;

CREATE TRIGGER audio_enhancement_derivative_rejection_consistency
BEFORE UPDATE OF
  status,
  rejected_by_admin_user_id,
  rejection_reason,
  rejected_at
ON audio_enhancement_derivatives
WHEN NOT (
  (
    NEW.rejected_by_admin_user_id IS NULL
    AND NEW.rejection_reason IS NULL
    AND NEW.rejected_at IS NULL
  )
  OR (
    NEW.rejected_by_admin_user_id IS NOT NULL
    AND NEW.rejection_reason IS NOT NULL
    AND NEW.rejected_at IS NOT NULL
    AND OLD.rejected_by_admin_user_id IS NULL
    AND OLD.rejection_reason IS NULL
    AND OLD.rejected_at IS NULL
    AND OLD.status = 'ready'
    AND NEW.status = 'stale'
    AND NEW.approved_by_admin_user_id IS NULL
    AND NEW.approval_reason IS NULL
    AND NEW.approved_at IS NULL
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative rejection evidence is inconsistent'
  );
END;

CREATE TRIGGER audio_enhancement_derivative_rejection_evidence
BEFORE UPDATE OF rejected_at ON audio_enhancement_derivatives
WHEN NEW.rejected_at IS NOT NULL
  AND OLD.rejected_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM audio_qc_runs qc
    JOIN episodes episode ON episode.id = NEW.episode_id
    JOIN show_audio_qc_policies policy
      ON policy.show_id = episode.show_id
    JOIN episode_working_master_states state
      ON state.episode_id = NEW.episode_id
    WHERE qc.id = NEW.derivative_quality_control_run_id
      AND qc.status = 'succeeded'
      AND qc.blocker_count = 0
      AND qc.policy_revision = policy.revision
      AND qc.source_sha256 = NEW.output_sha256
      AND qc.report_sha256 IS NOT NULL
      AND state.current_master_id = NEW.source_master_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative rejection evidence is invalid'
  );
END;

CREATE TRIGGER audio_enhancement_derivative_rejection_immutable
BEFORE UPDATE OF
  status,
  rejected_by_admin_user_id,
  rejection_reason,
  rejected_at
ON audio_enhancement_derivatives
WHEN OLD.rejected_at IS NOT NULL
  AND (
    NEW.status IS NOT OLD.status
    OR NEW.rejected_by_admin_user_id
      IS NOT OLD.rejected_by_admin_user_id
    OR NEW.rejection_reason IS NOT OLD.rejection_reason
    OR NEW.rejected_at IS NOT OLD.rejected_at
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'audio enhancement derivative rejection evidence is immutable'
  );
END;
