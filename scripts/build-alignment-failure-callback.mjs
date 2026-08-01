#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateAlignmentProcessorManifest
} from "@dustwave/timed-text/alignment";

const RUNNER_REVISION = "e611801d2af82dcdb079444b7e8a7eea4309d1a6";
const manifestPath = process.argv[2];
const outputPath = process.argv[3];
if (!manifestPath || !outputPath) {
  throw new Error("Pass manifest and failure callback paths.");
}
const manifest = await validateAlignmentProcessorManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedRunnerRevision: RUNNER_REVISION
  }
);
await writeFile(
  path.resolve(outputPath),
  `${JSON.stringify({
    jobId: manifest.jobId,
    alignmentRevisionId: manifest.alignmentRevisionId,
    processorManifestSha256: manifest.manifestSha256,
    status: "failed",
    failureCode: "processor_failed"
  })}\n`,
  { mode: 0o600 }
);
