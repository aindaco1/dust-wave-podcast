import type {
  AudioQcManifest,
  AudioQcPolicy
} from "@dustwave/media-core/audio-qc";

export type AudioQcPolicyRecord = {
  revision: number;
  mono_integrated_lufs: number;
  stereo_integrated_lufs: number;
  integrated_lufs_tolerance: number;
  maximum_true_peak_dbtp: number;
  maximum_dc_offset: number;
  maximum_channel_imbalance_lu: number;
  maximum_leading_silence_ms: number;
  maximum_trailing_silence_ms: number;
  maximum_internal_silence_ms: number;
  silence_threshold_db: number;
};

export function audioQcPolicyContract(
  row: AudioQcPolicyRecord
): AudioQcPolicy {
  return {
    schemaVersion: "audio-qc-policy-v1",
    revision: row.revision,
    monoIntegratedLufs: row.mono_integrated_lufs,
    stereoIntegratedLufs: row.stereo_integrated_lufs,
    integratedLufsTolerance: row.integrated_lufs_tolerance,
    maximumTruePeakDbtp: row.maximum_true_peak_dbtp,
    maximumDcOffset: row.maximum_dc_offset,
    maximumChannelImbalanceLu: row.maximum_channel_imbalance_lu,
    maximumLeadingSilenceMs: row.maximum_leading_silence_ms,
    maximumTrailingSilenceMs: row.maximum_trailing_silence_ms,
    maximumInternalSilenceMs: row.maximum_internal_silence_ms,
    silenceThresholdDb: row.silence_threshold_db
  };
}

export function audioQcProcessorDispatch(
  manifest: AudioQcManifest
): Record<string, unknown> {
  return {
    workflow: "process-audio-qc.yml",
    runId: manifest.runId,
    manifestSha256: manifest.manifestSha256
  };
}
