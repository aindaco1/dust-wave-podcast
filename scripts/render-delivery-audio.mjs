#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  spawn,
  spawnSync
} from "node:child_process";

import {
  DELIVERY_AUDIO_PROFILE,
  DELIVERY_AUDIO_REPORT_SCHEMA,
  deliveryAudioReportSha256,
  playerPeaksSha256,
  validateDeliveryAudioManifest,
  validatePlayerPeaksDocument
} from "@dustwave/media-core/delivery-audio";

const options = parseArguments(process.argv.slice(2));
const manifest = await validateDeliveryAudioManifest(
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
if (sourceSha256 !== manifest.source.sha256) {
  throw new Error(
    "The source digest does not match the approved working master."
  );
}

const startedAt = Date.now();
const outputDirectory = path.resolve(options.output);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const outputPath = path.join(outputDirectory, "delivery.mp3");
const ffmpegVersion = commandOutput("ffmpeg", ["-version"]).split("\n")[0];
const ffprobeVersion = commandOutput("ffprobe", ["-version"]).split("\n")[0];

runFfmpeg([
  "-hide_banner",
  "-nostdin",
  "-loglevel", "error",
  "-i", options.source,
  "-map", "0:a:0",
  "-vn",
  "-map_metadata", "-1",
  "-ac", "2",
  "-ar", "44100",
  "-codec:a", "libmp3lame",
  "-b:a", "128k",
  "-reservoir", "0",
  "-write_xing", "0",
  "-id3v2_version", "0",
  "-write_id3v1", "0",
  "-y", outputPath
], 5 * 60 * 60_000);

runFfmpeg([
  "-hide_banner",
  "-nostdin",
  "-loglevel", "error",
  "-i", outputPath,
  "-map", "0:a:0",
  "-f", "null",
  "-"
], 5 * 60 * 60_000);

const frameReport = await validateRawMp3Frames(outputPath);
const durationMs = Math.round(
  (frameReport.frameCount * 1_152 * 1_000) / 44_100
);
const probe = JSON.parse(commandOutput("ffprobe", [
  "-v", "error",
  "-show_entries",
  "format=duration:stream=codec_name,sample_rate,channels,bit_rate",
  "-select_streams", "a:0",
  "-of", "json",
  outputPath
]));
const stream = probe.streams?.[0];
const probedDurationMs = Math.round(
  Number(probe.format?.duration) * 1_000
);
const durationTolerance = Math.max(
  1_000,
  Math.round(manifest.source.durationMs * 0.005)
);
if (
  stream?.codec_name !== "mp3"
  || Number(stream.sample_rate) !== 44_100
  || Number(stream.channels) !== 2
  || Number(stream.bit_rate) !== 128_000
  || Math.abs(durationMs - manifest.source.durationMs) > durationTolerance
  || Math.abs(probedDurationMs - durationMs) > 30
) {
  throw new Error(
    "The delivery audio has invalid codec, profile, or duration evidence."
  );
}

const peaks = validatePlayerPeaksDocument(
  await generatePlayerPeaks(outputPath, durationMs)
);
const peaksText = JSON.stringify(peaks);
const peaksBytes = new TextEncoder().encode(peaksText);
const peaksSha256 = await playerPeaksSha256(peaks);
const outputFile = await stat(outputPath);
if (
  outputFile.size < 1
  || outputFile.size > 2 * 1024 * 1024 * 1024
  || frameReport.frameBytes !== outputFile.size
) {
  throw new Error("The delivery audio has an invalid byte count.");
}

const report = {
  schemaVersion: DELIVERY_AUDIO_REPORT_SCHEMA,
  jobId: manifest.jobId,
  manifestSha256: manifest.manifestSha256,
  processorVersion: `dustwave-delivery-audio-1 (${ffmpegVersion})`,
  sourceSha256,
  audio: {
    objectKey: manifest.output.objectKey,
    objectBytes: outputFile.size,
    sha256: await sha256File(outputPath),
    mimeType: "audio/mpeg",
    durationMs,
    streamProfile: DELIVERY_AUDIO_PROFILE,
    audioCodec: "mp3",
    sampleRateHz: 44_100,
    channels: 2,
    bitrateKbps: 128,
    frameBytes: frameReport.frameBytes,
    frameCount: frameReport.frameCount,
    id3v2Bytes: 0,
    id3v1Bytes: 0,
    fullyDecoded: true
  },
  peaks: {
    objectKey: manifest.peaks.objectKey,
    schemaVersion: "dustwave-player-peaks-v1",
    sha256: peaksSha256,
    objectBytes: peaksBytes.byteLength,
    mimeType: "application/json",
    channels: 1,
    sampleRateHz: 16_000,
    samplesPerPixel: peaks.samples_per_pixel,
    bits: 8,
    length: peaks.length,
    dataPointCount: peaks.data.length
  },
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
const reportSha256 = await deliveryAudioReportSha256(report, manifest);
await writeFile(
  path.resolve(options.callbackBody),
  `${JSON.stringify({
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256,
    status: "succeeded",
    report,
    reportSha256,
    peaks
  }, null, 2)}\n`,
  { mode: 0o600 }
);
process.stdout.write(`${JSON.stringify({
  jobId: manifest.jobId,
  sourceSha256,
  reportSha256,
  outputBytes: report.audio.objectBytes,
  outputSha256: report.audio.sha256,
  outputDurationMs: report.audio.durationMs,
  frameCount: report.audio.frameCount,
  peaksSha256,
  peaksLength: peaks.length
})}\n`);

async function generatePlayerPeaks(filename, expectedDurationMs) {
  const maximumLength = 8_192;
  const expectedSamples = Math.ceil(
    expectedDurationMs * 16_000 / 1_000
  );
  const samplesPerPixel = Math.max(
    1,
    Math.ceil((expectedSamples * 1.01 + 16_000) / maximumLength)
  );
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-i", filename,
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", "16000",
    "-f", "s16le",
    "-"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4_000) stderr += String(chunk);
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", resolve);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 60_000);
  const data = [];
  let carry = Buffer.alloc(0);
  let minimum = 127;
  let maximum = -128;
  let samplesInPixel = 0;
  for await (const chunk of child.stdout) {
    const bytes = carry.length
      ? Buffer.concat([carry, chunk])
      : chunk;
    const readableBytes = bytes.length - (bytes.length % 2);
    for (let offset = 0; offset < readableBytes; offset += 2) {
      const sample = Math.max(
        -128,
        Math.min(127, Math.round(bytes.readInt16LE(offset) / 256))
      );
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
      samplesInPixel += 1;
      if (samplesInPixel === samplesPerPixel) {
        data.push(minimum, maximum);
        minimum = 127;
        maximum = -128;
        samplesInPixel = 0;
      }
    }
    carry = bytes.subarray(readableBytes);
  }
  const status = await closePromise;
  clearTimeout(timeout);
  if (status !== 0 || carry.length !== 0) {
    throw new Error(
      `FFmpeg peaks decode failed: ${boundedText(stderr)}`
    );
  }
  if (samplesInPixel > 0) data.push(minimum, maximum);
  const length = data.length / 2;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximumLength) {
    throw new Error("The player peaks output exceeded its length bound.");
  }
  return {
    schemaVersion: "dustwave-player-peaks-v1",
    version: 2,
    channels: 1,
    sample_rate: 16_000,
    samples_per_pixel: samplesPerPixel,
    bits: 8,
    length,
    data
  };
}

async function validateRawMp3Frames(filename) {
  const handle = await open(filename, "r");
  const chunkSize = 1024 * 1024;
  let position = 0;
  let carry = Buffer.alloc(0);
  let frameBytes = 0;
  let frameCount = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        position
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const bytes = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let offset = 0;
      while (offset + 4 <= bytes.length) {
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
          throw new Error(
            `Delivery MP3 has an invalid frame at byte ${
              position - bytes.length + offset
            }.`
          );
        }
        const frameLength =
          Math.floor((144 * 128_000) / 44_100) + padding;
        if (offset + frameLength > bytes.length) break;
        offset += frameLength;
        frameBytes += frameLength;
        frameCount += 1;
      }
      carry = Buffer.from(bytes.subarray(offset));
      if (carry.length > 418) {
        throw new Error("Delivery MP3 contains non-frame bytes.");
      }
    }
  } finally {
    await handle.close();
  }
  if (carry.length !== 0 || frameCount === 0) {
    throw new Error("Delivery MP3 does not end on a complete frame.");
  }
  return { frameBytes, frameCount };
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function runFfmpeg(argumentsValue, timeout) {
  const result = spawnSync("ffmpeg", argumentsValue, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `FFmpeg delivery render failed: ${boundedText(
        result.stderr || result.stdout || result.error
      )}`
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
    throw new Error(
      `${command} failed: ${boundedText(
        result.stderr || result.stdout || result.error
      )}`
    );
  }
  return String(result.stdout || result.stderr || "").trim();
}

function boundedText(value) {
  return String(value || "unknown")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 500);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Delivery-audio arguments are invalid.");
    }
    result[key.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    )] = path.resolve(value);
  }
  for (const key of ["manifest", "source", "output", "callbackBody"]) {
    if (!result[key]) throw new Error(`Missing --${key}.`);
  }
  result.allowFixtureOrigin =
    process.env.ALLOW_DELIVERY_AUDIO_FIXTURE_ORIGIN === "1";
  return result;
}
