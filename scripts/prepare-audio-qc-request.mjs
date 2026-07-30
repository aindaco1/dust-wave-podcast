#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STAGING_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
const runId = String(process.env.RUN_ID || "").trim();
const outputFile = process.env.GITHUB_OUTPUT;
if (!IDENTIFIER.test(runId) || runId.length > 160 || !outputFile) {
  throw new Error("Set a valid RUN_ID and GITHUB_OUTPUT.");
}
const workDirectory = path.resolve("work/audio-qc");
await mkdir(workDirectory, { recursive: true, mode: 0o700 });
const manifestRequestPath = path.join(
  workDirectory,
  "manifest-request.json"
);
const sourceRequestPath = path.join(workDirectory, "source-request.json");
await writeFile(
  manifestRequestPath,
  `${JSON.stringify({ runId, action: "manifest" })}\n`,
  { mode: 0o600 }
);
await writeFile(
  sourceRequestPath,
  `${JSON.stringify({ runId, action: "source" })}\n`,
  { mode: 0o600 }
);
await appendFile(
  outputFile,
  [
    `run_id=${runId}`,
    `manifest_url=${STAGING_ORIGIN}/v1/processor/audio-qc/${runId}/manifest`,
    `source_url=${STAGING_ORIGIN}/v1/processor/audio-qc/${runId}/source`,
    `manifest_request=${manifestRequestPath}`,
    `source_request=${sourceRequestPath}`,
    ""
  ].join("\n")
);
