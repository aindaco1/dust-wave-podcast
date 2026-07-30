#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STAGING_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
const jobId = String(process.env.JOB_ID || "").trim();
const outputFile = process.env.GITHUB_OUTPUT;
if (
  !IDENTIFIER.test(jobId)
  || jobId.length > 128
  || !outputFile
) {
  throw new Error("Set a valid JOB_ID and GITHUB_OUTPUT.");
}
const workDirectory = path.resolve("work/alignment");
await mkdir(workDirectory, { recursive: true, mode: 0o700 });
const manifestRequestPath = path.join(
  workDirectory,
  "manifest-request.json"
);
const sourceRequestPath = path.join(workDirectory, "source-request.json");
await Promise.all([
  writeFile(
    manifestRequestPath,
    `${JSON.stringify({ jobId, action: "manifest" })}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    sourceRequestPath,
    `${JSON.stringify({ jobId, action: "source" })}\n`,
    { mode: 0o600 }
  )
]);
await appendFile(
  outputFile,
  [
    `job_id=${jobId}`,
    `manifest_url=${STAGING_ORIGIN}/v1/processor/`
      + `alignments/${jobId}/manifest`,
    `source_url=${STAGING_ORIGIN}/v1/processor/`
      + `alignments/${jobId}/source`,
    ""
  ].join("\n")
);
