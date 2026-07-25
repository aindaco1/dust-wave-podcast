import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
  audioEnhancementReportSha256,
  buildAudioEnhancementManifest,
  validateAudioEnhancementReport
} from "@dustwave/media-core/audio-enhancement";

describe("audio enhancement preview processor", () => {
  let temporaryDirectory;
  let sourcePath;
  let sourceBytes;
  let sourceSha256;
  let manifest;
  let manifestPath;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-audio-enhancement-")
    );
    sourcePath = path.join(temporaryDirectory, "source.wav");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=160:sample_rate=48000:duration=6",
      "-filter_complex", "volume=0.08",
      "-ac", "1",
      sourcePath
    ]);
    sourceBytes = (await stat(sourcePath)).size;
    sourceSha256 = await sha256File(sourcePath);
    manifest = await buildAudioEnhancementManifest({
      schemaVersion: "audio-enhancement-job-v1",
      jobId: "enhancement_processor_fixture",
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
      qualityControl: {
        runId: "qc_fixture",
        reportSha256: "a".repeat(64),
        sourceSha256,
        durationMs: 6_000,
        blockerCount: 0
      },
      recipe: {
        schemaVersion: "audio-enhancement-recipe-v1",
        presetId: "dialogue-gentle-v1",
        previewStartMs: 0,
        previewDurationMs: 5_000,
        targetIntegratedLufs: -19,
        maximumTruePeakDbtp: -1
      },
      outputs: {
        original: {
          objectKey:
            "podcasts/show_fixture/episode_fixture/audio_enhancement/"
            + "enhancement_processor_fixture/"
            + "enhancement_processor_fixture-original.mp3",
          mimeType: "audio/mpeg"
        },
        enhanced: {
          objectKey:
            "podcasts/show_fixture/episode_fixture/audio_enhancement/"
            + "enhancement_processor_fixture/"
            + "enhancement_processor_fixture-enhanced.mp3",
          mimeType: "audio/mpeg"
        }
      },
      callbackUrl:
        "https://dust-wave-podcast-staging.jogo.workers.dev/"
        + "v1/processor/audio-enhancements/"
        + "enhancement_processor_fixture/complete"
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
      && process.env.KEEP_AUDIO_ENHANCEMENT_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("renders contract-validated, codec-matched A/B evidence", async () => {
    const callbackPath = path.join(temporaryDirectory, "callback.json");
    const outputPath = path.join(temporaryDirectory, "output");
    run("node", [
      "scripts/render-audio-enhancement-preview.mjs",
      "--manifest", manifestPath,
      "--source", sourcePath,
      "--output", outputPath,
      "--callback-body", callbackPath
    ], { timeout: 120_000 });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    const report = await validateAudioEnhancementReport(
      callback.report,
      manifest
    );

    expect(callback).toMatchObject({
      jobId: manifest.jobId,
      manifestSha256: manifest.manifestSha256,
      status: "succeeded"
    });
    expect(callback.reportSha256).toBe(
      await audioEnhancementReportSha256(report, manifest)
    );
    expect(report.sourceSha256).toBe(sourceSha256);
    expect(report.outputs.original.mimeType).toBe("audio/mpeg");
    expect(report.outputs.enhanced.mimeType).toBe("audio/mpeg");
    expect(report.outputs.original.durationMs).toBeGreaterThanOrEqual(4_900);
    expect(report.outputs.enhanced.durationMs).toBeGreaterThanOrEqual(4_900);
    expect(report.outputs.original.sha256).not.toBe(
      report.outputs.enhanced.sha256
    );
    expect(report.resource.ffmpegVersion).toContain("ffmpeg version");
  });

  it("rejects source bytes that do not match successful QC evidence", async () => {
    const invalidManifest = await buildAudioEnhancementManifest({
      ...manifest,
      qualityControl: {
        ...manifest.qualityControl,
        sourceSha256: "f".repeat(64)
      }
    });
    const invalidPath = path.join(
      temporaryDirectory,
      "invalid-manifest.json"
    );
    await writeFile(invalidPath, JSON.stringify(invalidManifest));
    const result = spawnSync("node", [
      "scripts/render-audio-enhancement-preview.mjs",
      "--manifest", invalidPath,
      "--source", sourcePath,
      "--output", path.join(temporaryDirectory, "invalid-output"),
      "--callback-body", path.join(temporaryDirectory, "invalid.json")
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "source digest does not match its successful QC run"
    );
  });
});

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

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
