#!/usr/bin/env node

import {
  appendFile,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  validateClipRenderManifest
} from "./lib/clip-render-contract.mjs";

const MAXIMUM_OUTPUT_BYTES = 95 * 1024 * 1024;
const [manifestValue, callbackValue] = process.argv.slice(2);
const outputFile = process.env.GITHUB_OUTPUT;
if (!manifestValue || !callbackValue || !outputFile) {
  throw new Error(
    "Pass manifest/callback JSON paths and set GITHUB_OUTPUT."
  );
}
const manifest = validateClipRenderManifest(
  JSON.parse(await readFile(path.resolve(manifestValue), "utf8"))
);
const callback = JSON.parse(
  await readFile(path.resolve(callbackValue), "utf8")
);
if (
  callback.renderId !== manifest.renderId
  || callback.manifestSha256 !== manifest.manifestSha256
  || callback.status !== "succeeded"
  || callback.output?.objectKey !== manifest.output.objectKey
  || callback.output?.mimeType !== "video/mp4"
  || !/^[a-f0-9]{64}$/.test(String(callback.output?.sha256 || ""))
  || !Number.isSafeInteger(Number(callback.output?.objectBytes))
  || Number(callback.output.objectBytes) < 1
  || Number(callback.output.objectBytes) > MAXIMUM_OUTPUT_BYTES
  || callback.output?.width !== manifest.recipe.outputWidth
  || callback.output?.height !== manifest.recipe.outputHeight
  || !Number.isSafeInteger(Number(callback.output?.durationMs))
  || Math.abs(
    Number(callback.output.durationMs) - manifest.recipe.durationMs
  ) > 250
) {
  throw new Error("The clip callback does not match its upload contract.");
}
const uploadPayload = Buffer.from(
  JSON.stringify({
    action: "upload",
    renderId: manifest.renderId,
    manifestSha256: manifest.manifestSha256,
    objectBytes: callback.output.objectBytes,
    sha256: callback.output.sha256
  }),
  "utf8"
).toString("base64url");
const uploadPayloadPath = path.resolve(
  path.dirname(path.resolve(manifestValue)),
  "upload-payload.txt"
);
await writeFile(uploadPayloadPath, uploadPayload, { mode: 0o600 });
await appendFile(
  outputFile,
  [
    `output_key=${callback.output.objectKey}`,
    `output_bytes=${callback.output.objectBytes}`,
    `output_sha256=${callback.output.sha256}`,
    `manifest_sha256=${manifest.manifestSha256}`,
    `upload_payload=${uploadPayload}`,
    `upload_payload_path=${uploadPayloadPath}`,
    ""
  ].join("\n")
);
