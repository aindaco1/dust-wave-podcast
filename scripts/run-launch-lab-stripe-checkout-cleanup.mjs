#!/usr/bin/env node

import { setTimeout as wait } from "node:timers/promises";

import { callLaunchLab } from "./launch-lab-client.mjs";

const maximumAttempts = 40;
const pollMilliseconds = 3_000;
let previousPhase = "";

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  let result;
  try {
    result = await callLaunchLab("cleanup_stripe_checkout");
  } catch {
    if (attempt === maximumAttempts) {
      throw new Error("Hosted Checkout cleanup exhausted its retries.");
    }
    await wait(pollMilliseconds);
    continue;
  }
  const phase = String(result?.phase ?? "");
  if (!/^[a-z_]{3,40}$/.test(phase)) {
    throw new Error("Hosted Checkout cleanup returned an invalid phase.");
  }
  if (phase !== previousPhase) {
    process.stdout.write(`Hosted Checkout cleanup phase: ${phase}\n`);
    previousPhase = phase;
  }
  if (result.complete === true) {
    process.stdout.write("Hosted Checkout cleanup completed.\n");
    process.exit(0);
  }
  if (attempt < maximumAttempts) await wait(pollMilliseconds);
}

throw new Error("Hosted Checkout cleanup did not finish within its bound.");
