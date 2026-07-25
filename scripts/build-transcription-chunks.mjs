#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  planTranscriptionChunks,
  validateTranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";

const execute = promisify(execFile);
const manifestPath = process.argv[2];
const sourcePath = process.argv[3];
const outputDirectory = process.argv[4];
const callbackPath = process.argv[5];
if (!manifestPath || !sourcePath || !outputDirectory || !callbackPath) {
  throw new Error(
    "Pass manifest, source, output directory, and callback paths."
  );
}
const manifest = await validateTranscriptionChunkProcessorManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  { expectedHost: "dust-wave-podcast-staging.jogo.workers.dev" }
);
const source = path.resolve(sourcePath);
const output = path.resolve(outputDirectory);
const evidenceDirectory = path.dirname(path.resolve(callbackPath));
await mkdir(output, { recursive: true, mode: 0o700 });
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const sourceStats = await stat(source);
if (sourceStats.size !== manifest.source.objectBytes) {
  throw new Error("The private source byte count changed.");
}
const sourceSha256 = await fileSha256(source);
if (sourceSha256 !== manifest.source.sha256) {
  throw new Error("The private source SHA-256 changed.");
}
const probe = await probeAudio(source);
if (
  !Number.isFinite(probe.durationMs)
  || Math.abs(probe.durationMs - manifest.source.durationMs) > 1_500
) {
  throw new Error("The private source duration changed.");
}
const silenceWindows = await detectSilence(
  source,
  manifest.policy.silenceThresholdDb,
  manifest.policy.minimumSilenceDurationMs
);
const plan = planTranscriptionChunks({
  sourceDurationMs: manifest.source.durationMs,
  silenceWindows,
  policy: manifest.policy
});
const planJson = JSON.stringify(plan);
const planSha256 = sha256Text(planJson);
const chunks = [];
for (const chunk of plan.chunks) {
  const filename = `${String(chunk.index).padStart(3, "0")}.mp3`;
  const chunkPath = path.join(output, filename);
  const durationMs = chunk.mediaEndsAtMs - chunk.mediaStartsAtMs;
  await execute(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      seconds(chunk.mediaStartsAtMs),
      "-i",
      source,
      "-t",
      seconds(durationMs),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      String(manifest.policy.outputChannels),
      "-ar",
      String(manifest.policy.outputSampleRateHz),
      "-c:a",
      manifest.policy.outputCodec,
      "-b:a",
      `${manifest.policy.outputBitrateKbps}k`,
      "-map_metadata",
      "-1",
      chunkPath
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const chunkStats = await stat(chunkPath);
  if (
    chunkStats.size < 1
    || chunkStats.size > manifest.output.maximumObjectBytes
  ) {
    throw new Error(`Chunk ${chunk.index} exceeds its byte contract.`);
  }
  const chunkProbe = await probeAudio(chunkPath);
  if (
    chunkProbe.codec !== "mp3"
    || chunkProbe.sampleRateHz !== manifest.policy.outputSampleRateHz
    || chunkProbe.channels !== manifest.policy.outputChannels
    || Math.abs(chunkProbe.durationMs - durationMs) > 2_000
  ) {
    throw new Error(`Chunk ${chunk.index} codec evidence is invalid.`);
  }
  chunks.push({
    chunkIndex: chunk.index,
    coreStartsAtMs: chunk.coreStartsAtMs,
    coreEndsAtMs: chunk.coreEndsAtMs,
    mediaStartsAtMs: chunk.mediaStartsAtMs,
    mediaEndsAtMs: chunk.mediaEndsAtMs,
    encodedDurationMs: chunkProbe.durationMs,
    boundaryKind: chunk.boundaryKind,
    objectKey:
      `${manifest.output.keyPrefix}/${String(chunk.index).padStart(3, "0")}.mp3`,
    objectBytes: chunkStats.size,
    sha256: await fileSha256(chunkPath),
    localPath: chunkPath
  });
}
const reportChunks = chunks.map(({ localPath: _localPath, ...chunk }) => chunk);
const reportBase = {
  schemaVersion: manifest.schemaVersion,
  status: "succeeded",
  runId: manifest.runId,
  jobId: manifest.jobId,
  manifestSha256: manifest.manifestSha256,
  processorVersion: manifest.processorVersion,
  sourceSha256,
  sourceDurationMs: manifest.source.durationMs,
  plan,
  planSha256,
  chunks: reportChunks
};
const callback = {
  ...reportBase,
  reportSha256: sha256Text(JSON.stringify(reportBase))
};
await Promise.all([
  writeFile(
    path.resolve(callbackPath),
    `${JSON.stringify(callback, null, 2)}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    path.join(evidenceDirectory, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    path.join(evidenceDirectory, "inventory.json"),
    `${JSON.stringify({
      runId: manifest.runId,
      manifestSha256: manifest.manifestSha256,
      chunks: reportChunks
    }, null, 2)}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    path.join(evidenceDirectory, "upload-inventory.json"),
    `${JSON.stringify({
      runId: manifest.runId,
      manifestSha256: manifest.manifestSha256,
      chunks
    }, null, 2)}\n`,
    { mode: 0o600 }
  )
]);

async function detectSilence(filename, thresholdDb, minimumDurationMs) {
  let stderr = "";
  try {
    const result = await execute(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        filename,
        "-af",
        `silencedetect=noise=${thresholdDb}dB:d=${minimumDurationMs / 1_000}`,
        "-f",
        "null",
        "-"
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    stderr = result.stderr;
  } catch (error) {
    stderr = String(error?.stderr ?? "");
    if (!stderr.includes("silence_")) throw error;
  }
  const events = [...stderr.matchAll(
    /silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/g
  )].map((match) => ({
    kind: match[1],
    atMs: Math.round(Number(match[2]) * 1_000)
  }));
  const windows = [];
  let startsAtMs = null;
  for (const event of events) {
    if (event.kind === "start") {
      startsAtMs = event.atMs;
    } else if (startsAtMs !== null && event.atMs > startsAtMs) {
      windows.push({
        startsAtMs,
        endsAtMs: Math.min(event.atMs, manifest.source.durationMs)
      });
      startsAtMs = null;
    }
  }
  return windows.filter((window) =>
    window.endsAtMs > window.startsAtMs
    && window.startsAtMs < manifest.source.durationMs
  );
}

async function probeAudio(filename) {
  const { stdout } = await execute(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels:format=duration",
      "-of",
      "json",
      filename
    ],
    { maxBuffer: 2 * 1024 * 1024 }
  );
  const value = JSON.parse(stdout);
  const stream = value.streams?.[0] ?? {};
  return {
    codec: String(stream.codec_name ?? ""),
    sampleRateHz: Number(stream.sample_rate),
    channels: Number(stream.channels),
    durationMs: Math.round(Number(value.format?.duration) * 1_000)
  };
}

async function fileSha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function seconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3);
}
