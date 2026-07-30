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

const responsePath = process.argv[2];
const outputFile = process.env.GITHUB_OUTPUT;
if (!responsePath || !outputFile) {
  throw new Error("Pass the manifest response path and set GITHUB_OUTPUT.");
}
const raw = await readFile(path.resolve(responsePath), "utf8");
if (Buffer.byteLength(raw, "utf8") > 2_000_000) {
  throw new Error("The clip processor manifest response is too large.");
}
const response = JSON.parse(raw);
const manifest = validateClipRenderManifest(response.processorManifest);
const workDirectory = path.resolve("work/clip-render");
const manifestPath = path.join(workDirectory, "manifest.json");
await writeFile(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 }
);
await appendFile(
  outputFile,
  [
    `render_id=${manifest.renderId}`,
    `clip_id=${manifest.clipId}`,
    `clip_revision=${manifest.clipRevision}`,
    `bucket_name=${manifest.source.bucketName}`,
    `source_key=${manifest.source.objectKey}`,
    `source_bytes=${manifest.source.objectBytes}`,
    `source_etag=${manifest.source.etag}`,
    `output_key=${manifest.output.objectKey}`,
    `manifest_sha256=${manifest.manifestSha256}`,
    `callback_url=${manifest.callbackUrl}`,
    `manifest_path=${manifestPath}`,
    ""
  ].join("\n")
);
