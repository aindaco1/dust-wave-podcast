#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  buildCaptionWordTimeline,
  clipYouTubeJson3Reference,
  planCaptionDenseWindows
} from "./lib/alignment-benchmark-source.mjs";
import {
  parseYouTubeJson3Reference
} from "./lib/transcript-reference-audit.mjs";

const execute = promisify(execFile);
const MAXIMUM_AUDIO_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_REFERENCE_BYTES = 20 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;

const options = parseArguments(process.argv.slice(2));
const result = await prepareSource(options);
process.stdout.write(`${JSON.stringify(result)}\n`);

async function prepareSource({
  audioPath,
  referencePath,
  outputDirectory,
  sourceId,
  language,
  sourceUrl,
  sourceTitle,
  rightsApprovedBy,
  rightsApprovedAt,
  fixtureCount,
  windowDurationMs,
  gridMs,
  minimumGapMs,
  minimumReferenceWords
}) {
  const audio = await regularInput(audioPath, MAXIMUM_AUDIO_BYTES, "audio");
  const reference = await regularInput(
    referencePath,
    MAXIMUM_REFERENCE_BYTES,
    "caption reference"
  );
  const referenceDocument = parseJson(
    await readFile(reference.path),
    "Caption reference"
  );
  const referenceCues = parseYouTubeJson3Reference(referenceDocument);
  const words = buildCaptionWordTimeline(referenceCues);
  const sourceDurationMs = await probeDurationMs(audio.path);
  const windows = planCaptionDenseWindows({
    words,
    sourceDurationMs,
    fixtureCount,
    windowDurationMs,
    gridMs,
    minimumGapMs,
    minimumReferenceWords
  });
  await requireMissing(outputDirectory);
  const parent = resolve(dirname(outputDirectory));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, `.${basename(outputDirectory)}.tmp-`));
  await chmod(temporary, 0o700);
  try {
    const ffmpegVersion = await toolVersion("ffmpeg");
    const fixtures = [];
    for (const [index, window] of windows.entries()) {
      const fixtureId = `${sourceId}-${language}-${String(index + 1).padStart(2, "0")}`;
      const directory = join(temporary, "fixtures", fixtureId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const outputAudio = join(directory, "audio.wav");
      await execute("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-ss", milliseconds(window.startsAtMs),
        "-i", audio.path,
        "-t", milliseconds(window.endsAtMs - window.startsAtMs),
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-fflags", "+bitexact",
        "-flags:a", "+bitexact",
        outputAudio
      ], { maxBuffer: 1024 * 1024 });
      await chmod(outputAudio, 0o600);
      const measuredDurationMs = await probeDurationMs(outputAudio);
      if (
        measuredDurationMs < 120_000
        || measuredDurationMs > 300_000
        || Math.abs(measuredDurationMs - windowDurationMs) > 100
      ) {
        throw new TypeError(`${fixtureId} media duration is invalid`);
      }
      const clippedReference = clipYouTubeJson3Reference(
        referenceDocument,
        window.startsAtMs,
        window.endsAtMs
      );
      const referenceOutput = join(directory, "reference.unreviewed.json3");
      await secureJson(referenceOutput, clippedReference);
      const fixture = {
        fixtureId,
        language,
        sourceStartsAtMs: window.startsAtMs,
        sourceEndsAtMs: window.endsAtMs,
        audioDurationMs: measuredDurationMs,
        referenceWordCount: window.referenceWordCount,
        audioPath: `fixtures/${fixtureId}/audio.wav`,
        audioSha256: await fileSha256(outputAudio),
        referencePath: `fixtures/${fixtureId}/reference.unreviewed.json3`,
        referenceSha256: await fileSha256(referenceOutput),
        referenceStatus: "youtube-automatic-captions-unreviewed",
        requiresHumanTranscriptReview: true
      };
      await secureJson(join(directory, "candidate.json"), {
        schemaVersion: "dust-wave-alignment-benchmark-candidate-v1",
        ...fixture
      });
      fixtures.push(fixture);
    }
    const inventory = {
      schemaVersion: "dust-wave-alignment-benchmark-source-v1",
      source: {
        id: sourceId,
        url: sourceUrl,
        title: sourceTitle,
        language,
        audioSha256: await fileSha256(audio.path),
        referenceSha256: await fileSha256(reference.path),
        durationMs: sourceDurationMs,
        referenceKind: "youtube-automatic-captions-unreviewed"
      },
      rightsApproval: {
        approved: true,
        approvedBy: rightsApprovedBy,
        approvedAt: rightsApprovedAt,
        scope: "private alignment benchmark testing"
      },
      preparation: {
        fixtureCount: fixtures.length,
        windowDurationMs,
        gridMs,
        minimumGapMs,
        minimumReferenceWords,
        audioCodec: "pcm_s16le",
        sampleRateHz: 16_000,
        channels: 1,
        ffmpegVersion
      },
      fixtures
    };
    const inventoryPath = join(temporary, "inventory.json");
    await secureJson(inventoryPath, inventory);
    const inventorySha256 = await fileSha256(inventoryPath);
    await rename(temporary, resolve(outputDirectory));
    return {
      schemaVersion: inventory.schemaVersion,
      fixtureCount: fixtures.length,
      totalFixtureDurationMs: fixtures.reduce(
        (sum, fixture) => sum + fixture.audioDurationMs,
        0
      ),
      minimumFixtureReferenceWords: Math.min(
        ...fixtures.map((fixture) => fixture.referenceWordCount)
      ),
      totalFixtureReferenceWords: fixtures.reduce(
        (sum, fixture) => sum + fixture.referenceWordCount,
        0
      ),
      inventorySha256,
      outputDirectory: resolve(outputDirectory),
      transcriptStatus: "requires-human-review"
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(values) {
  const options = {
    fixtureCount: 12,
    windowDurationMs: 135_000,
    gridMs: 1_000,
    minimumGapMs: 1_000,
    minimumReferenceWords: 100
  };
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    if (flag === "--audio") options.audioPath = value;
    else if (flag === "--reference") options.referencePath = value;
    else if (flag === "--output") options.outputDirectory = value;
    else if (flag === "--source-id") options.sourceId = identifier(value, flag);
    else if (flag === "--language") options.language = language(value);
    else if (flag === "--source-url") options.sourceUrl = sourceUrl(value);
    else if (flag === "--source-title") options.sourceTitle = boundedText(value, flag);
    else if (flag === "--rights-approved-by") {
      options.rightsApprovedBy = boundedText(value, flag);
    } else if (flag === "--rights-approved-at") {
      options.rightsApprovedAt = date(value, flag);
    } else if (flag === "--fixture-count") options.fixtureCount = integer(value, flag);
    else if (flag === "--window-duration-ms") {
      options.windowDurationMs = integer(value, flag);
    } else if (flag === "--grid-ms") options.gridMs = integer(value, flag);
    else if (flag === "--minimum-gap-ms") {
      options.minimumGapMs = integer(value, flag);
    } else if (flag === "--minimum-reference-words") {
      options.minimumReferenceWords = integer(value, flag);
    } else usage();
  }
  const required = [
    "audioPath",
    "referencePath",
    "outputDirectory",
    "sourceId",
    "language",
    "sourceUrl",
    "sourceTitle",
    "rightsApprovedBy",
    "rightsApprovedAt"
  ];
  if (required.some((field) => !options[field])) usage();
  return options;
}

async function regularInput(pathValue, maximumBytes, field) {
  const path = resolve(String(pathValue ?? ""));
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(`${field} must be a regular, non-symlink file`);
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new TypeError(`${field} size is invalid`);
  }
  return { path, size: metadata.size };
}

async function requireMissing(pathValue) {
  try {
    await lstat(resolve(pathValue));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Output directory already exists");
}

async function probeDurationMs(path) {
  const { stdout } = await execute("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path
  ], { maxBuffer: 64 * 1024 });
  const durationMs = Math.round(Number(stdout.trim()) * 1_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new TypeError("Audio duration is invalid");
  }
  return durationMs;
}

async function toolVersion(command) {
  const { stdout } = await execute(command, ["-version"], { maxBuffer: 64 * 1024 });
  return boundedText(stdout.split(/\r?\n/u)[0], `${command} version`);
}

async function secureJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const source = createReadStream(path);
    source.on("data", (chunk) => hash.update(chunk));
    source.on("error", rejectPromise);
    source.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function parseJson(bytes, field) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${field} is not valid JSON`);
  }
}

function milliseconds(value) {
  return (value / 1_000).toFixed(3);
}

function identifier(value, field) {
  if (!IDENTIFIER.test(String(value))) throw new TypeError(`${field} is invalid`);
  return String(value);
}

function language(value) {
  if (!new Set(["en", "es"]).has(value)) {
    throw new TypeError("--language must be en or es");
  }
  return value;
}

function sourceUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new TypeError("--source-url is invalid");
  }
  return parsed.toString();
}

function boundedText(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 500 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${field} is invalid`);
  }
  return text;
}

function date(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function usage() {
  throw new TypeError(
    "Usage: prepare-alignment-benchmark-source --audio FILE --reference FILE "
      + "--output DIRECTORY --source-id ID --language en|es --source-url URL "
      + "--source-title TITLE --rights-approved-by NAME --rights-approved-at YYYY-MM-DD"
  );
}
