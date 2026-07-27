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
  audioEnhancementDerivativeReportSha256,
  buildAudioEnhancementDerivativeManifest,
  validateAudioEnhancementDerivativeReport
} from "@dustwave/media-core/audio-enhancement-derivative";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

describe("audio enhancement derivative renderer", () => {
  let temporaryDirectory;
  let sourcePath;
  let sourceBytes;
  let sourceSha256;
  let manifest;
  let manifestPath;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-audio-derivative-")
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
    const jobId = "derivative_processor_fixture";
    const base =
      "https://dust-wave-podcast-staging.jogo.workers.dev/"
      + `v1/processor/audio-enhancement-derivatives/${jobId}`;
    manifest = await buildAudioEnhancementDerivativeManifest({
      schemaVersion: "audio-enhancement-derivative-job-v1",
      jobId,
      selectedPreviewId: "preview_fixture",
      episodeId: "episode_fixture",
      showId: "show_fixture",
      source: {
        workingMasterId: "master_fixture",
        bucketName: "dustwave-media-staging",
        objectKey:
          "podcasts/show_fixture/episode_fixture/source_audio/"
          + "source.wav",
        objectBytes: sourceBytes,
        etag: "\"fixture-etag\"",
        mimeType: "audio/wav",
        sha256: sourceSha256,
        durationMs: 6_000
      },
      qualityControl: {
        runId: "qc_fixture",
        reportSha256: "a".repeat(64),
        blockerCount: 0
      },
      selection: {
        previewManifestSha256: "b".repeat(64),
        previewReportSha256: "c".repeat(64),
        previewEnhancedSha256: "d".repeat(64)
      },
      recipe: {
        schemaVersion: "audio-enhancement-derivative-recipe-v1",
        presetId: "dialogue-gentle-v1",
        targetIntegratedLufs: -19,
        maximumTruePeakDbtp: -1
      },
      output: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/"
          + `audio_enhancement_derivatives/${jobId}/${jobId}.mp3`,
        mimeType: "audio/mpeg",
        recommendedPartBytes: 32 * 1024 * 1024
      },
      endpoints: {
        source: `${base}/source`,
        partTemplate: `${base}/parts/{partNumber}`,
        uploadComplete: `${base}/upload-complete`,
        evidenceComplete: `${base}/complete`
      }
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
      && process.env.KEEP_AUDIO_DERIVATIVE_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("renders and fully decodes a contract-bound full-length MP3", async () => {
    const callbackPath = path.join(
      temporaryDirectory,
      "callback.json"
    );
    const outputPath = path.join(temporaryDirectory, "output");
    run("node", [
      "scripts/render-audio-enhancement-derivative.mjs",
      "--manifest", manifestPath,
      "--source", sourcePath,
      "--output", outputPath,
      "--callback-body", callbackPath
    ], {
      timeout: 120_000,
      env: {
        ...process.env,
        ALLOW_AUDIO_ENHANCEMENT_FIXTURE_ORIGIN: "1"
      }
    });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    const report = await validateAudioEnhancementDerivativeReport(
      callback.report,
      manifest
    );

    expect(callback).toMatchObject({
      jobId: manifest.jobId,
      manifestSha256: manifest.manifestSha256,
      status: "succeeded"
    });
    expect(callback.reportSha256).toBe(
      await audioEnhancementDerivativeReportSha256(report, manifest)
    );
    expect(report.sourceSha256).toBe(sourceSha256);
    expect(report.output).toMatchObject({
      mimeType: "audio/mpeg",
      audioCodec: "mp3",
      sampleRateHz: 48_000,
      fullyDecoded: true
    });
    expect(report.output.durationMs).toBeGreaterThanOrEqual(5_900);
    expect(report.output.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects bytes outside the approved master digest", async () => {
    const invalidManifest =
      await buildAudioEnhancementDerivativeManifest({
        ...manifest,
        source: {
          ...manifest.source,
          sha256: "f".repeat(64)
        }
      });
    const invalidPath = path.join(
      temporaryDirectory,
      "invalid-manifest.json"
    );
    await writeFile(invalidPath, JSON.stringify(invalidManifest));
    const result = spawnSync("node", [
      "scripts/render-audio-enhancement-derivative.mjs",
      "--manifest", invalidPath,
      "--source", sourcePath,
      "--output", path.join(temporaryDirectory, "invalid-output"),
      "--callback-body", path.join(temporaryDirectory, "invalid.json")
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_AUDIO_ENHANCEMENT_FIXTURE_ORIGIN: "1"
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "source digest does not match the approved working master"
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}
