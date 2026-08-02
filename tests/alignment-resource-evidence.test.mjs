import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAlignmentWorkflowEvidence,
  validateAlignmentDiskMeasurement
} from "../scripts/lib/alignment-resource-evidence.mjs";
import {
  filesystemUsedBytes,
  runWithDiskSampling
} from "../scripts/run-with-disk-sampling.mjs";

describe("alignment resource evidence", () => {
  it("retains content-free language and measured disk evidence", () => {
    const evidence = buildAlignmentWorkflowEvidence({
      manifest: manifestFixture(),
      validated: validatedFixture(),
      diskMeasurement: diskFixture()
    });

    expect(evidence.schemaVersion).toBe("alignment-workflow-evidence-v2");
    expect(evidence.resource).toEqual({
      language: "en",
      inputDurationMinutes: 62.423,
      wallClockMinutes: 6.831,
      peakMemoryMb: 1946.996,
      peakDiskMb: 3200.125,
      runner: "python-3.12"
    });
    expect(evidence.resourceMeasurement).toEqual({
      diskMethod: "filesystem-delta-plus-input-v1",
      sampleIntervalMs: 1000
    });
    expect(JSON.stringify(evidence)).not.toContain("transcript");
    expect(JSON.stringify(evidence)).not.toContain("source.audio");
  });

  it("rejects unknown measurement fields and non-positive resources", () => {
    expect(() => validateAlignmentDiskMeasurement({
      ...diskFixture(),
      path: "/private/source.audio"
    })).toThrow("invalid schema");
    expect(() => buildAlignmentWorkflowEvidence({
      manifest: manifestFixture(),
      validated: {
        ...validatedFixture(),
        manifest: {
          resource: {
            ...validatedFixture().manifest.resource,
            wallClockMinutes: 0
          }
        }
      },
      diskMeasurement: diskFixture()
    })).toThrow("wall-clock duration");
  });

  it("computes bounded filesystem usage from block counts", () => {
    expect(filesystemUsedBytes({
      bsize: 4096,
      blocks: 10_000,
      bfree: 2_000
    })).toBe(32_768_000);
    expect(() => filesystemUsedBytes({
      bsize: 4096,
      blocks: 2_000,
      bfree: 10_000
    })).toThrow("invalid");
  });

  it("runs without a shell and writes a private closed measurement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "dustwave-alignment-resource-")
    );
    const input = path.join(directory, "source.audio");
    const output = path.join(directory, "measurement.json");
    try {
      await writeFile(input, Buffer.alloc(2_048, 1), { mode: 0o600 });

      const measurement = await runWithDiskSampling([
        "--output",
        output,
        "--existing-input",
        input,
        "--",
        process.execPath,
        "-e",
        "setTimeout(() => process.exit(0), 20)"
      ]);

      expect(measurement.peakDiskMb).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(measurement);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(Object.keys(measurement).sort()).toEqual([
        "method",
        "peakDiskMb",
        "sampleIntervalMs",
        "schemaVersion"
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function diskFixture() {
  return {
    schemaVersion: "alignment-disk-measurement-v1",
    method: "filesystem-delta-plus-input-v1",
    sampleIntervalMs: 1000,
    peakDiskMb: 3200.125
  };
}

function manifestFixture() {
  return {
    jobId: "alignment_job_fixture",
    alignmentRevisionId: "alignment_revision_fixture",
    manifestSha256: "a".repeat(64),
    language: "en",
    adapter: {
      name: "whisperx",
      version: "3.8.6",
      modelVersion: "default-en-es-v1",
      settingsVersion: "whisperx-align-v1",
      runnerDigest: `sha256:${"b".repeat(64)}`
    },
    runner: {
      revision: "e611801d2af82dcdb079444b7e8a7eea4309d1a6"
    }
  };
}

function validatedFixture() {
  return {
    manifestSha256: "c".repeat(64),
    quality: {
      schemaVersion: "alignment-result-quality-v1",
      wordCount: 10_176,
      structurallyEligible: true
    },
    manifest: {
      resource: {
        inputDurationMinutes: 62.423,
        wallClockMinutes: 6.831,
        peakMemoryMb: 1946.996,
        runner: "python-3.12"
      }
    }
  };
}
