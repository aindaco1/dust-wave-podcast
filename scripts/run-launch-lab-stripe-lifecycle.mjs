#!/usr/bin/env node

import { setTimeout as wait } from "node:timers/promises";

import { callLaunchLab } from "./launch-lab-client.mjs";

const maximumAttempts = 160;
const pollMilliseconds = 5_000;
let previousPhase = "";

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  let result;
  try {
    result = await callLaunchLab("run_stripe_lifecycle");
  } catch {
    if (attempt === maximumAttempts) throw new Error(
      "Stripe lifecycle exhausted its bounded provider retries."
    );
    process.stdout.write("Stripe lifecycle provider call will retry.\n");
    await wait(pollMilliseconds);
    continue;
  }
  const phase = String(result?.phase ?? "");
  if (!/^[a-z_]{3,40}$/.test(phase)) {
    throw new Error("Stripe lifecycle returned an invalid phase.");
  }
  if (phase !== previousPhase) {
    process.stdout.write(`Stripe lifecycle phase: ${phase}\n`);
    previousPhase = phase;
  }
  if (result.complete === true && phase === "complete") {
    process.stdout.write("Stripe lifecycle rehearsal completed.\n");
    process.exit(0);
  }
  if (attempt < maximumAttempts) await wait(pollMilliseconds);
}

throw new Error("Stripe lifecycle did not complete within the bounded poll window.");
