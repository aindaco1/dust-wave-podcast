#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

const filename = process.env.LAUNCH_LAB_REPORT;
const summary = process.env.GITHUB_STEP_SUMMARY;
if (!filename || !summary) throw new Error("Launch Lab summary paths are missing.");
const report = JSON.parse(readFileSync(filename, "utf8"));
const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
const counts = scenarios.reduce((result, scenario) => {
  const state = String(scenario.state || "pending");
  result[state] = (result[state] || 0) + 1;
  return result;
}, {});
appendFileSync(summary, [
  "### Podcast Launch Lab",
  "",
  `- Run: \`${String(report.runId || "unknown")}\``,
  `- Status: **${String(report.status || "unknown").toUpperCase()}**`,
  `- Scenarios: ${counts.passed || 0} passed · ${counts.failed || 0} failed · ${(counts.pending || 0) + (counts.running || 0)} pending`,
  "- Launch eligibility: intentionally false (synthetic staging evidence)",
  ""
].join("\n"));
