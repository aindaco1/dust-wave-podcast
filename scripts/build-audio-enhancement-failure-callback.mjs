#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateAudioEnhancementManifest
} from "@dustwave/media-core/audio-enhancement";

const manifestPath = process.argv[2];
const outputPath = process.argv[3];
if (!manifestPath || !outputPath) {
  throw new Error("Pass the manifest and failure callback paths.");
}
const manifest = await validateAudioEnhancementManifest(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedBucket: "dustwave-media-staging"
  }
);
await writeFile(
  path.resolve(outputPath),
  `${JSON.stringify({
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256,
    status: "failed",
    failureCode: "processor_failed"
  }, null, 2)}\n`,
  { mode: 0o600 }
);
