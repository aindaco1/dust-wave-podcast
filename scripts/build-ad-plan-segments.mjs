#!/usr/bin/env node

import {
  createHash
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  spawnSync
} from "node:child_process";

const PROFILE = "mp3-44100-stereo-cbr128-frame-v1";
const FRAME_DURATION_MS = (1_152 * 1_000) / 44_100;
const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
validateManifest(manifest);
await mkdir(options.output, { recursive: true });
const normalizedPath = path.join(options.output, "normalized.mp3");
const ffmpegVersion = commandOutput("ffmpeg", ["-version"]).split("\n")[0];
run("ffmpeg", [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-i", options.source,
  "-map_metadata", "-1",
  "-vn",
  "-ac", "2",
  "-ar", "44100",
  "-codec:a", "libmp3lame",
  "-b:a", "128k",
  "-write_xing", "0",
  "-id3v2_version", "0",
  "-write_id3v1", "0",
  normalizedPath
]);
const normalized = await readFile(normalizedPath);
const frames = parseFrames(normalized);
const splitFrames = manifest.markers
  .filter(({ position }) => position === "mid")
  .map(({ startsAtMs }) =>
    Math.max(1, Math.min(frames.length - 1, Math.round(
      Number(startsAtMs) / FRAME_DURATION_MS
    )))
  );
const boundaries = [0, ...splitFrames, frames.length];
const segments = [];
for (let sequence = 0; sequence < boundaries.length - 1; sequence += 1) {
  const startFrame = boundaries[sequence];
  const endFrame = boundaries[sequence + 1];
  const firstByte = frames[startFrame].offset;
  const last = frames[endFrame - 1];
  const lastByte = last.offset + last.length;
  const bytes = normalized.subarray(firstByte, lastByte);
  const filename = `program-${sequence}.mp3`;
  await writeFile(path.join(options.output, filename), bytes);
  const frameCount = endFrame - startFrame;
  segments.push({
    id: `${manifest.planId}_program_${sequence}`,
    sequence,
    objectKey: `${String(manifest.outputPrefix).replace(/\/+$/, "")}/${filename}`,
    objectBytes: bytes.byteLength,
    sourceOffset: 0,
    byteLength: bytes.byteLength,
    audioMimeType: "audio/mpeg",
    streamProfile: PROFILE,
    sha256: digest(bytes),
    durationMs: Math.round(frameCount * FRAME_DURATION_MS),
    frameCount
  });
}
const callback = {
  processorVersion: `dustwave-ad-segmenter-1 (${ffmpegVersion})`,
  source: manifest.source,
  segments,
  report: {
    schemaVersion: "1",
    profile: PROFILE,
    normalizedSha256: digest(normalized),
    normalizedBytes: normalized.byteLength,
    audioFrameBytes: frames.reduce((total, frame) => total + frame.length, 0),
    frameCount: frames.length,
    durationMs: Math.round(frames.length * FRAME_DURATION_MS),
    splitFrames,
    decoderErrors: 0,
    fullDecode: true
  }
};
await writeFile(options.callbackBody, `${JSON.stringify(callback, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  planId: manifest.planId,
  segmentCount: segments.length,
  callbackBody: options.callbackBody
})}\n`);

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    result[name.slice(2)] = value;
  }
  if (
    !result.manifest
    || !result.source
    || !result.output
    || !result["callback-body"]
  ) {
    usage();
  }
  return {
    manifest: path.resolve(result.manifest),
    source: path.resolve(result.source),
    output: path.resolve(result.output),
    callbackBody: path.resolve(result["callback-body"])
  };
}

function usage() {
  process.stderr.write(
    "Usage: build-ad-plan-segments.mjs --manifest plan.json --source episode --output directory --callback-body callback.json\n"
  );
  process.exit(2);
}

function validateManifest(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Processor manifest must be an object.");
  }
  if (
    value.schemaVersion !== "1"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(value.planId || ""))
    || value.streamProfile !== PROFILE
    || !value.source?.objectKey
    || !Number.isSafeInteger(Number(value.source?.objectBytes))
    || !value.source?.etag
    || !String(value.outputPrefix || "").trim()
    || !Array.isArray(value.markers)
  ) {
    throw new Error("Processor manifest contract is invalid.");
  }
  const midMarkers = value.markers.filter(({ position }) => position === "mid");
  if (
    midMarkers.length > 1
    || midMarkers.some(({ startsAtMs }) =>
      !Number.isSafeInteger(Number(startsAtMs)) || Number(startsAtMs) <= 0
    )
  ) {
    throw new Error("Processor manifest has invalid mid-roll markers.");
  }
}

function parseFrames(bytes) {
  let offset = id3v2Length(bytes);
  const audioEnd = hasId3v1(bytes) ? bytes.byteLength - 128 : bytes.byteLength;
  const frames = [];
  while (offset < audioEnd) {
    if (offset + 4 > audioEnd) {
      throw new Error("Normalized MP3 ends inside a frame header.");
    }
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const fourth = bytes[offset + 3];
    const versionBits = (second >> 3) & 0x03;
    const layerBits = (second >> 1) & 0x03;
    const bitrateIndex = (third >> 4) & 0x0f;
    const sampleRateIndex = (third >> 2) & 0x03;
    const padding = (third >> 1) & 0x01;
    const channelMode = (fourth >> 6) & 0x03;
    if (
      first !== 0xff
      || (second & 0xe0) !== 0xe0
      || versionBits !== 0x03
      || layerBits !== 0x01
      || bitrateIndex !== 0x09
      || sampleRateIndex !== 0x00
      || channelMode === 0x03
    ) {
      throw new Error(`Normalized MP3 frame ${frames.length + 1} violates ${PROFILE}.`);
    }
    const length = Math.floor((144 * 128_000) / 44_100) + padding;
    if (offset + length > audioEnd) {
      throw new Error(`Normalized MP3 frame ${frames.length + 1} is truncated.`);
    }
    frames.push({ offset, length });
    offset += length;
  }
  if (frames.length === 0 || offset !== audioEnd) {
    throw new Error("Normalized MP3 does not contain complete frames.");
  }
  return frames;
}

function id3v2Length(bytes) {
  if (
    bytes.byteLength < 10
    || bytes[0] !== 0x49
    || bytes[1] !== 0x44
    || bytes[2] !== 0x33
  ) {
    return 0;
  }
  const sizeBytes = bytes.subarray(6, 10);
  if (sizeBytes.some((value) => (value & 0x80) !== 0)) {
    throw new Error("Normalized MP3 has an invalid ID3v2 size.");
  }
  const payloadBytes = (
    (sizeBytes[0] << 21)
    | (sizeBytes[1] << 14)
    | (sizeBytes[2] << 7)
    | sizeBytes[3]
  );
  return 10 + payloadBytes + ((bytes[5] & 0x10) !== 0 ? 10 : 0);
}

function hasId3v1(bytes) {
  const offset = bytes.byteLength - 128;
  return offset >= 0
    && bytes[offset] === 0x54
    && bytes[offset + 1] === 0x41
    && bytes[offset + 2] === 0x47;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`
    );
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is unavailable.`);
  }
  return String(result.stdout);
}
