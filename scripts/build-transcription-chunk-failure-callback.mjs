#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateTranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";

const manifestPath = process.argv[2];
const outputPath = process.argv[3];
if (!manifestPath || !outputPath) {
  throw new Error("Pass manifest and failure callback paths.");
}
const manifest = await validateTranscriptionChunkProcessorManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  { expectedHost: "dust-wave-podcast-staging.jogo.workers.dev" }
);
await writeFile(
  path.resolve(outputPath),
  `${JSON.stringify({
    runId: manifest.runId,
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256,
    status: "failed",
    failureCode: "processor_failed"
  }, null, 2)}\n`,
  { mode: 0o600 }
);
