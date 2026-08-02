#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runDirectSponsorDemoGate } from
  "./lib/direct-sponsor-demo-gate.mjs";

export function buildLaunchLabContractObservations() {
  const sponsor = runDirectSponsorDemoGate();
  if (!sponsor.passed) throw new Error("The sponsor contract gate did not pass.");
  return {
    schemaVersion: "dust-wave-launch-lab-observations-v1",
    observations: [
      { provider: "ads", scenario: "targeting_matrix", observedStatus: "verified" },
      { provider: "ads", scenario: "house_fallback", observedStatus: "verified" },
      { provider: "ads", scenario: "equal_byte_length", observedStatus: "verified" },
      { provider: "ads", scenario: "partial_not_qualified", observedStatus: "verified" },
      { provider: "pool", scenario: "grant", observedStatus: "active" },
      { provider: "pool", scenario: "redeem", observedStatus: "active" },
      { provider: "pool", scenario: "duplicate", observedStatus: "idempotent" },
      { provider: "pool", scenario: "revoke", observedStatus: "revoked" },
      { provider: "rss", scenario: "private_directory_block", observedStatus: "blocked" }
    ]
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  process.stdout.write(
    `${JSON.stringify(buildLaunchLabContractObservations(), null, 2)}\n`
  );
}
