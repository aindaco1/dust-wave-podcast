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

  it("runs each provider-independent gate before recording its evidence", () => {
    for (const testFile of [
      "tests/distribution.test.ts",
      "tests/feed-validation.test.ts",
      "tests/publication-intent.test.ts",
      "tests/launch-lab-youtube-health.test.mjs"
    ]) {
      expect(workflow).toContain(testFile);
    }
    const observations = buildLaunchLabContractObservations().observations;
    expect(observations).toEqual(expect.arrayContaining([
      { provider: "directory", scenario: "packet_generation", observedStatus: "verified" },
      { provider: "directory", scenario: "canonical_feed_validation", observedStatus: "verified" },
      { provider: "youtube", scenario: "early_access_hold", observedStatus: "held" },
      { provider: "youtube", scenario: "premium_bonus_exclusion", observedStatus: "excluded" }
    ]));
    expect(workflow.indexOf("Rehearse DRY contract adapters"))
      .toBeLessThan(workflow.indexOf("Reconcile the immutable staging fixture"));
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

  it("rehearses and always cleans the isolated Stripe Portal fixture", () => {
    expect(workflow).toContain("tests/launch-lab-stripe-portal.test.mjs");
    expect(workflow).toContain("npm run launch-lab:stripe-portal");
    expect(workflow).toContain("npm run launch-lab:stripe-portal-cleanup");
    expect(workflow.indexOf("npm run launch-lab:stripe-portal"))
      .toBeLessThan(workflow.indexOf("npm run launch-lab:stripe-portal-cleanup"));
    expect(workflow).toMatch(
      /Clean up exact Stripe Portal fixture[\s\S]+if: \$\{\{ always\(\) \}\}/
    );
  });
});
