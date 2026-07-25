#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STAGING_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
const jobId = String(process.env.JOB_ID || "").trim();
const outputFile = process.env.GITHUB_OUTPUT;
if (!IDENTIFIER.test(jobId) || jobId.length > 160 || !outputFile) {
  throw new Error("Set a valid JOB_ID and GITHUB_OUTPUT.");
}
const workDirectory = path.resolve("work/audio-enhancement");
await mkdir(workDirectory, { recursive: true, mode: 0o700 });
const manifestRequestPath = path.join(
  workDirectory,
  "manifest-request.json"
);
const sourceRequestPath = path.join(workDirectory, "source-request.json");
await writeFile(
  manifestRequestPath,
  `${JSON.stringify({ jobId, action: "manifest" })}\n`,
  { mode: 0o600 }
);
await writeFile(
  sourceRequestPath,
  `${JSON.stringify({ jobId, action: "source" })}\n`,
  { mode: 0o600 }
);
const processorBaseUrl =
  `${STAGING_ORIGIN}/v1/processor/audio-enhancements/${jobId}`;
await appendFile(
  outputFile,
  [
    `job_id=${jobId}`,
    `manifest_url=${processorBaseUrl}/manifest`,
    `source_url=${processorBaseUrl}/source`,
    `original_output_url=${processorBaseUrl}/outputs/original`,
    `enhanced_output_url=${processorBaseUrl}/outputs/enhanced`,
    ""
  ].join("\n")
);
