import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import matrix from "../config/launch-lab-matrix.json";
import { buildLaunchLabContractObservations } from
  "../scripts/build-launch-lab-contract-observations.mjs";
import { launchLabIdentity } from "../scripts/launch-lab-client.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/launch-lab-staging.yml", import.meta.url),
  "utf8"
);

describe("Launch Lab automation", () => {
  it("derives a stable run identity from an exact source commit", () => {
    expect(launchLabIdentity({ GITHUB_SHA: "a".repeat(40) })).toEqual({
      runId: "launch_" + "a".repeat(24),
      sourceCommit: "a".repeat(40)
    });
    expect(() => launchLabIdentity({ GITHUB_SHA: "main" })).toThrow(
      /exact source commit/
    );
  });

  it("records only checked-in expectations after the matching gates pass", () => {
    const observations = buildLaunchLabContractObservations().observations;
    expect(observations.length).toBeGreaterThan(0);
    expect(new Set(observations.map(({ provider, scenario }) =>
      `${provider}:${scenario}`
    )).size).toBe(observations.length);
    for (const observation of observations) {
      expect(matrix.providers[observation.provider][observation.scenario])
        .toBe(observation.observedStatus);
    }
  });

  it("uses one purpose-bound secret without broad Cloudflare credentials", () => {
    expect(workflow).toContain("secrets.LAUNCH_LAB_CALLBACK_SECRET");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toMatch(/npm run launch-lab(?::contracts|:probe| -- status)\s*>/);
    expect(workflow).toContain(
      "node scripts/build-launch-lab-contract-observations.mjs >"
    );
    expect(workflow).toContain(
      "node scripts/launch-lab-client.mjs status >"
    );
    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40}/);
    expect(workflow).toMatch(/actions\/upload-artifact@[a-f0-9]{40}/);
  });
});
