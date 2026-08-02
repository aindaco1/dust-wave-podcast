#!/usr/bin/env node

import { runDirectSponsorDemoGate } from
  "./lib/direct-sponsor-demo-gate.mjs";

process.stdout.write(`${JSON.stringify(runDirectSponsorDemoGate(), null, 2)}\n`);
