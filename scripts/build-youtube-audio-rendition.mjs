#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream
} from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  validateYouTubeAudioRenditionManifest
} from "./lib/youtube-audio-rendition-contract.mjs";

const options = parseArguments(process.argv.slice(2));
const manifest = validateYouTubeAudioRenditionManifest(
  JSON.parse(await readFile(options.manifest, "utf8"))
);
await mkdir(options.output, { recursive: true });
const [source, artwork] = await Promise.all([
  stat(options.source),
  stat(options.artwork)
]);
if (
  source.size !== manifest.source.objectBytes
  || artwork.size !== manifest.artwork.objectBytes
) {
  throw new Error("The downloaded input byte counts do not match the manifest.");
}
if (await fileSha256(options.artwork) !== manifest.artwork.sha256) {
  throw new Error("The downloaded artwork checksum does not match the manifest.");
}

const outputPath = path.join(options.output, "episode.mp4");
const ffmpegVersion = commandOutput("ffmpeg", ["-version"]).split("\n")[0];
const startedAt = Date.now();
run("ffmpeg", [
  "-hide_banner",
  "-nostdin",
  "-loglevel", "error",
  "-y",
  "-i", options.source,
  "-loop", "1",
  "-framerate", "30",
  "-i", options.artwork,
  "-filter_complex",
  [
    "[0:a]asplit=2[aout][wavein];",
    "[1:v]split=2[bgsrc][coversrc];",
    "[bgsrc]scale=1920:1080:force_original_aspect_ratio=increase,",
    "crop=1920:1080,boxblur=40:2[background];",
    "[coversrc]scale=760:760:force_original_aspect_ratio=decrease,",
    "pad=760:760:(ow-iw)/2:(oh-ih)/2:color=0x101010[cover];",
    "[wavein]showwaves=s=1600x220:mode=cline:colors=0xff5964:",
    "r=30:draw=full[wave];",
    "[background][cover]overlay=(W-w)/2:110[base];",
    "[base][wave]overlay=(W-w)/2:H-h-110:shortest=1[video]"
  ].join(""),
  "-map", "[video]",
  "-map", "[aout]",
  "-map_metadata", "-1",
  "-map_chapters", "-1",
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "26",
  "-profile:v", "high",
  "-level:v", "4.2",
  "-pix_fmt", "yuv420p",
  "-r", "30",
  "-c:a", "aac",
  "-b:a", "192k",
  "-ar", "48000",
  "-ac", "2",
  "-movflags", "+faststart",
  "-shortest",
  outputPath
]);

const probe = JSON.parse(commandOutput("ffprobe", [
  "-v", "error",
  "-show_entries",
  "format=duration,size:stream=codec_type,codec_name,pix_fmt,width,height,"
    + "sample_rate,channels,r_frame_rate",
  "-of", "json",
  outputPath
]));
validateProbe(manifest, probe);
run("ffmpeg", [
  "-hide_banner",
  "-nostdin",
  "-loglevel", "error",
  "-i", outputPath,
  "-map", "0:v:0",
  "-map", "0:a:0",
  "-f", "null",
  "-"
]);
const output = await stat(outputPath);
if (
  output.size < 1
  || output.size > manifest.output.maximumBytes
) {
  throw new Error("The rendered MP4 byte count is outside the contract.");
}
const video = probe.streams.find(({ codec_type: type }) => type === "video");
const audio = probe.streams.find(({ codec_type: type }) => type === "audio");
const durationMs = Math.round(Number(probe.format.duration) * 1_000);
const callback = {
  renditionId: manifest.renditionId,
  manifestSha256: manifest.manifestSha256,
  status: "succeeded",
  processorVersion: `dustwave-youtube-audio-renderer-1 (${ffmpegVersion})`,
  output: {
    objectKey: manifest.output.objectKey,
    objectBytes: output.size,
    sha256: await fileSha256(outputPath),
    mimeType: "video/mp4",
    width: video.width,
    height: video.height,
    durationMs,
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioCodec: audio.codec_name,
    sampleRateHz: Number(audio.sample_rate),
    channels: Number(audio.channels),
    fullyDecoded: true
  },
  report: {
    schemaVersion: "youtube-audio-rendition-report-v1",
    templateId: manifest.templateId,
    frameRate: video.r_frame_rate,
    fullDecode: true,
    renderWallMs: Date.now() - startedAt
  }
};
await writeFile(
  options.callbackBody,
  `${JSON.stringify(callback, null, 2)}\n`,
  { mode: 0o600 }
);
process.stdout.write(`${JSON.stringify({
  renditionId: manifest.renditionId,
  outputPath,
  outputBytes: output.size,
  outputSha256: callback.output.sha256,
  durationMs,
  callbackBody: options.callbackBody
})}\n`);

function validateProbe(renderManifest, probe) {
  const videos = probe.streams.filter(
    ({ codec_type: type }) => type === "video"
  );
  const audios = probe.streams.filter(
    ({ codec_type: type }) => type === "audio"
  );
  const video = videos[0];
  const audio = audios[0];
  const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
  const tolerance = Math.max(
    1_000,
    Math.round(renderManifest.episode.durationMs * 0.005)
  );
  if (
    videos.length !== 1
    || audios.length !== 1
    || video.codec_name !== "h264"
    || video.pix_fmt !== "yuv420p"
    || video.width !== 1920
    || video.height !== 1080
    || video.r_frame_rate !== "30/1"
    || audio.codec_name !== "aac"
    || Number(audio.sample_rate) !== 48_000
    || Number(audio.channels) !== 2
    || !Number.isSafeInteger(durationMs)
    || Math.abs(durationMs - renderManifest.episode.durationMs) > tolerance
  ) {
    throw new Error("The rendered MP4 does not match its codec contract.");
  }
}

async function fileSha256(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || "").slice(0, 4_000)}`
    );
  }
  return result.stdout;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

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
    || !result.artwork
    || !result.output
    || !result["callback-body"]
  ) {
    usage();
  }
  return {
    manifest: path.resolve(result.manifest),
    source: path.resolve(result.source),
    artwork: path.resolve(result.artwork),
    output: path.resolve(result.output),
    callbackBody: path.resolve(result["callback-body"])
  };
}

function usage() {
  throw new Error(
    "Usage: build-youtube-audio-rendition.mjs --manifest manifest.json "
      + "--source source.audio --artwork artwork --output directory "
      + "--callback-body callback.json"
  );
}
