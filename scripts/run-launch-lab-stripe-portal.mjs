#!/usr/bin/env node

import { setTimeout as wait } from "node:timers/promises";

import { callLaunchLab } from "./launch-lab-client.mjs";

const maximumAttempts = 8;
const pollMilliseconds = 1_000;
let previousPhase = "";

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  const result = await callLaunchLab("run_stripe_portal");
  const phase = String(result?.phase ?? "");
  if (!/^[a-z_]{3,40}$/.test(phase)) {
    throw new Error("Stripe Portal rehearsal returned an invalid phase.");
  }
  if (phase !== previousPhase) {
    process.stdout.write(`Stripe Portal phase: ${phase}\n`);
    previousPhase = phase;
  }
  if (result.complete === true && phase === "complete") {
    if (
      result.portalVerified !== true
      || result.customerDeleted !== true
    ) {
      throw new Error("Stripe Portal rehearsal returned incomplete evidence.");
    }
    process.stdout.write("Stripe Portal rehearsal completed.\n");
    process.exit(0);
  }
  if (phase === "aborted") {
    throw new Error("Stripe Portal rehearsal was aborted.");
  }
  if (attempt < maximumAttempts) await wait(pollMilliseconds);
}

throw new Error("Stripe Portal rehearsal did not complete within its bound.");
