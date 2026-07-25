#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  AUDIO_QC_REPORT_SCHEMA,
  audioQcReportSha256,
  evaluateAudioQcMeasurements,
  validateAudioQcManifest
} from "@dustwave/media-core/audio-qc";

const options = parseArguments(process.argv.slice(2));
const manifest = await validateAudioQcManifest(
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
const startedAt = Date.now();
const ffprobeVersion = commandOutput(
  "ffprobe",
  ["-version"]
).split("\n")[0];
const ffmpegVersion = commandOutput(
  "ffmpeg",
  ["-version"]
).split("\n")[0];
const probe = probeAudio(options.source);
const audioStream = probe.streams.filter(
  ({ codec_type: type }) => type === "audio"
);
if (audioStream.length !== 1) {
  throw new Error("The source must contain exactly one audio stream.");
}
const stream = audioStream[0];
const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
  throw new Error("The source duration is invalid.");
}
const analysisLog = analyzeAudio(
  options.source,
  manifest.policy.silenceThresholdDb
);
const loudness = parseLoudness(analysisLog);
const statistics = parseStatistics(analysisLog, Number(stream.channels));
const silence = parseSilence(analysisLog, durationMs);
const samplePeakDbfs = statistics.samplePeakDbfs;
const measurements = {
  durationMs,
  codec: boundedProbeText(stream.codec_name, "codec"),
  container: boundedProbeText(probe.format?.format_name, "container"),
  sampleRateHz: positiveProbeInteger(stream.sample_rate, "sample rate"),
  bitDepth: bitDepth(stream),
  channels: positiveProbeInteger(stream.channels, "channel count"),
  channelLayout: boundedProbeText(
    stream.channel_layout || channelLayout(stream.channels),
    "channel layout"
  ),
  averageBitrateBps: nonNegativeProbeInteger(
    stream.bit_rate || probe.format?.bit_rate || 0,
    "average bitrate"
  ),
  integratedLufs: round(loudness.integratedLufs, 2),
  loudnessRangeLu: round(loudness.loudnessRangeLu, 2),
  truePeakDbtp: round(loudness.truePeakDbtp, 2),
  samplePeakDbfs: round(samplePeakDbfs, 2),
  clippedSamples: samplePeakDbfs >= -0.01
    ? Math.round(statistics.peakCount)
    : 0,
  dcOffset: round(statistics.dcOffset, 6),
  channelImbalanceLu: statistics.channelImbalanceLu === null
    ? null
    : round(statistics.channelImbalanceLu, 2),
  silence
};
const quality = evaluateAudioQcMeasurements(
  measurements,
  manifest.policy
);
const report = {
  schemaVersion: AUDIO_QC_REPORT_SCHEMA,
  runId: manifest.runId,
  manifestSha256: manifest.manifestSha256,
  processorVersion: `dustwave-audio-qc-1 (${ffmpegVersion})`,
  sourceSha256,
  measurements,
  quality,
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
const reportSha256 = await audioQcReportSha256(report, manifest);
const callback = {
  runId: manifest.runId,
  manifestSha256: manifest.manifestSha256,
  status: "succeeded",
  report,
  reportSha256
};
await writeFile(
  options.callbackBody,
  `${JSON.stringify(callback, null, 2)}\n`,
  { mode: 0o600 }
);
process.stdout.write(`${JSON.stringify({
  runId: manifest.runId,
  reportSha256,
  sourceSha256,
  blockerCount: quality.blockerCount,
  warningCount: quality.warningCount,
  durationMs,
  callbackBody: path.resolve(options.callbackBody)
})}\n`);

function probeAudio(sourcePath) {
  return JSON.parse(commandOutput("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration,size,bit_rate,format_name:"
      + "stream=index,codec_type,codec_name,sample_fmt,sample_rate,"
      + "channels,channel_layout,bit_rate,bits_per_sample,bits_per_raw_sample",
    "-of", "json",
    sourcePath
  ]));
}

async function sha256File(sourcePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function analyzeAudio(sourcePath, silenceThresholdDb) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-i", sourcePath,
    "-af",
    "ebur128=peak=true:framelog=verbose,"
      + "astats=metadata=1:reset=0,"
      + `silencedetect=noise=${silenceThresholdDb}dB:d=1`,
    "-f", "null",
    "-"
  ], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 6 * 60 * 60 * 1_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `FFmpeg audio analysis failed: ${boundedProcessError(result)}`
    );
  }
  return result.stderr;
}

function parseLoudness(log) {
  const summaryIndex = log.lastIndexOf("Integrated loudness:");
  const summary = summaryIndex >= 0 ? log.slice(summaryIndex) : log;
  return {
    integratedLufs: finiteMatch(
      summary,
      /\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS/
    ),
    loudnessRangeLu: finiteMatch(
      summary,
      /\bLRA:\s*(-?\d+(?:\.\d+)?)\s+LU/
    ),
    truePeakDbtp: finiteMatch(
      summary,
      /\bPeak:\s*(-?\d+(?:\.\d+)?)\s+dB(?:FS|TP)/
    )
  };
}

function parseStatistics(log, channelCount) {
  const channelSections = log.split(/\bChannel:\s+\d+\s*\n/).slice(1);
  const channelRms = channelSections
    .slice(0, channelCount)
    .map((section) => finiteMatch(section, /RMS level dB:\s*(-?\d+(?:\.\d+)?)/));
  const allDcOffsets = matchNumbers(log, /DC offset:\s*(-?\d+(?:\.\d+)?)/g);
  const allSamplePeaks = matchNumbers(
    log,
    /Peak level dB:\s*(-?\d+(?:\.\d+)?)/g
  );
  const allPeakCounts = matchNumbers(
    log,
    /\bPeak count:\s*(\d+(?:\.\d+)?)/g
  );
  if (
    allDcOffsets.length < 1
    || allSamplePeaks.length < 1
    || allPeakCounts.length < 1
  ) {
    throw new Error("FFmpeg did not return complete sample statistics.");
  }
  const imbalance = channelRms.length > 1
    ? Math.max(...channelRms) - Math.min(...channelRms)
    : null;
  return {
    dcOffset: allDcOffsets.at(-1),
    samplePeakDbfs: allSamplePeaks.at(-1),
    peakCount: allPeakCounts.at(-1),
    channelImbalanceLu: imbalance
  };
}

function parseSilence(log, durationMs) {
  const events = [...log.matchAll(
    /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g
  )].map((match) => ({
    type: match[1],
    milliseconds: Math.max(
      0,
      Math.min(durationMs, Math.round(Number(match[2]) * 1_000))
    )
  }));
  const rawRegions = [];
  let start = null;
  for (const event of events) {
    if (event.type === "start") {
      if (start === null) start = event.milliseconds;
      continue;
    }
    if (start !== null && event.milliseconds > start) {
      rawRegions.push({ startMs: start, endMs: event.milliseconds });
      start = null;
    }
  }
  if (start !== null && durationMs > start) {
    rawRegions.push({ startMs: start, endMs: durationMs });
  }
  const regions = rawRegions.map(({ startMs, endMs }) => {
    const kind = startMs <= 5 && endMs >= durationMs - 5
      ? "entire"
      : startMs <= 5
        ? "leading"
        : endMs >= durationMs - 5
          ? "trailing"
          : "internal";
    return {
      kind,
      startMs,
      endMs,
      durationMs: endMs - startMs
    };
  });
  const leading = regions.find(({ kind }) =>
    kind === "leading" || kind === "entire"
  );
  const trailing = [...regions].reverse().find(({ kind }) =>
    kind === "trailing" || kind === "entire"
  );
  const internalDurations = regions
    .filter(({ kind }) => kind === "internal")
    .map(({ durationMs: regionDuration }) => regionDuration);
  return {
    leadingMs: leading?.durationMs ?? 0,
    trailingMs: trailing?.durationMs ?? 0,
    longestInternalMs: internalDurations.length
      ? Math.max(...internalDurations)
      : null,
    regions
  };
}

function bitDepth(stream) {
  for (const value of [
    stream.bits_per_raw_sample,
    stream.bits_per_sample
  ]) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 64) {
      return parsed;
    }
  }
  const match = String(stream.sample_fmt || "").match(/(?:s|u|flt|dbl)(\d+)/);
  return match ? Number(match[1]) : null;
}

function channelLayout(channels) {
  return Number(channels) === 1
    ? "mono"
    : Number(channels) === 2
      ? "stereo"
      : `${channels} channels`;
}

function finiteMatch(value, pattern) {
  const match = String(value).match(pattern);
  const number = Number(match?.[1]);
  if (!Number.isFinite(number)) {
    throw new Error("FFmpeg did not return a finite audio measurement.");
  }
  return number;
}

function matchNumbers(value, pattern) {
  return [...String(value).matchAll(pattern)].map((match) => {
    const number = Number(match[1]);
    if (!Number.isFinite(number)) {
      throw new Error("FFmpeg returned a non-finite sample statistic.");
    }
    return number;
  });
}

function boundedProbeText(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`The probed ${field} is invalid.`);
  }
  return text;
}

function positiveProbeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`The probed ${field} is invalid.`);
  }
  return number;
}

function nonNegativeProbeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`The probed ${field} is invalid.`);
  }
  return number;
}

function round(value, digits) {
  return Number(Number(value).toFixed(digits));
}

function commandOutput(command, argumentsValue) {
  const result = spawnSync(command, argumentsValue, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${boundedProcessError(result)}`);
  }
  return result.stdout;
}

function boundedProcessError(result) {
  return String(result.stderr || result.error?.message || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function parseArguments(argumentsValue) {
  const options = {
    manifest: "",
    source: "",
    callbackBody: "",
    allowFixtureOrigin: false
  };
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--allow-fixture-origin") {
      options.allowFixtureOrigin = true;
    } else if (argument === "--manifest") {
      options.manifest = path.resolve(argumentsValue[++index] || "");
    } else if (argument === "--source") {
      options.source = path.resolve(argumentsValue[++index] || "");
    } else if (argument === "--callback-body") {
      options.callbackBody = path.resolve(argumentsValue[++index] || "");
    } else {
      throw new Error(`Unknown audio QC argument: ${argument}`);
    }
  }
  if (!options.manifest || !options.source || !options.callbackBody) {
    throw new Error(
      "Pass --manifest, --source, and --callback-body."
    );
  }
  return options;
}
