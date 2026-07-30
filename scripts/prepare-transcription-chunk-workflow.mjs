#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateTranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";

const responsePath = process.argv[2];
const outputFile = process.env.GITHUB_OUTPUT;
if (!responsePath || !outputFile) {
  throw new Error("Pass the manifest response path and set GITHUB_OUTPUT.");
}
const raw = await readFile(path.resolve(responsePath), "utf8");
if (Buffer.byteLength(raw, "utf8") > 100_000) {
  throw new Error("The transcription chunk manifest response is too large.");
}
const response = JSON.parse(raw);
const manifest = await validateTranscriptionChunkProcessorManifest(
  response.processorManifest,
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev"
  }
);
const manifestPath = path.resolve(
  "work/transcription-chunks/manifest.json"
);
await writeFile(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 }
);
await appendFile(
  outputFile,
  [
    `run_id=${manifest.runId}`,
    `job_id=${manifest.jobId}`,
    `manifest_sha256=${manifest.manifestSha256}`,
    `callback_url=${manifest.callbackUrl}`,
    `manifest_path=${manifestPath}`,
    ""
  ].join("\n")
);
