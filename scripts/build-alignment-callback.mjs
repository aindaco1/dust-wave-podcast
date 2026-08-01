#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MAXIMUM_ALIGNMENT_RESULT_BYTES,
  validateAlignmentProcessorManifest,
  validateAlignmentRunnerResult
} from "@dustwave/timed-text/alignment";

const RUNNER_REVISION = "e611801d2af82dcdb079444b7e8a7eea4309d1a6";
const manifestPath = process.argv[2];
const resultPath = process.argv[3];
const callbackPath = process.argv[4];
const evidencePath = process.argv[5];
if (!manifestPath || !resultPath || !callbackPath || !evidencePath) {
  throw new Error(
    "Pass manifest, result, callback, and evidence paths."
  );
}
const manifest = await validateAlignmentProcessorManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedRunnerRevision: RUNNER_REVISION
  }
);
const resultStats = await stat(path.resolve(resultPath));
if (
  resultStats.size < 1
  || resultStats.size > MAXIMUM_ALIGNMENT_RESULT_BYTES
) {
  throw new Error("The alignment result exceeds its byte contract.");
}
const result = JSON.parse(await readFile(path.resolve(resultPath), "utf8"));
const validated = await validateAlignmentRunnerResult(result, {
  jobId: manifest.jobId,
  alignmentRevisionId: manifest.alignmentRevisionId,
  sourceAudioSha256: manifest.source.sha256,
  sourceDurationMs: manifest.source.durationMs,
  projection: manifest.transcript,
  adapter: manifest.adapter
});
const callback = {
  jobId: manifest.jobId,
  alignmentRevisionId: manifest.alignmentRevisionId,
  processorManifestSha256: manifest.manifestSha256,
  status: "succeeded",
  result
};
const evidence = {
  schemaVersion: "alignment-workflow-evidence-v1",
  jobId: manifest.jobId,
  alignmentRevisionId: manifest.alignmentRevisionId,
  processorManifestSha256: manifest.manifestSha256,
  resultManifestSha256: validated.manifestSha256,
  adapter: {
    name: manifest.adapter.name,
    version: manifest.adapter.version,
    modelVersion: manifest.adapter.modelVersion,
    settingsVersion: manifest.adapter.settingsVersion
  },
  runner: {
    revision: manifest.runner.revision,
    digest: manifest.adapter.runnerDigest
  },
  quality: validated.quality,
  resource: validated.manifest.resource
};
await Promise.all([
  writeFile(
    path.resolve(callbackPath),
    `${JSON.stringify(callback)}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    path.resolve(evidencePath),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 }
  )
]);
