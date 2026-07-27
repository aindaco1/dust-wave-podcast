#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  createHash,
  createHmac
} from "node:crypto";
import {
  createWriteStream
} from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  validateYouTubeAudioRenditionManifest,
  YOUTUBE_AUDIO_RENDITION_ORIGIN
} from "./lib/youtube-audio-rendition-contract.mjs";

const renditionId = String(process.env.RENDITION_ID || "");
const secret = String(process.env.MEDIA_PROCESSOR_CALLBACK_SECRET || "");
const githubOutput = process.env.GITHUB_OUTPUT;
if (
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(renditionId)
  || secret.length < 16
) {
  throw new Error(
    "A valid RENDITION_ID and MEDIA_PROCESSOR_CALLBACK_SECRET are required."
  );
}

const workDirectory = path.resolve("work/youtube-audio-rendition");
const manifestPath = path.join(workDirectory, "manifest.json");
const sourcePath = path.join(workDirectory, "source.audio");
const artworkPath = path.join(workDirectory, "artwork");
const outputDirectory = path.join(workDirectory, "output");
const outputPath = path.join(outputDirectory, "episode.mp4");
const callbackPath = path.join(workDirectory, "callback.json");
const uploadResponsePath = path.join(workDirectory, "upload-response.json");
const processorBase = [
  YOUTUBE_AUDIO_RENDITION_ORIGIN,
  "v1",
  "processor",
  "youtube-audio-renditions",
  renditionId
].join("/");
await mkdir(outputDirectory, { recursive: true });

let manifest;
try {
  const manifestRequest = JSON.stringify({
    renditionId,
    action: "manifest"
  });
  const manifestResponse = await signedJsonRequest(
    `${processorBase}/manifest`,
    manifestRequest
  );
  manifest = validateYouTubeAudioRenditionManifest(
    manifestResponse.processorManifest
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  await Promise.all([
    downloadSignedSource(
      manifest.endpoints.audioSource,
      JSON.stringify({ renditionId, action: "source:audio" }),
      sourcePath,
      manifest.source.objectBytes,
      manifest.source.mimeType
    ),
    downloadSignedSource(
      manifest.endpoints.artworkSource,
      JSON.stringify({ renditionId, action: "source:artwork" }),
      artworkPath,
      manifest.artwork.objectBytes,
      manifest.artwork.mimeType
    )
  ]);
  run("node", [
    "scripts/build-youtube-audio-rendition.mjs",
    "--manifest", manifestPath,
    "--source", sourcePath,
    "--artwork", artworkPath,
    "--output", outputDirectory,
    "--callback-body", callbackPath
  ], 5 * 60 * 60_000);
  const callback = JSON.parse(await readFile(callbackPath, "utf8"));
  const uploadResult = await uploadParts(manifest, callback, outputPath);
  await writeFile(
    uploadResponsePath,
    `${JSON.stringify(uploadResult, null, 2)}\n`,
    { mode: 0o600 }
  );
  const completion = await signedJsonRequest(
    manifest.endpoints.evidenceComplete,
    JSON.stringify(callback)
  );
  if (completion?.rendition?.status !== "ready") {
    throw new Error("The Worker did not accept ready rendition evidence.");
  }
  if (githubOutput) {
    await appendFile(githubOutput, [
      `rendition_id=${renditionId}`,
      `manifest_sha256=${manifest.manifestSha256}`,
      `output_bytes=${callback.output.objectBytes}`,
      `output_sha256=${callback.output.sha256}`,
      "ready=true",
      ""
    ].join("\n"));
  }
} catch (error) {
  if (manifest) {
    const failure = {
      renditionId,
      manifestSha256: manifest.manifestSha256,
      status: "failed",
      processorVersion: "dustwave-youtube-audio-renderer-1",
      failureCode: "processor_failed",
      report: {
        schemaVersion: "youtube-audio-rendition-report-v1",
        failed: true,
        error: boundedError(error)
      }
    };
    await signedJsonRequest(
      manifest.endpoints.evidenceComplete,
      JSON.stringify(failure)
    ).catch(() => {});
    await writeFile(
      path.join(workDirectory, "failure-callback.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  throw error;
}

async function uploadParts(renderManifest, callback, filename) {
  const file = await stat(filename);
  if (
    file.size !== callback.output.objectBytes
    || callback.renditionId !== renderManifest.renditionId
    || callback.manifestSha256 !== renderManifest.manifestSha256
    || callback.output.objectKey !== renderManifest.output.objectKey
  ) {
    throw new Error("The local render evidence does not match the manifest.");
  }
  const partBytes = renderManifest.output.recommendedPartBytes;
  const partCount = Math.ceil(file.size / partBytes);
  const handle = await open(filename, "r");
  try {
    for (let index = 0; index < partCount; index += 1) {
      const length = Math.min(partBytes, file.size - index * partBytes);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(
        bytes,
        0,
        length,
        index * partBytes
      );
      if (bytesRead !== length) {
        throw new Error("The rendered output changed while being uploaded.");
      }
      const partNumber = index + 1;
      const payload = Buffer.from(JSON.stringify({
        renditionId: renderManifest.renditionId,
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
        !result.checksumVerified
        || result.partNumber !== partNumber
        || result.uploadedBytes !== length
      ) {
        throw new Error(`Multipart part ${partNumber} was not verified.`);
      }
    }
  } finally {
    await handle.close();
  }
  const completeBody = JSON.stringify({
    renditionId: renderManifest.renditionId,
    action: "upload-complete",
    manifestSha256: renderManifest.manifestSha256,
    objectBytes: callback.output.objectBytes,
    outputSha256: callback.output.sha256,
    partCount
  });
  const completed = await signedJsonRequest(
    renderManifest.endpoints.uploadComplete,
    completeBody,
    10 * 60_000
  );
  if (
    completed.multipartCompleted !== true
    || completed.objectBytes !== callback.output.objectBytes
  ) {
    throw new Error("The multipart output was not completed exactly.");
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
    headers: {
      "content-type": "application/json"
    },
    timeoutMs: 15 * 60_000
  });
  if (
    response.headers.get("content-type") !== expectedType
    || Number(response.headers.get("content-length")) !== expectedBytes
    || !response.body
  ) {
    await response.body?.cancel();
    throw new Error("A private source response did not match the manifest.");
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(filename, { mode: 0o600 })
  );
  if ((await stat(filename)).size !== expectedBytes) {
    throw new Error("A private source download ended at the wrong byte count.");
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
  if (!url.startsWith(`${YOUTUBE_AUDIO_RENDITION_ORIGIN}/`)) {
    throw new Error("Refusing a processor request outside isolated staging.");
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${signedMessage}`)
      .digest("hex");
    try {
      const response = await fetch(url, {
        method,
        body,
        headers: {
          ...headers,
          "x-podcast-processor-timestamp": String(timestamp),
          "x-podcast-processor-signature": signature
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
      throw new Error("The processor response exceeded its byte limit.");
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

function boundedError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}
