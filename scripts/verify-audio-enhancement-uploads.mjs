#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const [callbackValue, originalValue, enhancedValue] =
  process.argv.slice(2);
if (!callbackValue || !originalValue || !enhancedValue) {
  throw new Error(
    "Pass callback, original response, and enhanced response paths."
  );
}
const callback = JSON.parse(
  await readFile(path.resolve(callbackValue), "utf8")
);
for (const [kind, responseValue] of [
  ["original", originalValue],
  ["enhanced", enhancedValue]
]) {
  const response = JSON.parse(
    await readFile(path.resolve(responseValue), "utf8")
  );
  const output = callback.report?.outputs?.[kind];
  if (
    callback.status !== "succeeded"
    || response.checksumVerified !== true
    || response.object?.kind !== kind
    || response.object?.objectBytes !== output?.objectBytes
    || response.object?.sha256 !== output?.sha256
    || response.object?.mimeType !== "audio/mpeg"
    || response.object?.manifestSha256 !== callback.manifestSha256
  ) {
    throw new Error(
      `The private ${kind} preview upload evidence is incomplete.`
    );
  }
}
process.stdout.write(`${JSON.stringify({
  jobId: callback.jobId,
  manifestSha256: callback.manifestSha256,
  uploadsVerified: true
})}\n`);
