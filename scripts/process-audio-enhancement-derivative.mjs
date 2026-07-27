#!/usr/bin/env node

import {
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const client = createStagingMediaProcessorClient({
  origin: ORIGIN,
  secret
});

const workDirectory = path.resolve(
  "work/audio-enhancement-derivative"
);
const manifestPath = path.join(workDirectory, "manifest.json");
const sourcePath = path.join(workDirectory, "source.audio");
const outputDirectory = path.join(workDirectory, "output");
const outputPath = path.join(outputDirectory, "enhanced.mp3");
const callbackPath = path.join(workDirectory, "callback.json");
const processorEvidencePath = path.join(
  workDirectory,
  "processor-evidence.json"
);
const processorBase =
  `${ORIGIN}/v1/processor/audio-enhancement-derivatives/`
  + derivativeId;
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

let manifest;
let callback;
let multipartCompleted = false;
try {
  const manifestResponse = await client.signedJsonRequest(
    `${processorBase}/manifest`,
    JSON.stringify({ jobId: derivativeId, action: "manifest" })
  );
  manifest = await validateAudioEnhancementDerivativeManifest(
    manifestResponse.processorManifest,
    {
      expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
      expectedBucket: "dustwave-media-staging"
    }
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  await client.downloadSignedSource({
    url: manifest.endpoints.source,
    body: JSON.stringify({ jobId: derivativeId, action: "source" }),
    filename: sourcePath,
    expectedBytes: manifest.source.objectBytes,
    expectedType: manifest.source.mimeType
  });
  run("node", [
    "scripts/render-audio-enhancement-derivative.mjs",
    "--manifest", manifestPath,
    "--source", sourcePath,
    "--output", outputDirectory,
    "--callback-body", callbackPath
  ], 5 * 60 * 60_000);
  callback = JSON.parse(await readFile(callbackPath, "utf8"));
  await validateAudioEnhancementDerivativeReport(
    callback.report,
    manifest
  );
  const uploadResult = await client.uploadMultipartFile({
    manifest,
    filename: outputPath,
    output: callback.report.output,
    partIdentity: { derivativeId }
  });
  multipartCompleted = true;
  const completion = await client.signedJsonRequest(
    manifest.endpoints.evidenceComplete,
    JSON.stringify(callback)
  );
  const qcRunId = String(completion?.qualityControl?.runId || "");
  if (
    completion?.derivative?.status !== "ready"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(qcRunId)
  ) {
    throw new Error(
      "The Worker did not accept ready derivative and QC evidence."
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
      uploadedBytes: uploadResult.objectBytes,
      qcRunId
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (githubOutput) {
    await appendFile(githubOutput, [
      `derivative_id=${derivativeId}`,
      `manifest_sha256=${manifest.manifestSha256}`,
      `output_bytes=${callback.report.output.objectBytes}`,
      `output_sha256=${callback.report.output.sha256}`,
      `qc_run_id=${qcRunId}`,
      "ready=true",
      ""
    ].join("\n"));
  }
  await removePrivateWorkFiles();
} catch (error) {
  if (manifest && !multipartCompleted) {
    const failure = {
      jobId: derivativeId,
      manifestSha256: manifest.manifestSha256,
      status: "failed",
      failureCode: "processor_failed"
    };
    await client.signedJsonRequest(
      manifest.endpoints.evidenceComplete,
      JSON.stringify(failure)
    ).catch(() => {});
    await writeFile(
      processorEvidencePath,
      `${JSON.stringify({
        schemaVersion: "audio-enhancement-derivative-evidence-v1",
        derivativeId,
        status: "failed",
        manifestSha256: manifest.manifestSha256,
        failureCode: failure.failureCode
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  if (manifest && multipartCompleted && callback) {
    await writeFile(
      processorEvidencePath,
      `${JSON.stringify({
        schemaVersion: "audio-enhancement-derivative-evidence-v1",
        derivativeId,
        status: "completion_pending",
        manifestSha256: manifest.manifestSha256,
        reportSha256: callback.reportSha256,
        outputBytes: callback.report?.output?.objectBytes ?? null,
        outputSha256: callback.report?.output?.sha256 ?? null
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  await removePrivateWorkFiles({
    preserveCompletionEvidence: multipartCompleted
  });
  throw error;
}

function run(command, args, timeout) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

async function removePrivateWorkFiles({
  preserveCompletionEvidence = false
} = {}) {
  const privateFiles = [
    sourcePath,
    outputPath
  ];
  if (!preserveCompletionEvidence) {
    privateFiles.push(manifestPath, callbackPath);
  }
  await Promise.all(privateFiles.map(
    (filename) => rm(filename, { force: true }).catch(() => {})
  ));
}
