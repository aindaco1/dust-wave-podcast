#!/usr/bin/env node

import { runPublicReleaseGate } from "./lib/public-release-gate.mjs";

const evidence = await runPublicReleaseGate({
  environment: process.argv[2]
});
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
