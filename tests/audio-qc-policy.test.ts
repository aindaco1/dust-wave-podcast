import { describe, expect, it } from "vitest";

import {
  audioQcPolicyContract,
  audioQcProcessorDispatch
} from "../src/audio-qc-policy";

describe("shared audio QC policy contract", () => {
  it("projects the same immutable processor policy for QC and derivatives", () => {
    expect(audioQcPolicyContract({
      revision: 3,
      mono_integrated_lufs: -19,
      stereo_integrated_lufs: -16,
      integrated_lufs_tolerance: 1,
      maximum_true_peak_dbtp: -1,
      maximum_dc_offset: 0.01,
      maximum_channel_imbalance_lu: 2,
      maximum_leading_silence_ms: 1_000,
      maximum_trailing_silence_ms: 2_000,
      maximum_internal_silence_ms: 5_000,
      silence_threshold_db: -50
    })).toEqual({
      schemaVersion: "audio-qc-policy-v1",
      revision: 3,
      monoIntegratedLufs: -19,
      stereoIntegratedLufs: -16,
      integratedLufsTolerance: 1,
      maximumTruePeakDbtp: -1,
      maximumDcOffset: 0.01,
      maximumChannelImbalanceLu: 2,
      maximumLeadingSilenceMs: 1_000,
      maximumTrailingSilenceMs: 2_000,
      maximumInternalSilenceMs: 5_000,
      silenceThresholdDb: -50
    });
  });

  it("shares the processor dispatch evidence for QC and derivatives", () => {
    expect(audioQcProcessorDispatch({
      runId: "qc_run_123",
      manifestSha256: "a".repeat(64)
    } as never)).toEqual({
      workflow: "process-audio-qc.yml",
      runId: "qc_run_123",
      manifestSha256: "a".repeat(64)
    });
  });
});
