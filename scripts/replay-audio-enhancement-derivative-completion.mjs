#!/usr/bin/env node

import {
  appendFile,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  validateAudioEnhancementDerivativeManifest,
  validateAudioEnhancementDerivativeReport
} from "@dustwave/media-core/audio-enhancement-derivative";

import {
  createStagingMediaProcessorClient
} from "./lib/staging-media-processor-client.mjs";

const ORIGIN = "https://dust-wave-podcast-staging.jogo.workers.dev";
const derivativeId = String(process.env.DERIVATIVE_ID || "");
const secret = String(process.env.MEDIA_PROCESSOR_CALLBACK_SECRET || "");
const githubOutput = process.env.GITHUB_OUTPUT;
if (
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(derivativeId)
  || secret.length < 16
) {
  throw new Error(
    "A valid DERIVATIVE_ID and processor secret are required."
  );
}

const workDirectory = path.resolve("work/audio-enhancement-derivative");
const manifestPath = path.join(workDirectory, "manifest.json");
const callbackPath = path.join(workDirectory, "callback.json");
const processorEvidencePath = path.join(
  workDirectory,
  "processor-evidence.json"
);
const manifest = await validateAudioEnhancementDerivativeManifest(
  JSON.parse(await readFile(manifestPath, "utf8")),
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedBucket: "dustwave-media-staging"
  }
);
const callbackText = await readFile(callbackPath, "utf8");
const callback = JSON.parse(callbackText);
if (
  manifest.jobId !== derivativeId
  || callback.jobId !== derivativeId
  || callback.manifestSha256 !== manifest.manifestSha256
  || callback.status !== "succeeded"
) {
  throw new Error(
    "The retained derivative evidence does not match this job."
  );
}
await validateAudioEnhancementDerivativeReport(
  callback.report,
  manifest
);

const client = createStagingMediaProcessorClient({
  origin: ORIGIN,
  secret
});
const completion = await client.signedJsonRequest(
  manifest.endpoints.evidenceComplete,
  callbackText,
  10 * 60_000
);
const qcRunId = String(completion?.qualityControl?.runId || "");
if (
  completion?.derivative?.status !== "ready"
  || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(qcRunId)
) {
  throw new Error(
    "The Worker did not accept retained derivative evidence."
  );
}
await writeFile(
  processorEvidencePath,
  `${JSON.stringify({
    schemaVersion: "audio-enhancement-derivative-evidence-v1",
    derivativeId,
    status: "ready",
    manifestSha256: manifest.manifestSha256,
    reportSha256: callback.reportSha256,
    outputBytes: callback.report.output.objectBytes,
    outputSha256: callback.report.output.sha256,
    outputDurationMs: callback.report.output.durationMs,
    qcRunId,
    replayed: true
  }, null, 2)}\n`,
  { mode: 0o600 }
);
if (githubOutput) {
  await appendFile(githubOutput, [
    `derivative_id=${derivativeId}`,
    `manifest_sha256=${manifest.manifestSha256}`,
    `qc_run_id=${qcRunId}`,
    "ready=true",
    ""
  ].join("\n"));
}
await Promise.all([
  manifestPath,
  callbackPath
].map((filename) => rm(filename, { force: true }).catch(() => {})));
console.log(JSON.stringify({
  derivativeId,
  status: "ready",
  qcRunId,
  idempotent: Boolean(completion.idempotent)
}));
