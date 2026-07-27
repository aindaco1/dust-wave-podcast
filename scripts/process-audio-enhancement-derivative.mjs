#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createWriteStream
} from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  validateAudioEnhancementDerivativeManifest,
  validateAudioEnhancementDerivativeReport
} from "@dustwave/media-core/audio-enhancement-derivative";

import {
  mediaProcessorSignature
} from "./lib/media-processor-signature.mjs";

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
try {
  const manifestResponse = await signedJsonRequest(
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
  await downloadSignedSource(
    manifest.endpoints.source,
    JSON.stringify({ jobId: derivativeId, action: "source" }),
    sourcePath,
    manifest.source.objectBytes,
    manifest.source.mimeType
  );
  run("node", [
    "scripts/render-audio-enhancement-derivative.mjs",
    "--manifest", manifestPath,
    "--source", sourcePath,
    "--output", outputDirectory,
    "--callback-body", callbackPath
  ], 5 * 60 * 60_000);
  const callback = JSON.parse(await readFile(callbackPath, "utf8"));
  await validateAudioEnhancementDerivativeReport(
    callback.report,
    manifest
  );
  const uploadResult = await uploadParts(
    manifest,
    callback,
    outputPath
  );
  const completion = await signedJsonRequest(
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
  if (manifest) {
    const failure = {
      jobId: derivativeId,
      manifestSha256: manifest.manifestSha256,
      status: "failed",
      failureCode: "processor_failed"
    };
    await signedJsonRequest(
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
  await removePrivateWorkFiles();
  throw error;
}

async function uploadParts(renderManifest, callback, filename) {
  const file = await stat(filename);
  if (
    file.size !== callback.report?.output?.objectBytes
    || callback.jobId !== renderManifest.jobId
    || callback.manifestSha256 !== renderManifest.manifestSha256
    || callback.report?.output?.objectKey
      !== renderManifest.output.objectKey
  ) {
    throw new Error(
      "The local derivative evidence does not match the manifest."
    );
  }
  const partBytes = renderManifest.output.recommendedPartBytes;
  const partCount = Math.ceil(file.size / partBytes);
  const handle = await open(filename, "r");
  try {
    for (let index = 0; index < partCount; index += 1) {
      const length = Math.min(
        partBytes,
        file.size - index * partBytes
      );
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(
        bytes,
        0,
        length,
        index * partBytes
      );
      if (bytesRead !== length) {
        throw new Error(
          "The derivative changed while it was being uploaded."
        );
      }
      const partNumber = index + 1;
      const payload = Buffer.from(JSON.stringify({
        derivativeId: renderManifest.jobId,
        partNumber,
        objectBytes: length,
        sha256: sha256(bytes),
        manifestSha256: renderManifest.manifestSha256
      })).toString("base64url");
      const response = await signedRequest(
        renderManifest.endpoints.partTemplate.replace(
          "{partNumber}",
          String(partNumber)
        ),
        {
          method: "PUT",
          body: bytes,
          signedMessage: payload,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(length),
            "x-podcast-processor-part-payload": payload
          },
          timeoutMs: 10 * 60_000
        }
      );
      const result = await boundedJson(response);
      if (
        result.checksumVerified !== true
        || result.partNumber !== partNumber
        || result.uploadedBytes !== length
      ) {
        throw new Error(
          `Multipart part ${partNumber} was not verified.`
        );
      }
    }
  } finally {
    await handle.close();
  }
  const completed = await signedJsonRequest(
    renderManifest.endpoints.uploadComplete,
    JSON.stringify({
      jobId: renderManifest.jobId,
      action: "upload-complete",
      manifestSha256: renderManifest.manifestSha256,
      objectBytes: callback.report.output.objectBytes,
      outputSha256: callback.report.output.sha256,
      partCount
    }),
    10 * 60_000
  );
  if (
    completed.multipartCompleted !== true
    || completed.objectBytes !== callback.report.output.objectBytes
  ) {
    throw new Error(
      "The multipart derivative was not completed exactly."
    );
  }
  return completed;
}

async function downloadSignedSource(
  url,
  body,
  filename,
  expectedBytes,
  expectedType
) {
  const response = await signedRequest(url, {
    method: "POST",
    body,
    signedMessage: body,
    headers: { "content-type": "application/json" },
    timeoutMs: 30 * 60_000
  });
  if (
    response.headers.get("content-type") !== expectedType
    || Number(response.headers.get("content-length")) !== expectedBytes
    || !response.body
  ) {
    await response.body?.cancel();
    throw new Error(
      "The private source response did not match the manifest."
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(filename, { mode: 0o600 })
  );
  if ((await stat(filename)).size !== expectedBytes) {
    throw new Error(
      "The private source download ended at the wrong byte count."
    );
  }
}

async function signedJsonRequest(url, body, timeoutMs = 30_000) {
  const response = await signedRequest(url, {
    method: "POST",
    body,
    signedMessage: body,
    headers: { "content-type": "application/json" },
    timeoutMs
  });
  return boundedJson(response);
}

async function signedRequest(
  url,
  { method, body, signedMessage, headers, timeoutMs }
) {
  if (!url.startsWith(`${ORIGIN}/`)) {
    throw new Error(
      "Refusing a processor request outside isolated staging."
    );
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const signed = mediaProcessorSignature(signedMessage, secret);
    try {
      const response = await fetch(url, {
        method,
        body,
        headers: {
          ...headers,
          "x-podcast-processor-timestamp": String(signed.timestamp),
          "x-podcast-processor-signature": signed.signature
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) return response;
      const detail = await boundedResponseText(response, 20_000);
      if (response.status < 500 || attempt === 3) {
        throw new Error(
          `Processor request failed (${response.status}): ${detail}`
        );
      }
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
  }
  throw lastError ?? new Error("Processor request failed.");
}

async function boundedJson(response) {
  const text = await boundedResponseText(response, 2_000_000);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The processor response was not a JSON object.");
  }
  return value;
}

async function boundedResponseText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(
        "The processor response exceeded its byte limit."
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
