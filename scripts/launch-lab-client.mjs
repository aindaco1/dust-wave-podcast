#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadWorkerConfig, repositoryRoot } from "./staging-gate-runtime.mjs";

export function launchLabIdentity(environment = process.env) {
  const sourceCommit = String(
    environment.LAUNCH_LAB_SOURCE_COMMIT
      || environment.GITHUB_SHA
      || execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8"
      })
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("An exact source commit is required.");
  }
  const runId = String(
    environment.LAUNCH_LAB_RUN_ID
      || `launch_${sourceCommit.slice(0, 24)}`
  ).trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(runId)) {
    throw new Error("The Launch Lab run identifier is invalid.");
  }
  return { runId, sourceCommit };
}

export async function callLaunchLab(
  action,
  { observations, environment = process.env } = {}
) {
  const secret = String(environment.LAUNCH_LAB_CALLBACK_SECRET || "");
  if (secret.length < 24) {
    throw new Error("The Launch Lab callback secret is not configured.");
  }
  const config = loadWorkerConfig();
  const origin = String(
    environment.LAUNCH_LAB_URL
      || config.env?.staging?.vars?.FEED_ORIGIN
      || ""
  ).replace(/\/$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(origin)) {
    throw new Error("The exact staging Launch Lab origin is invalid.");
  }
  const identity = launchLabIdentity(environment);
  const rawBody = JSON.stringify({
    schemaVersion: "dust-wave-launch-lab-request-v1",
    action,
    ...identity,
    ...(observations ? { observations } : {})
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const response = await fetch(`${origin}/v1/diagnostics/launch-lab`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-podcast-launch-lab-timestamp": timestamp,
      "x-podcast-launch-lab-signature": signature
    },
    body: rawBody,
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`Launch Lab ${action} failed with HTTP ${response.status}.`);
  }
  return body;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const action = ({
    reconcile: "reconcile",
    record: "record_observations",
    resend: "run_resend_matrix",
    stripe: "run_stripe_readiness",
    "stripe-lifecycle": "run_stripe_lifecycle",
    "stripe-checkout": "run_stripe_checkout",
    "stripe-checkout-cleanup": "cleanup_stripe_checkout",
    status: "status"
  })[command];
  if (!action) {
    throw new Error(
      "Usage: launch-lab-client.mjs <reconcile|record|resend|stripe|stripe-lifecycle|stripe-checkout|stripe-checkout-cleanup|status> "
      + "[observations.json]"
    );
  }
  let observations;
  if (command === "record") {
    const filename = args[0];
    if (!filename) throw new Error("An observations JSON file is required.");
    const document = JSON.parse(readFileSync(path.resolve(filename), "utf8"));
    observations = document.observations;
    if (!Array.isArray(observations)) {
      throw new Error("The observations file is invalid.");
    }
  }
  const result = await callLaunchLab(action, { observations });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) await main();
