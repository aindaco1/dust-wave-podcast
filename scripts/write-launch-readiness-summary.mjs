#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const summaryPath = String(process.env.GITHUB_STEP_SUMMARY ?? "").trim();
const reportPath = String(process.env.LAUNCH_GATE_REPORT ?? "").trim();
const validateOnly = process.argv.includes("--validate-only");
if (!path.isAbsolute(reportPath)) {
  throw new Error("An absolute launch report path is required.");
}
if (!validateOnly && !summaryPath) {
  throw new Error("A GitHub summary path is required.");
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const prelaunch = report?.reportType === "prelaunch";
if (
  report?.schemaVersion !== 1
  || !Array.isArray(report.nodes)
  || report.nodes.length < 1
  || report.nodes.length > 32
  || !report.summary
) {
  throw new Error("Launch readiness report is invalid.");
}
if (report?.reportType !== undefined && !prelaunch) {
  throw new Error("Launch readiness report type is invalid.");
}

const statuses = new Set([
  "PASS",
  "BLOCK",
  "WAIT",
  "FAIL",
  ...(prelaunch ? ["DEFER"] : [])
]);
const rows = report.nodes.map((node) => {
  if (!statuses.has(node?.status)) {
    throw new Error("Launch readiness node status is invalid.");
  }
  return `| ${node.status} | ${safeCell(node.label)} | ${safeCell(node.detail)} |`;
});
if (validateOnly) {
  process.exit(0);
}
const lines = [
  prelaunch
    ? "### Podcast platform and launch readiness"
    : "### Podcast launch readiness",
  "",
  `- Safe to continue: ${report.summary.safe === true ? "yes" : "no"}`,
  ...(prelaunch
    ? [
        `- Platform ready: ${
          report.summary.platformReady === true ? "yes" : "no"
        }`
      ]
    : []),
  `- Launch ready: ${report.summary.launchReady === true ? "yes" : "no"}`,
  `- Pass: ${boundedCount(report.summary.passCount)}`,
  `- Block: ${boundedCount(report.summary.blockCount)}`,
  `- Wait: ${boundedCount(report.summary.waitCount)}`,
  ...(prelaunch
    ? [`- Content deferred: ${boundedCount(report.summary.deferredCount)}`]
    : []),
  `- Fail: ${boundedCount(report.summary.failCount)}`,
  "",
  "| Status | Gate | Evidence |",
  "| --- | --- | --- |",
  ...rows,
  ""
];
await appendFile(summaryPath, `${lines.join("\n")}\n`, {
  encoding: "utf8",
  flag: "a"
});

function safeCell(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replaceAll("|", "\\|")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 100
    ? count
    : "unavailable";
}
