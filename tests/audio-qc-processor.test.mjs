import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import {
  audioQcReportSha256,
  buildAudioQcManifest,
  DEFAULT_AUDIO_QC_POLICY,
  validateAudioQcReport
} from "@dustwave/media-core/audio-qc";

describe("source-audio QC processor", () => {
  let temporaryDirectory;
  let sourcePath;
  let sourceBytes;
  let manifest;
  let manifestPath;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-audio-qc-")
    );
    sourcePath = path.join(temporaryDirectory, "source.wav");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "aevalsrc=0:d=1.5:s=48000",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=3",
      "-f", "lavfi",
      "-i", "aevalsrc=0:d=1.5:s=48000",
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=0.3[a]",
      "-map", "[a]",
      "-ac", "1",
      sourcePath
    ]);
    sourceBytes = (await stat(sourcePath)).size;
    manifest = await buildAudioQcManifest({
      schemaVersion: "audio-qc-job-v1",
      runId: "qc_processor_fixture",
      episodeId: "episode_fixture",
      showId: "show_fixture",
      source: {
        bucketName: "dustwave-media-staging",
        objectKey:
          "podcasts/show_fixture/episode_fixture/source_audio/"
          + "upload_fixture-source.wav",
        objectBytes: sourceBytes,
        etag: "\"fixture-etag\"",
        mimeType: "audio/wav"
      },
      policy: { ...DEFAULT_AUDIO_QC_POLICY },
      callbackUrl:
        "https://dust-wave-podcast-staging.jogo.workers.dev/"
        + "v1/processor/audio-qc/qc_processor_fixture/complete"
    });
    manifestPath = path.join(temporaryDirectory, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  });

  afterAll(async () => {
    if (
      temporaryDirectory
      && process.env.KEEP_AUDIO_QC_PROCESSOR_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("fully decodes and emits a contract-validated measured report", async () => {
    const callbackPath = path.join(temporaryDirectory, "callback.json");
    run("node", [
      "scripts/analyze-audio-qc.mjs",
      "--manifest", manifestPath,
      "--source", sourcePath,
      "--callback-body", callbackPath
    ], { timeout: 120_000 });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    const report = await validateAudioQcReport(callback.report, manifest);

    expect(callback).toMatchObject({
      runId: manifest.runId,
      manifestSha256: manifest.manifestSha256,
      status: "succeeded"
    });
    expect(callback.reportSha256).toBe(
      await audioQcReportSha256(report, manifest)
    );
    expect(report.measurements).toMatchObject({
      durationMs: 6_000,
      codec: "pcm_s16le",
      container: "wav",
      sampleRateHz: 48_000,
      bitDepth: 16,
      channels: 1,
      channelLayout: "mono",
      clippedSamples: 0,
      silence: {
        leadingMs: 1_500,
        trailingMs: 1_500,
        longestInternalMs: null
      }
    });
    expect(report.measurements.integratedLufs).toBeLessThan(-20);
    expect(report.measurements.truePeakDbtp).toBeLessThan(-1);
    expect(report.quality).toMatchObject({
      targetIntegratedLufs: -19,
      blockerCount: 0,
      warningCount: 1,
      passed: true
    });
    expect(report.quality.findings.map(({ code }) => code)).toEqual([
      "integrated_loudness"
    ]);
    expect(report.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.resource.wallMs).toBeGreaterThanOrEqual(0);
    expect(report.resource.ffmpegVersion).toContain("ffmpeg version");
  });

  it("rejects a changed source snapshot before invoking analysis", async () => {
    const changedManifest = {
      ...manifest,
      source: { ...manifest.source, objectBytes: sourceBytes + 1 }
    };
    const changedPath = path.join(
      temporaryDirectory,
      "changed-manifest.json"
    );
    await writeFile(changedPath, JSON.stringify(changedManifest));
    const result = spawnSync("node", [
      "scripts/analyze-audio-qc.mjs",
      "--manifest", changedPath,
      "--source", sourcePath,
      "--callback-body", path.join(temporaryDirectory, "invalid.json")
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("manifest digest is invalid");
  });
});

function run(command, argumentsValue, { timeout = 30_000 } = {}) {
  const result = spawnSync(command, argumentsValue, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(
        result.stderr || result.error?.message || ""
      ).slice(0, 2_000)}`
    );
  }
}
