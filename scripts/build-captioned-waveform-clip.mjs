#!/usr/bin/env node

import {
  mkdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  sha256Hex,
  validateClipRenderManifest
} from "./lib/clip-render-contract.mjs";

const MAXIMUM_OUTPUT_BYTES = 95 * 1024 * 1024;
const FRAME_RATE = 30;
const options = parseArguments(process.argv.slice(2));
const manifest = validateClipRenderManifest(
  JSON.parse(await readFile(options.manifest, "utf8"))
);
await mkdir(options.output, { recursive: true });
const source = await stat(options.source);
if (source.size !== manifest.source.objectBytes) {
  throw new Error("The source byte count does not match the clip manifest.");
}

const outputPath = path.join(options.output, "clip.mp4");
const ffmpegVersion = commandOutput("ffmpeg", ["-version"]).split("\n")[0];
const imageCommand = availableImageCommand();
const imageVersion = commandOutput(imageCommand, ["-version"]).split("\n")[0];
const captionFont = availableCaptionFont();
const startedAt = Date.now();
const captionImages = renderCaptionImages(
  manifest,
  options.output,
  imageCommand,
  captionFont
);
renderClip(
  manifest,
  options.source,
  outputPath,
  options.output,
  captionImages
);
const probe = probeClip(outputPath);
validateRenderedClip(manifest, probe);
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
const output = await readFile(outputPath);
if (output.byteLength < 1 || output.byteLength > MAXIMUM_OUTPUT_BYTES) {
  throw new Error("The rendered clip byte count is outside the contract.");
}
const outputSha256 = sha256Hex(output);
const durationMs = Math.round(Number(probe.format.duration) * 1_000);
const video = probe.streams.find(({ codec_type: type }) => type === "video");
const audio = probe.streams.find(({ codec_type: type }) => type === "audio");
const callback = {
  renderId: manifest.renderId,
  manifestSha256: manifest.manifestSha256,
  status: "succeeded",
  processorVersion: `dustwave-clip-renderer-1 (${ffmpegVersion})`,
  output: {
    objectKey: manifest.output.objectKey,
    objectBytes: output.byteLength,
    sha256: outputSha256,
    mimeType: "video/mp4",
    width: video.width,
    height: video.height,
    durationMs
  },
  report: {
    schemaVersion: "clip-render-report-v1",
    templateId: manifest.recipe.templateId,
    aspectRatio: manifest.recipe.aspectRatio,
    captionCueCount: manifest.captions.cues.length,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: Number(audio.channels),
    frameRate: FRAME_RATE,
    imageRenderer: imageVersion,
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
  renderId: manifest.renderId,
  outputPath,
  outputBytes: output.byteLength,
  outputSha256,
  durationMs,
  callbackBody: options.callbackBody
})}\n`);

function renderClip(
  clipManifest,
  sourcePath,
  outputFile,
  workDirectory,
  captionImages
) {
  const recipe = clipManifest.recipe;
  const width = recipe.outputWidth;
  const height = recipe.outputHeight;
  const durationSeconds = seconds(recipe.durationMs);
  const startSeconds = seconds(recipe.startsAtMs);
  const waveformWidth = evenInteger(width * 0.84);
  const waveformHeight = evenInteger(height * 0.22);
  const filterParts = [
    `[0:a]atrim=start=0:end=${durationSeconds},`,
    "asetpts=PTS-STARTPTS,asplit=2[aout][wavein];",
    `color=c=0x101010:s=${width}x${height}:r=${FRAME_RATE}:`,
    `d=${durationSeconds}[background];`,
    `[wavein]showwaves=s=${waveformWidth}x${waveformHeight}:`,
    `mode=cline:colors=0xff5964:r=${FRAME_RATE}:draw=full[wave];`,
    "[background][wave]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1[base0];"
  ];
  captionImages.forEach((caption, index) => {
    const outputLabel = index === captionImages.length - 1
      ? "video"
      : `base${index + 1}`;
    filterParts.push(
      `[base${index}][${index + 1}:v]overlay=0:0:`
        + `enable='between(t,${seconds(caption.startsAtMs)},`
        + `${seconds(caption.endsAtMs)})'[${outputLabel}]`
        + (index === captionImages.length - 1 ? "" : ";")
    );
  });
  const inputArguments = captionImages.flatMap(({ path: captionPath }) => [
    "-loop", "1",
    "-framerate", String(FRAME_RATE),
    "-i", captionPath
  ]);
  run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-y",
    "-ss", startSeconds,
    "-i", sourcePath,
    ...inputArguments,
    "-filter_complex", filterParts.join(""),
    "-map", "[video]",
    "-map", "[aout]",
    "-t", durationSeconds,
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-profile:v", "high",
    "-level:v", "4.2",
    "-pix_fmt", "yuv420p",
    "-r", String(FRAME_RATE),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-shortest",
    outputFile
  ], { cwd: workDirectory });
}

function renderCaptionImages(
  clipManifest,
  workDirectory,
  imageCommand,
  captionFont
) {
  const width = clipManifest.recipe.outputWidth;
  const height = clipManifest.recipe.outputHeight;
  const sideMargin = Math.round(width * 0.08);
  const bottomMargin = Math.round(height * 0.18);
  const captionHeight = Math.round(height * 0.28);
  const captionWidth = width - sideMargin * 2;
  const fontSize = clipManifest.recipe.aspectRatio === "9:16"
    ? 68
    : clipManifest.recipe.aspectRatio === "1:1"
      ? 52
      : 48;
  return clipManifest.captions.cues.map((cue, index) => {
    const speaker = cue.speakerLabel
      ? `${safeImageCaption(cue.speakerLabel)}: `
      : "";
    const text = `${speaker}${safeImageCaption(
      markdownToPlainText(cue.textMarkdown)
    )}`;
    const contentPath = path.join(
      workDirectory,
      `caption-${index}-content.png`
    );
    const captionPath = path.join(workDirectory, `caption-${index}.png`);
    run(imageCommand, [
      "-background", "none",
      "-fill", "white",
      "-stroke", "#101010",
      "-strokewidth", "2",
      "-font", captionFont,
      "-pointsize", String(fontSize),
      "-gravity", "center",
      "-size", `${captionWidth}x${captionHeight}`,
      `caption:${text}`,
      contentPath
    ]);
    run(imageCommand, [
      "-size", `${width}x${height}`,
      "xc:none",
      contentPath,
      "-gravity", "south",
      "-geometry", `+0+${bottomMargin}`,
      "-composite",
      captionPath
    ]);
    return {
      path: captionPath,
      startsAtMs: cue.startsAtMs,
      endsAtMs: cue.endsAtMs
    };
  });
}

function probeClip(outputPath) {
  const raw = commandOutput("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height,"
      + "r_frame_rate,sample_rate,channels",
    "-of", "json",
    outputPath
  ]);
  return JSON.parse(raw);
}

function validateRenderedClip(clipManifest, probe) {
  const videoStreams = probe.streams.filter(
    ({ codec_type: type }) => type === "video"
  );
  const audioStreams = probe.streams.filter(
    ({ codec_type: type }) => type === "audio"
  );
  const video = videoStreams[0];
  const audio = audioStreams[0];
  const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
  if (
    videoStreams.length !== 1
    || audioStreams.length !== 1
    || video.codec_name !== "h264"
    || video.width !== clipManifest.recipe.outputWidth
    || video.height !== clipManifest.recipe.outputHeight
    || video.r_frame_rate !== `${FRAME_RATE}/1`
    || audio.codec_name !== "aac"
    || Number(audio.sample_rate) !== 48_000
    || Number(audio.channels) !== 2
    || !Number.isSafeInteger(durationMs)
    || Math.abs(durationMs - clipManifest.recipe.durationMs) > 250
  ) {
    throw new Error("The rendered MP4 does not match the clip recipe.");
  }
}

function markdownToPlainText(value) {
  return String(value || "")
    .replace(/<\/?u>/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function safeImageCaption(value) {
  return String(value || "")
    .replace(/\\/g, "＼")
    .replace(/%/g, "％")
    .replace(/@/g, "＠")
    .replace(/{/g, "(")
    .replace(/}/g, ")")
    .replace(/\r?\n/g, " ")
    .trim();
}

function seconds(milliseconds) {
  return (Number(milliseconds) / 1_000)
    .toFixed(3)
    .replace(/\.?0+$/, "");
}

function evenInteger(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

function availableImageCommand() {
  for (const candidate of ["magick", "convert"]) {
    const result = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("ImageMagick is required for safe caption rasterization.");
}

function availableCaptionFont() {
  const result = spawnSync(
    "fc-match",
    ["-f", "%{file}\n", "DejaVu Sans:style=Bold"],
    { encoding: "utf8" }
  );
  const fontPath = String(result.stdout || "").trim().split("\n")[0];
  if (
    result.status !== 0
    || !fontPath
    || !path.isAbsolute(fontPath)
  ) {
    throw new Error("A local DejaVu Sans Bold font file is required.");
  }
  return fontPath;
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
    "Usage: build-captioned-waveform-clip.mjs "
      + "--manifest manifest.json --source episode.mp3 "
      + "--output directory --callback-body callback.json\n"
  );
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`
    );
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`
    );
  }
  return String(result.stdout);
}
