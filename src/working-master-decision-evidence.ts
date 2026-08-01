export function currentWorkingMasterDecisionEvidenceSql({
  requireRevision = false
}: {
  requireRevision?: boolean;
} = {}): string {
  return `EXISTS (
    SELECT 1
    FROM episode_working_master_states decision_state
    JOIN audio_qc_runs decision_qc
      ON decision_qc.id =
        audio_enhancement_derivatives.derivative_quality_control_run_id
    JOIN show_audio_qc_policies decision_policy
      ON decision_policy.show_id = audio_enhancement_derivatives.show_id
    WHERE decision_state.episode_id =
        audio_enhancement_derivatives.episode_id
      ${requireRevision ? "AND decision_state.revision = ?" : ""}
      AND decision_state.current_master_id =
        audio_enhancement_derivatives.source_master_id
      AND decision_qc.status = 'succeeded'
      AND decision_qc.blocker_count = 0
      AND decision_qc.policy_revision = decision_policy.revision
      AND decision_qc.source_sha256 =
        audio_enhancement_derivatives.output_sha256
      AND decision_qc.report_sha256 IS NOT NULL
  )`;
}
