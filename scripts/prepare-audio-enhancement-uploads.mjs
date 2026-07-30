#!/usr/bin/env node

import {
  appendFile,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  validateAudioEnhancementManifest,
  validateAudioEnhancementReport
} from "@dustwave/media-core/audio-enhancement";

const [manifestValue, callbackValue] = process.argv.slice(2);
const outputFile = process.env.GITHUB_OUTPUT;
if (!manifestValue || !callbackValue || !outputFile) {
  throw new Error(
    "Pass manifest/callback JSON paths and set GITHUB_OUTPUT."
  );
}
const manifest = await validateAudioEnhancementManifest(
  JSON.parse(await readFile(path.resolve(manifestValue), "utf8")),
  {
    expectedHost: "dust-wave-podcast-staging.jogo.workers.dev",
    expectedBucket: "dustwave-media-staging"
  }
);
const callback = JSON.parse(
  await readFile(path.resolve(callbackValue), "utf8")
);
if (
  callback.jobId !== manifest.jobId
  || callback.manifestSha256 !== manifest.manifestSha256
  || callback.status !== "succeeded"
) {
  throw new Error("The enhancement callback identity is invalid.");
}
const report = await validateAudioEnhancementReport(
  callback.report,
  manifest
);
const directory = path.dirname(path.resolve(manifestValue));
const outputs = [];
for (const kind of ["original", "enhanced"]) {
  const evidence = report.outputs[kind];
  const payload = Buffer.from(
    JSON.stringify({
      jobId: manifest.jobId,
      kind,
      manifestSha256: manifest.manifestSha256,
      objectBytes: evidence.objectBytes,
      sha256: evidence.sha256
    }),
    "utf8"
  ).toString("base64url");
  const payloadPath = path.join(directory, `${kind}-upload-payload.txt`);
  await writeFile(payloadPath, payload, { mode: 0o600 });
  outputs.push(
    `${kind}_bytes=${evidence.objectBytes}`,
    `${kind}_sha256=${evidence.sha256}`,
    `${kind}_upload_payload=${payload}`,
    `${kind}_upload_payload_path=${payloadPath}`
  );
}
await appendFile(outputFile, [...outputs, ""].join("\n"));
