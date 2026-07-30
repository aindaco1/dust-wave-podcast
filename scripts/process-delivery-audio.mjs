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
  deliveryAudioReportSha256,
  playerPeaksSha256,
  validateDeliveryAudioManifest,
  validateDeliveryAudioReport,
  validatePlayerPeaksDocument
} from "@dustwave/media-core/delivery-audio";

import {
  createStagingMediaProcessorClient
} from "./lib/staging-media-processor-client.mjs";

const ORIGIN = "https://dust-wave-podcast-staging.jogo.workers.dev";
const jobId = String(process.env.DELIVERY_AUDIO_JOB_ID || "");
const secret = String(process.env.MEDIA_PROCESSOR_CALLBACK_SECRET || "");
const githubOutput = process.env.GITHUB_OUTPUT;
if (
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(jobId)
  || secret.length < 16
) {
  throw new Error(
    "A valid DELIVERY_AUDIO_JOB_ID and processor secret are required."
  );
}

const client = createStagingMediaProcessorClient({
  origin: ORIGIN,
  secret
});
const workDirectory = path.resolve("work/delivery-audio");
const manifestPath = path.join(workDirectory, "manifest.json");
const sourcePath = path.join(workDirectory, "source.audio");
const outputDirectory = path.join(workDirectory, "output");
const outputPath = path.join(outputDirectory, "delivery.mp3");
const callbackPath = path.join(workDirectory, "callback.json");
const processorEvidencePath = path.join(
  workDirectory,
  "processor-evidence.json"
);
const processorBase =
  `${ORIGIN}/v1/processor/delivery-audio-jobs/${jobId}`;
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

let manifest;
try {
  const manifestResponse = await client.signedJsonRequest(
    `${processorBase}/manifest`,
    JSON.stringify({ jobId, action: "manifest" })
  );
  manifest = await validateDeliveryAudioManifest(
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
    body: JSON.stringify({ jobId, action: "source" }),
    filename: sourcePath,
    expectedBytes: manifest.source.objectBytes,
    expectedType: manifest.source.mimeType
  });
  run("node", [
    "scripts/render-delivery-audio.mjs",
    "--manifest", manifestPath,
    "--source", sourcePath,
    "--output", outputDirectory,
    "--callback-body", callbackPath
  ], 5 * 60 * 60_000);

  const callback = JSON.parse(await readFile(callbackPath, "utf8"));
  const report = await validateDeliveryAudioReport(
    callback.report,
    manifest
  );
  const peaks = validatePlayerPeaksDocument(callback.peaks);
  if (
    callback.reportSha256
      !== await deliveryAudioReportSha256(report, manifest)
    || report.peaks.sha256 !== await playerPeaksSha256(peaks)
  ) {
    throw new Error("The local delivery evidence digest is invalid.");
  }
  const uploadResult = await client.uploadMultipartFile({
    manifest,
    filename: outputPath,
    output: report.audio,
    partIdentity: { jobId }
  });
  const completion = await client.signedJsonRequest(
    manifest.endpoints.evidenceComplete,
    JSON.stringify(callback)
  );
  if (
    completion?.job?.status !== "ready"
    || completion?.job?.id !== jobId
  ) {
    throw new Error(
      "The Worker did not accept ready delivery-audio evidence."
    );
  }
  await writeFile(
    processorEvidencePath,
    `${JSON.stringify({
      schemaVersion: "delivery-audio-evidence-v1",
      jobId,
      status: "ready",
      manifestSha256: manifest.manifestSha256,
      reportSha256: callback.reportSha256,
      outputBytes: report.audio.objectBytes,
      outputSha256: report.audio.sha256,
      outputDurationMs: report.audio.durationMs,
      frameCount: report.audio.frameCount,
      uploadedBytes: uploadResult.objectBytes,
      peaksSha256: report.peaks.sha256,
      peaksLength: report.peaks.length
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (githubOutput) {
    await appendFile(githubOutput, [
      `job_id=${jobId}`,
      `manifest_sha256=${manifest.manifestSha256}`,
      `output_bytes=${report.audio.objectBytes}`,
      `output_sha256=${report.audio.sha256}`,
      `peaks_sha256=${report.peaks.sha256}`,
      `peaks_length=${report.peaks.length}`,
      "ready=true",
      ""
    ].join("\n"));
  }
  await removePrivateWorkFiles();
} catch (error) {
  if (manifest) {
    const failure = {
      jobId,
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
        schemaVersion: "delivery-audio-evidence-v1",
        jobId,
        status: "failed",
        manifestSha256: manifest.manifestSha256,
        failureCode: failure.failureCode
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  await removePrivateWorkFiles();
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

async function removePrivateWorkFiles() {
  await Promise.all([
    manifestPath,
    sourcePath,
    outputPath,
    callbackPath
  ].map((filename) => rm(filename, { force: true }).catch(() => {})));
}
