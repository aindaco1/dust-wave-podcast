#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateAlignmentProcessorManifest
} from "@dustwave/timed-text/alignment";

const RUNNER_REVISION = "3c5ab054fdad375901eb186f32d7aed6cdb40413";
const responsePath = process.argv[2];
const outputFile = process.env.GITHUB_OUTPUT;
if (!responsePath || !outputFile) {
  throw new Error("Pass the manifest response path and set GITHUB_OUTPUT.");
}
const raw = await readFile(path.resolve(responsePath), "utf8");
if (Buffer.byteLength(raw, "utf8") > 5 * 1024 * 1024) {
  throw new Error("The alignment processor manifest response is too large.");
}
const response = JSON.parse(raw);
const manifest = await validateAlignmentProcessorManifest(
  response.processorManifest,
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedRunnerRevision: RUNNER_REVISION
  }
);
const workDirectory = path.resolve("work/alignment");
const manifestPath = path.join(workDirectory, "manifest.json");
const runnerRequestPath = path.join(workDirectory, "runner-request.json");
const runnerRequest = {
  schemaVersion: "2",
  jobId: manifest.jobId,
  alignmentRevisionId: manifest.alignmentRevisionId,
  language: manifest.language,
  audio: {
    path: "source.audio",
    sha256: manifest.source.sha256,
    durationMs: manifest.source.durationMs
  },
  transcript: {
    contentSha256: manifest.transcript.contentSha256,
    projectionSha256: manifest.transcript.projectionSha256,
    cues: manifest.transcript.cues
  },
  adapter: {
    name: manifest.adapter.name,
    model: manifest.adapter.model,
    modelVersion: manifest.adapter.modelVersion,
    settingsVersion: manifest.adapter.settingsVersion
  }
};
await Promise.all([
  writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  ),
  writeFile(
    runnerRequestPath,
    `${JSON.stringify(runnerRequest, null, 2)}\n`,
    { mode: 0o600 }
  )
]);
await appendFile(
  outputFile,
  [
    `job_id=${manifest.jobId}`,
    `adapter=${manifest.adapter.name}`,
    `runner_revision=${manifest.runner.revision}`,
    `runner_digest=${manifest.adapter.runnerDigest}`,
    `callback_url=${manifest.callbackUrl}`,
    `manifest_sha256=${manifest.manifestSha256}`,
    ""
  ].join("\n")
);
