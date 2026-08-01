// Consumers must alias episodes as `episode` and working masters as `master`.
// This one predicate keeps downstream automation behind the same explicit
// promote-or-reject decision while allowing future media/editorial jobs to
// reuse the boundary without copying it.
export const FINAL_WORKING_MASTER_DECISION_SQL = `(
  (
    master.origin_kind = 'enhanced_derivative'
    AND EXISTS (
      SELECT 1
      FROM audio_enhancement_derivatives approved
      WHERE approved.episode_id = episode.id
        AND approved.output_upload_id = master.source_upload_id
        AND approved.derivative_quality_control_run_id =
          master.quality_control_run_id
        AND approved.output_sha256 = master.source_sha256
        AND approved.status = 'approved'
        AND approved.approved_at IS NOT NULL
    )
  )
  OR EXISTS (
    SELECT 1
    FROM audio_enhancement_derivatives rejected
    WHERE rejected.episode_id = episode.id
      AND rejected.source_master_id = master.id
      AND rejected.status = 'stale'
      AND rejected.rejected_at IS NOT NULL
  )
)
AND NOT EXISTS (
  SELECT 1
  FROM audio_enhancement_derivatives active_derivative
  WHERE active_derivative.episode_id = episode.id
    AND active_derivative.source_master_id = master.id
    AND active_derivative.status IN (
      'queued', 'rendering', 'completing', 'ready'
    )
)`;
