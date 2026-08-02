#!/usr/bin/env node

import { loadWorkerConfig } from "./staging-gate-runtime.mjs";

const config = loadWorkerConfig();
const origin = String(
  process.env.LAUNCH_LAB_URL
    || config.env?.staging?.vars?.FEED_ORIGIN
    || ""
).replace(/\/$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(origin)) {
  throw new Error("The exact staging Launch Lab origin is invalid.");
}
const paths = [
  "/v1/shows/dust-wave-launch-lab",
  "/dust-wave-launch-lab/rss.xml"
];
const responses = await Promise.all(paths.map((pathname) => fetch(
  `${origin}${pathname}`,
  { redirect: "error", signal: AbortSignal.timeout(10_000) }
)));
if (responses.some((response) => response.status !== 404)) {
  throw new Error("A Launch Lab fixture escaped a public staging route.");
}
process.stdout.write(`${JSON.stringify({
  schemaVersion: "dust-wave-launch-lab-observations-v1",
  observations: [{
    provider: "rss",
    scenario: "public_fixture_hidden",
    observedStatus: "hidden"
  }]
}, null, 2)}\n`);
