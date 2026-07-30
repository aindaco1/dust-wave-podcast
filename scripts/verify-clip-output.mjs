#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const [callbackValue, responseValue] = process.argv.slice(2);
if (!callbackValue || !responseValue) {
  throw new Error(
    "Usage: verify-clip-output.mjs callback.json upload-response.json"
  );
}
const callback = JSON.parse(
  await readFile(path.resolve(callbackValue), "utf8")
);
const response = JSON.parse(
  await readFile(path.resolve(responseValue), "utf8")
);
if (
  callback.status !== "succeeded"
  || response.checksumVerified !== true
  || response.object?.objectKey !== callback.output.objectKey
  || response.object?.objectBytes !== callback.output.objectBytes
  || response.object?.sha256 !== callback.output.sha256
  || response.object?.mimeType !== "video/mp4"
  || response.object?.manifestSha256 !== callback.manifestSha256
) {
  throw new Error("The private R2 output evidence is incomplete.");
}
process.stdout.write(`${JSON.stringify({
  objectBytes: response.object.objectBytes,
  contentType: response.object.mimeType,
  checksumSha256: response.object.sha256,
  manifestSha256: response.object.manifestSha256
})}\n`);
