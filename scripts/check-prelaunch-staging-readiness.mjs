#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateLaunchStagingReadiness,
  loadLaunchStagingSnapshot
} from "./check-launch-staging-readiness.mjs";

const contentDeferrals = Object.freeze({
  distribution:
    "requires a public trailer or episode before directory ingestion and recovery can be certified",
  youtube:
    "requires a rights-cleared trailer or episode before the controlled unlisted publication can be inspected",
  dynamic_ads:
    "requires an approved trailer or episode ad plan and one qualified direct-sponsor download from a real client"
});

export function evaluatePrelaunchStagingReadiness(snapshot) {
  const launchReport = evaluateLaunchStagingReadiness(snapshot);
  const canary = snapshot.goldenCanaryEvidence ?? {};
  const virtualAudioReady = snapshot.virtualAudioEvidence?.passed === true;
  const canaryReady = canary.passed === true && virtualAudioReady;
  const canaryFailureCount = boundedCount(canary.failureCount);
  const goldenCanaryNode = {
    status: canaryReady
      ? "PASS"
      : canaryFailureCount > 0
        ? "FAIL"
        : "BLOCK",
    id: "golden_canary",
    label: "Private golden-canary rehearsal",
    detail: canaryReady
      ? `${boundedCount(canary.requirementCount)} isolated contract scenario(s) and the signed synthetic media/load gate are current`
      : goldenCanaryBlockDetail(canary, virtualAudioReady)
  };
  const nodes = [];
  for (const node of launchReport.nodes) {
    if (node.id === "distribution") nodes.push(goldenCanaryNode);
    const deferral = contentDeferrals[node.id];
    nodes.push(
      deferral && node.status === "BLOCK"
        ? { ...node, status: "DEFER", detail: deferral }
        : { ...node }
    );
  }
  if (!nodes.some(({ id }) => id === "golden_canary")) {
    nodes.push(goldenCanaryNode);
  }

  const failCount = countStatus(nodes, "FAIL");
  const blockCount = countStatus(nodes, "BLOCK");
  const waitCount = countStatus(nodes, "WAIT");
  const deferredCount = countStatus(nodes, "DEFER");
  return {
    schemaVersion: 1,
    reportType: "prelaunch",
    nodes,
    nextAction: presentAction(nodes, ["FAIL", "BLOCK", "WAIT"]),
    contentNextAction: presentAction(nodes, ["DEFER"]),
    summary: {
      passCount: countStatus(nodes, "PASS"),
      failCount,
      blockCount,
      waitCount,
      deferredCount,
      safe: failCount === 0,
      platformReady: failCount === 0 && blockCount === 0 && waitCount === 0,
      launchReady:
        failCount === 0
        && blockCount === 0
        && waitCount === 0
        && launchReport.summary.launchReady === true
    }
  };
}

function goldenCanaryBlockDetail(canary, virtualAudioReady) {
  const requirements = [];
  const failures = boundedCount(canary.failureCount);
  const requirementCount = boundedCount(canary.requirementCount);
  const observedCount = boundedCount(canary.observedRequirementCount);
  const passedCount = boundedCount(canary.passedCount);
  if (failures > 0) {
    requirements.push(
      `${failures} isolated contract ${failures === 1 ? "failure" : "failures"}`
    );
  }
  if (observedCount !== requirementCount) {
    requirements.push(
      `${observedCount}/${requirementCount} required isolated contract scenario(s) are present`
    );
  } else if (passedCount !== requirementCount) {
    requirements.push(
      `${passedCount}/${requirementCount} required isolated contract scenario(s) passed`
    );
  }
  if (canary.fresh !== true) {
    requirements.push("the Launch Lab rehearsal is missing or older than seven days");
  }
  if (canary.sourceCurrent !== true) {
    requirements.push("relevant Launch Lab source changed after the rehearsal");
  }
  if (!virtualAudioReady) {
    requirements.push(
      "refresh the signed synthetic media/load gate with complete cleanup"
    );
  }
  return requirements.length > 0
    ? requirements.join("; ")
    : "refresh the complete Launch Lab rehearsal";
}

function presentAction(nodes, statuses) {
  const node = statuses
    .map((status) => nodes.find((candidate) => candidate.status === status))
    .find(Boolean);
  return node
    ? { id: node.id, label: node.label, detail: node.detail }
    : null;
}

function countStatus(nodes, status) {
  return nodes.filter((node) => node.status === status).length;
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run gate:prelaunch:staging -- <episode-id> "
      + "[--virtual-audio-evidence=/absolute/staging-gate.json] "
      + "[--require-ready] [--json]\n\n"
      + "Reports content-independent platform readiness using read-only "
      + "launch evidence plus the isolated Launch Lab and signed synthetic "
      + "media canaries. Directory ingestion, controlled YouTube publication, "
      + "and a real-client ad pilot remain explicit content deferrals.\n"
    );
    return;
  }
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length !== 1) {
    throw new Error("Exactly one episode ID is required.");
  }
  const evidenceArgument = args.find((arg) =>
    arg.startsWith("--virtual-audio-evidence=")
  );
  const evidencePath = evidenceArgument
    ? evidenceArgument.slice("--virtual-audio-evidence=".length)
    : null;
  if (evidencePath && !path.isAbsolute(evidencePath)) {
    throw new Error("Virtual-audio evidence must use an absolute path.");
  }
  const report = evaluatePrelaunchStagingReadiness(
    loadLaunchStagingSnapshot(positionals[0], evidencePath)
  );
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const node of report.nodes) {
      process.stdout.write(
        `${node.status.padEnd(5)} ${node.label} - ${node.detail}\n`
      );
    }
    process.stdout.write(
      `\nSummary: ${report.summary.passCount} pass, `
      + `${report.summary.blockCount} block, `
      + `${report.summary.waitCount} wait, `
      + `${report.summary.deferredCount} deferred, `
      + `${report.summary.failCount} fail\n`
      + `Platform ready: ${report.summary.platformReady ? "yes" : "no"}\n`
      + `Launch ready: ${report.summary.launchReady ? "yes" : "no"}\n`
    );
    if (report.nextAction) {
      process.stdout.write(
        `Next platform action: ${report.nextAction.label} - `
        + `${report.nextAction.detail}\n`
      );
    }
    if (report.contentNextAction) {
      process.stdout.write(
        `First content action: ${report.contentNextAction.label} - `
        + `${report.contentNextAction.detail}\n`
      );
    }
  }
  if (
    report.summary.failCount > 0
    || (args.includes("--require-ready") && !report.summary.platformReady)
  ) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) await main();
