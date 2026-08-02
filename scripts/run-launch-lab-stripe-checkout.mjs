#!/usr/bin/env node

import { setTimeout as wait } from "node:timers/promises";

import { callLaunchLab } from "./launch-lab-client.mjs";

const maximumAttempts = 180;
const pollMilliseconds = 5_000;
let previousPhase = "";

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  let result;
  try {
    result = await callLaunchLab("run_stripe_checkout");
  } catch {
    if (attempt === maximumAttempts) {
      throw new Error("Hosted Checkout exhausted its bounded provider retries.");
    }
    process.stdout.write("Hosted Checkout provider call will retry.\n");
    await wait(pollMilliseconds);
    continue;
  }
  const phase = String(result?.phase ?? "");
  if (!/^[a-z_]{3,40}$/.test(phase)) {
    throw new Error("Hosted Checkout returned an invalid phase.");
  }
  if (phase !== previousPhase) {
    process.stdout.write(`Hosted Checkout phase: ${phase}\n`);
    if (result.requiresBrowser === true) {
      process.stdout.write("Hosted Checkout is waiting for the protected browser handoff.\n");
    }
    previousPhase = phase;
  }
  if (result.complete === true && phase === "complete") {
    process.stdout.write("Hosted Checkout rehearsal completed.\n");
    process.exit(0);
  }
  if (phase === "aborted") {
    throw new Error("Hosted Checkout was aborted before completion.");
  }
  if (attempt < maximumAttempts) await wait(pollMilliseconds);
}

throw new Error("Hosted Checkout did not complete within the bounded browser window.");
