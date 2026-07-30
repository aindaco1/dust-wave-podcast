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
  DELIVERY_AUDIO_PROFILE,
  buildDeliveryAudioManifest,
  deliveryAudioReportSha256,
  playerPeaksSha256,
  validateDeliveryAudioReport,
  validatePlayerPeaksDocument
} from "@dustwave/media-core/delivery-audio";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

describe("delivery-audio renderer", () => {
  let temporaryDirectory;
  let sourcePath;
  let sourceBytes;
  let sourceSha256;
  let manifest;
  let manifestPath;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-delivery-audio-")
    );
    sourcePath = path.join(temporaryDirectory, "source.wav");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=180:sample_rate=48000:duration=6",
      "-filter_complex", "volume=0.08",
      "-ac", "1",
      sourcePath
    ]);
    sourceBytes = (await stat(sourcePath)).size;
    sourceSha256 = await sha256File(sourcePath);
    const jobId = "delivery_processor_fixture";
    const base =
      "https://dust-wave-podcast-staging.jogo.workers.dev/"
      + `v1/processor/delivery-audio-jobs/${jobId}`;
    manifest = await buildDeliveryAudioManifest({
      schemaVersion: "podcast-delivery-audio-job-v1",
      jobId,
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
      profile: {
        id: DELIVERY_AUDIO_PROFILE,
        codec: "mp3",
        sampleRateHz: 44_100,
        channels: 2,
        bitrateKbps: 128,
        writeXing: false
      },
      output: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/"
          + `delivery_audio/${jobId}/${jobId}.mp3`,
        mimeType: "audio/mpeg",
        recommendedPartBytes: 32 * 1024 * 1024
      },
      peaks: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/"
          + `delivery_audio/${jobId}/${jobId}-peaks.json`,
        schemaVersion: "dustwave-player-peaks-v1",
        mimeType: "application/json",
        maximumLength: 8_192
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
      && process.env.KEEP_DELIVERY_AUDIO_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("renders raw complete MP3 frames and bounded player peaks", async () => {
    const callbackPath = path.join(
      temporaryDirectory,
      "callback.json"
    );
    const outputPath = path.join(temporaryDirectory, "output");
    run("node", [
      "scripts/render-delivery-audio.mjs",
      "--manifest", manifestPath,
      "--source", sourcePath,
      "--output", outputPath,
      "--callback-body", callbackPath
    ], {
      timeout: 120_000,
      env: {
        ...process.env,
        ALLOW_DELIVERY_AUDIO_FIXTURE_ORIGIN: "1"
      }
    });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    const report = await validateDeliveryAudioReport(
      callback.report,
      manifest
    );
    const peaks = validatePlayerPeaksDocument(callback.peaks);

    expect(callback).toMatchObject({
      jobId: manifest.jobId,
      manifestSha256: manifest.manifestSha256,
      status: "succeeded"
    });
    expect(callback.reportSha256).toBe(
      await deliveryAudioReportSha256(report, manifest)
    );
    expect(report.sourceSha256).toBe(sourceSha256);
    expect(report.audio).toMatchObject({
      streamProfile: DELIVERY_AUDIO_PROFILE,
      mimeType: "audio/mpeg",
      audioCodec: "mp3",
      sampleRateHz: 44_100,
      channels: 2,
      bitrateKbps: 128,
      id3v2Bytes: 0,
      id3v1Bytes: 0,
      fullyDecoded: true
    });
    expect(report.audio.frameBytes).toBe(report.audio.objectBytes);
    expect(report.audio.frameCount).toBeGreaterThan(100);
    expect(report.audio.durationMs).toBeGreaterThanOrEqual(5_900);
    expect(report.peaks.sha256).toBe(await playerPeaksSha256(peaks));
    expect(peaks.length).toBeGreaterThan(0);
    expect(peaks.length).toBeLessThanOrEqual(8_192);
    expect(peaks.data).toHaveLength(peaks.length * 2);
  });

  it("rejects bytes outside the approved master digest", async () => {
    const invalidManifest = await buildDeliveryAudioManifest({
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
      "scripts/render-delivery-audio.mjs",
      "--manifest", invalidPath,
      "--source", sourcePath,
      "--output", path.join(temporaryDirectory, "invalid-output"),
      "--callback-body", path.join(temporaryDirectory, "invalid.json")
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_DELIVERY_AUDIO_FIXTURE_ORIGIN: "1"
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
