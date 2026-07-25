#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { hmacSha256 } from "@dustwave/worker-core/crypto";
import {
  validateTranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";

const manifestPath = process.argv[2];
const inventoryPath = process.argv[3];
const secret = process.env.MEDIA_PROCESSOR_CALLBACK_SECRET;
if (!manifestPath || !inventoryPath || !secret) {
  throw new Error(
    "Pass manifest/inventory paths and set the processor callback secret."
  );
}
const manifest = await validateTranscriptionChunkProcessorManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  { expectedHost: "dust-wave-podcast-staging.jogo.workers.dev" }
);
const inventory = JSON.parse(
  await readFile(path.resolve(inventoryPath), "utf8")
);
if (
  inventory.runId !== manifest.runId
  || inventory.manifestSha256 !== manifest.manifestSha256
  || !Array.isArray(inventory.chunks)
  || inventory.chunks.length < 1
  || inventory.chunks.length > 256
) {
  throw new Error("The transcription chunk inventory is invalid.");
}
for (let index = 0; index < inventory.chunks.length; index += 1) {
  const chunk = inventory.chunks[index];
  if (
    chunk.chunkIndex !== index
    || !Number.isSafeInteger(chunk.objectBytes)
    || chunk.objectBytes < 1
    || chunk.objectBytes > manifest.output.maximumObjectBytes
    || !/^[a-f0-9]{64}$/.test(chunk.sha256)
  ) {
    throw new Error(`Chunk ${index} upload evidence is invalid.`);
  }
  const payload = {
    runId: manifest.runId,
    chunkIndex: index,
    manifestSha256: manifest.manifestSha256,
    objectBytes: chunk.objectBytes,
    sha256: chunk.sha256
  };
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${encodedPayload}`,
    secret,
    "hex"
  );
  const bytes = await readFile(path.resolve(chunk.localPath));
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(
      manifest.output.uploadUrlTemplate.replace("{index}", String(index)),
      {
        method: "PUT",
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(bytes.byteLength),
          "x-podcast-processor-payload": encodedPayload,
          "x-podcast-processor-timestamp": String(timestamp),
          "x-podcast-processor-signature": signature
        },
        body: bytes
      }
    );
    if (response.ok) break;
    if (attempt === 3 || response.status < 500) break;
  }
  if (!response?.ok) {
    const message = await response?.text().catch(() => "");
    throw new Error(
      `Chunk ${index} upload failed with ${response?.status}: `
      + message.slice(0, 300)
    );
  }
}
