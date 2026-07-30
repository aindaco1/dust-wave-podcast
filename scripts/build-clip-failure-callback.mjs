#!/usr/bin/env node

import {
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  validateClipRenderManifest
} from "./lib/clip-render-contract.mjs";

const [manifestValue, callbackValue] = process.argv.slice(2);
if (!manifestValue || !callbackValue) {
  throw new Error(
    "Usage: build-clip-failure-callback.mjs manifest.json callback.json"
  );
}
const manifest = validateClipRenderManifest(
  JSON.parse(await readFile(path.resolve(manifestValue), "utf8"))
);
const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
const version = ffmpeg.status === 0
  ? String(ffmpeg.stdout).split("\n")[0]
  : "ffmpeg unavailable";
const body = {
  renderId: manifest.renderId,
  manifestSha256: manifest.manifestSha256,
  status: "failed",
  processorVersion: `dustwave-clip-renderer-1 (${version})`,
  failureCode: "workflow_failed",
  report: {
    schemaVersion: "clip-render-report-v1",
    templateId: manifest.recipe.templateId,
    aspectRatio: manifest.recipe.aspectRatio
  }
};
await writeFile(
  path.resolve(callbackValue),
  `${JSON.stringify(body, null, 2)}\n`,
  { mode: 0o600 }
);
