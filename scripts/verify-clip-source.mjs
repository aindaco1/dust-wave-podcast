#!/usr/bin/env node

import {
  readFile,
  stat
} from "node:fs/promises";
import path from "node:path";

import {
  validateClipRenderManifest
} from "./lib/clip-render-contract.mjs";

const [manifestValue, sourceValue] = process.argv.slice(2);
if (!manifestValue || !sourceValue) {
  throw new Error(
    "Usage: verify-clip-source.mjs manifest.json source.mp3"
  );
}
const manifest = validateClipRenderManifest(
  JSON.parse(await readFile(path.resolve(manifestValue), "utf8"))
);
const source = await stat(path.resolve(sourceValue));
if (source.size !== manifest.source.objectBytes) {
  throw new Error("The downloaded private source does not match the manifest.");
}
process.stdout.write(`${JSON.stringify({
  objectBytes: source.size,
  etag: manifest.source.etag,
  contentType: manifest.source.mimeType
})}\n`);
