#!/usr/bin/env node

import {
  appendFile,
  mkdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const renderId = String(process.env.RENDER_ID || "");
const outputFile = process.env.GITHUB_OUTPUT;
if (
  !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(renderId)
  || !outputFile
) {
  throw new Error("A valid RENDER_ID and GITHUB_OUTPUT are required.");
}
const workDirectory = path.resolve("work/clip-render");
const manifestRequestPath = path.join(
  workDirectory,
  "manifest-request.json"
);
const sourceRequestPath = path.join(workDirectory, "source-request.json");
const processorBaseUrl = [
  "https://dust-wave-podcast-staging.jogo.workers.dev",
  "v1",
  "processor",
  "clip-renders",
  renderId
].join("/");
await mkdir(workDirectory, { recursive: true });
await writeFile(
  manifestRequestPath,
  `${JSON.stringify({ renderId, action: "manifest" })}\n`,
  { mode: 0o600 }
);
await writeFile(
  sourceRequestPath,
  `${JSON.stringify({ renderId, action: "source" })}\n`,
  { mode: 0o600 }
);
await appendFile(
  outputFile,
  [
    `render_id=${renderId}`,
    `manifest_url=${processorBaseUrl}/manifest`,
    `manifest_request_path=${manifestRequestPath}`,
    `source_url=${processorBaseUrl}/source`,
    `source_request_path=${sourceRequestPath}`,
    `output_url=${processorBaseUrl}/output`,
    ""
  ].join("\n")
);
