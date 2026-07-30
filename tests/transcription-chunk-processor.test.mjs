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
  buildTranscriptionChunkProcessorManifest,
  MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
  validateTranscriptionChunkPlan
} from "@dustwave/timed-text/chunking";

describe("silence-aware transcription chunk processor", () => {
  let temporaryDirectory;
  let sourcePath;
  let manifest;
  let manifestPath;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-transcription-chunks-")
    );
    sourcePath = path.join(temporaryDirectory, "source.wav");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=180:sample_rate=16000:duration=59",
      "-f", "lavfi",
      "-i", "anullsrc=r=16000:cl=mono:d=2",
      "-f", "lavfi",
      "-i", "sine=frequency=240:sample_rate=16000:duration=69",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]",
      "-ac", "1",
      sourcePath
    ], { timeout: 60_000 });
    const sourceBytes = (await stat(sourcePath)).size;
    const sourceSha256 = await sha256File(sourcePath);
    manifest = await buildTranscriptionChunkProcessorManifest({
      schemaVersion: "transcription-chunk-processor-v1",
      processorVersion: "ffmpeg-transcription-chunker-v1",
      runId: "transcription_chunks_fixture",
      jobId: "transcription_fixture",
      episodeId: "episode_fixture",
      showId: "show_fixture",
      workingMasterId: "master_fixture",
      language: "es",
      source: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/source_audio/source.wav",
        objectBytes: sourceBytes,
        etag: "\"source-etag\"",
        mimeType: "audio/wav",
        sha256: sourceSha256,
        durationMs: 130_000
      },
      policy: {
        targetChunkDurationMs: 60_000,
        maximumChunkDurationMs: 120_000,
        minimumChunkDurationMs: 30_000,
        overlapMs: 1_500,
        silenceThresholdDb: -35,
        minimumSilenceDurationMs: 500,
        outputMimeType: "audio/mpeg",
        outputCodec: "libmp3lame",
        outputSampleRateHz: 16_000,
        outputChannels: 1,
        outputBitrateKbps: 64
      },
      output: {
        keyPrefix:
          "podcasts/show_fixture/episode_fixture/transcription/"
          + "transcription_fixture/chunk-audio",
        mimeType: "audio/mpeg",
        maximumObjectBytes: MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
        uploadUrlTemplate:
          "https://dust-wave-podcast-staging.jogo.workers.dev/"
          + "v1/processor/transcription-chunks/"
          + "transcription_chunks_fixture/chunks/{index}"
      },
      sourceUrl:
        "https://dust-wave-podcast-staging.jogo.workers.dev/"
        + "v1/processor/transcription-chunks/"
        + "transcription_chunks_fixture/source",
      callbackUrl:
        "https://dust-wave-podcast-staging.jogo.workers.dev/"
        + "v1/processor/transcription-chunks/"
        + "transcription_chunks_fixture/complete"
    });
    manifestPath = path.join(temporaryDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
  });

  afterAll(async () => {
    if (
      temporaryDirectory
      && process.env.KEEP_TRANSCRIPTION_CHUNK_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("fully decodes once and creates digest-bound mono 16 kHz chunks", async () => {
    const callbackPath = path.join(temporaryDirectory, "callback.json");
    const outputDirectory = path.join(temporaryDirectory, "audio");
    run("node", [
      "scripts/build-transcription-chunks.mjs",
      manifestPath,
      sourcePath,
      outputDirectory,
      callbackPath
    ], { timeout: 120_000 });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    const plan = validateTranscriptionChunkPlan(callback.plan, {
      sourceDurationMs: 130_000,
      policy: manifest.policy
    });
    expect(callback).toMatchObject({
      schemaVersion: "transcription-chunk-processor-v1",
      status: "succeeded",
      runId: manifest.runId,
      jobId: manifest.jobId,
      manifestSha256: manifest.manifestSha256,
      processorVersion: "ffmpeg-transcription-chunker-v1",
      sourceSha256: manifest.source.sha256,
      sourceDurationMs: 130_000
    });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0].boundaryKind).toBe("silence");
    expect(plan.chunks[0].coreEndsAtMs).toBeGreaterThanOrEqual(59_000);
    expect(plan.chunks[0].coreEndsAtMs).toBeLessThanOrEqual(61_000);
    expect(callback.chunks).toHaveLength(2);
    for (const chunk of callback.chunks) {
      expect(chunk.objectBytes).toBeGreaterThan(1_000);
      expect(chunk.objectBytes).toBeLessThanOrEqual(
        MAXIMUM_TRANSCRIPTION_CHUNK_BYTES
      );
      expect(chunk.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        Math.abs(
          chunk.encodedDurationMs
          - (chunk.mediaEndsAtMs - chunk.mediaStartsAtMs)
        )
      ).toBeLessThanOrEqual(2_000);
    }
    const { reportSha256: _reportSha256, ...reportBase } = callback;
    expect(callback.reportSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(reportBase), "utf8")
        .digest("hex")
    );
    const evidenceInventory = await readFile(
      path.join(temporaryDirectory, "inventory.json"),
      "utf8"
    );
    expect(evidenceInventory).not.toContain("source.wav");
    expect(evidenceInventory).not.toContain("localPath");
    expect(
      await readFile(
        path.join(temporaryDirectory, "upload-inventory.json"),
        "utf8"
      )
    ).toContain("localPath");
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
      ).slice(0, 3_000)}`
    );
  }
}
