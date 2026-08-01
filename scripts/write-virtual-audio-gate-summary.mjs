#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const summaryPath = String(process.env.GITHUB_STEP_SUMMARY ?? "").trim();
const evidenceDirectory = String(process.env.EVIDENCE_DIRECTORY ?? "").trim();
if (!summaryPath || !path.isAbsolute(evidenceDirectory)) {
  throw new Error("GitHub summary and absolute evidence paths are required.");
}

const gate = await optionalJson("staging-gate.json");
const protocol = await optionalJson("protocol-matrix.json");
const load = await optionalJson("paired-load.json");
const status = gate?.result?.passed === true
  && gate?.result?.cleanupComplete === true
  && protocol?.summary?.passed === true
  && load?.summary?.passed === true
  ? "PASS"
  : "FAIL";
const lines = [
  "### Podcast virtual-audio staging gate",
  "",
  `- Result: ${status}`,
  `- Protocol probes: ${boundedNumber(protocol?.summary?.probes)}`,
  `- Measured requests: ${boundedNumber(gate?.scope?.totalMeasuredRequests)}`,
  `- Failed requests: ${boundedNumber(load?.summary?.failedRequests)}`,
  `- Content mismatches: ${boundedNumber(load?.summary?.contentMismatches)}`,
  `- Added p95: ${boundedNumber(load?.summary?.p95AddedMs)} ms`,
  `- Exact cleanup confirmed: ${gate?.result?.cleanupComplete === true ? "yes" : "no"}`,
  "- Native-client validation: not included",
  ""
];
await appendFile(summaryPath, `${lines.join("\n")}\n`, {
  encoding: "utf8",
  flag: "a"
});

async function optionalJson(filename) {
  try {
    return JSON.parse(
      await readFile(path.resolve(evidenceDirectory, filename), "utf8")
    );
  } catch {
    return null;
  }
}

function boundedNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "unavailable";
}
