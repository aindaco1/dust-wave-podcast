#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  validateTranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";

import {
  createStagingMediaProcessorClient
} from "./lib/staging-media-processor-client.mjs";

const STAGING_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
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
  { expectedHost: new URL(STAGING_ORIGIN).host }
);
const client = createStagingMediaProcessorClient({
  origin: STAGING_ORIGIN,
  secret
});
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
  const bytes = await readFile(path.resolve(chunk.localPath));
  const result = client.signedBinaryPut({
    url: manifest.output.uploadUrlTemplate.replace(
      "{index}",
      String(index)
    ),
    bytes,
    signedMessage: encodedPayload,
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(bytes.byteLength),
      "x-podcast-processor-payload": encodedPayload
    }
  });
  if (
    result.checksumVerified !== true
    || result.object?.chunkIndex !== index
    || result.object?.objectBytes !== bytes.byteLength
    || result.object?.sha256 !== chunk.sha256
    || result.object?.mimeType !== "audio/mpeg"
  ) {
    throw new Error(
      `Chunk ${index} upload evidence did not match its checksum contract.`
    );
  }
}
