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
import { spawnSync } from "node:child_process";

import {
  AUDIO_ENHANCEMENT_REPORT_SCHEMA,
  audioEnhancementReportSha256,
  validateAudioEnhancementManifest
} from "@dustwave/media-core/audio-enhancement";

const options = parseArguments(process.argv.slice(2));
const manifest = await validateAudioEnhancementManifest(
  JSON.parse(await readFile(options.manifest, "utf8")),
  options.allowFixtureOrigin
    ? {}
    : {
        expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
        expectedBucket: "dustwave-media-staging"
      }
);
const source = await stat(options.source);
if (source.size !== manifest.source.objectBytes) {
  throw new Error("The source byte count does not match the manifest.");
}
const sourceSha256 = await sha256File(options.source);
if (sourceSha256 !== manifest.qualityControl.sourceSha256) {
  throw new Error("The source digest does not match its successful QC run.");
}
const startedAt = Date.now();
const outputDirectory = path.resolve(options.output);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const originalPath = path.join(outputDirectory, "original.mp3");
const enhancedPath = path.join(outputDirectory, "enhanced.mp3");
const ffmpegVersion = commandOutput("ffmpeg", ["-version"]).split("\n")[0];
const ffprobeVersion = commandOutput("ffprobe", ["-version"]).split("\n")[0];
const common = [
  "-hide_banner",
  "-nostdin",
  "-loglevel", "error",
  "-ss", milliseconds(manifest.recipe.previewStartMs),
  "-t", milliseconds(manifest.recipe.previewDurationMs),
  "-i", options.source,
  "-map", "0:a:0",
  "-vn",
  "-map_metadata", "-1",
  "-ar", "48000",
  "-codec:a", "libmp3lame",
  "-b:a", "192k",
  "-write_xing", "0"
];
runFfmpeg([...common, "-y", originalPath]);
const filters = [
  ...(manifest.recipe.presetId === "dialogue-gentle-v1"
    ? ["highpass=f=70"]
    : []),
  [
    "loudnorm=",
    `I=${manifest.recipe.targetIntegratedLufs}:`,
    `TP=${manifest.recipe.maximumTruePeakDbtp}:`,
    "LRA=11"
  ].join("")
].join(",");
runFfmpeg([
  ...common,
  "-af", filters,
  "-y", enhancedPath
]);
const outputs = {
  original: await outputEvidence(
    originalPath,
    manifest.outputs.original.objectKey
  ),
  enhanced: await outputEvidence(
    enhancedPath,
    manifest.outputs.enhanced.objectKey
  )
};
const report = {
  schemaVersion: AUDIO_ENHANCEMENT_REPORT_SCHEMA,
  jobId: manifest.jobId,
  manifestSha256: manifest.manifestSha256,
  processorVersion: `dustwave-audio-enhancement-1 (${ffmpegVersion})`,
  sourceSha256,
  outputs,
  resource: {
    wallMs: Date.now() - startedAt,
    maximumRssBytes: Math.max(
      0,
      Math.round(process.resourceUsage().maxRSS * 1_024)
    ),
    ffmpegVersion,
    ffprobeVersion
  }
};
const reportSha256 = await audioEnhancementReportSha256(
  report,
  manifest
);
await writeFile(
  path.resolve(options.callbackBody),
  `${JSON.stringify({
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256,
    status: "succeeded",
    report,
    reportSha256
  }, null, 2)}\n`,
  { mode: 0o600 }
);
process.stdout.write(`${JSON.stringify({
  jobId: manifest.jobId,
  presetId: manifest.recipe.presetId,
  sourceSha256,
  reportSha256,
  originalBytes: outputs.original.objectBytes,
  enhancedBytes: outputs.enhanced.objectBytes
})}\n`);

async function outputEvidence(filePath, objectKey) {
  const file = await stat(filePath);
  if (file.size < 1 || file.size > 40 * 1024 * 1024) {
    throw new Error("An enhancement preview has an invalid byte count.");
  }
  const durationMs = Math.round(
    Number(commandOutput("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ])) * 1_000
  );
  if (
    !Number.isSafeInteger(durationMs)
    || Math.abs(durationMs - manifest.recipe.previewDurationMs) > 1_000
  ) {
    throw new Error("An enhancement preview has an invalid duration.");
  }
  return {
    objectKey,
    objectBytes: file.size,
    sha256: await sha256File(filePath),
    mimeType: "audio/mpeg",
    durationMs
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function runFfmpeg(argumentsValue) {
  const result = spawnSync("ffmpeg", argumentsValue, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30 * 60 * 1_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `FFmpeg preview render failed: ${boundedError(result)}`
    );
  }
}

function commandOutput(command, argumentsValue) {
  const result = spawnSync(command, argumentsValue, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${boundedError(result)}`);
  }
  return String(result.stdout || result.stderr || "").trim();
}

function boundedError(result) {
  return String(result.stderr || result.stdout || result.error || "unknown")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 500);
}

function milliseconds(value) {
  return (value / 1_000).toFixed(3);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Enhancement render arguments are invalid.");
    }
    result[key.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    )] = path.resolve(value);
  }
  for (const key of ["manifest", "source", "output", "callbackBody"]) {
    if (!result[key]) throw new Error(`Missing --${key}.`);
  }
  result.allowFixtureOrigin =
    process.env.ALLOW_AUDIO_ENHANCEMENT_FIXTURE_ORIGIN === "1";
  return result;
}
