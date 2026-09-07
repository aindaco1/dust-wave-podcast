import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function runNodeJson(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    // Exercise the workflows' plain Node loader, without inherited loader hooks.
    env: { ...process.env, NODE_OPTIONS: "" }
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("plain Node sponsor CLI entry points", () => {
  it("runs the sponsor gate and emits non-billable synthetic evidence", () => {
    const report = runNodeJson("scripts/run-direct-sponsor-demo-gate.mjs");
    expect(report).toMatchObject({
      schemaVersion: "dust-wave-direct-sponsor-demo-gate-v1",
      passed: true,
      targeting: { allPassed: true },
      decision: { lengthContract: { equalByteLength: true } },
      boundaries: {
        stagingMutationPerformed: false,
        billingEligible: false,
        qualifiedImpressions: 0,
        launchGateEligible: false
      }
    });
  });

  it("emits parseable contract observations through the workflow entry point", () => {
    const report = runNodeJson("scripts/build-launch-lab-contract-observations.mjs");
    expect(report.schemaVersion).toBe("dust-wave-launch-lab-observations-v1");
    expect(report.observations).toEqual(expect.arrayContaining([
      { provider: "ads", scenario: "equal_byte_length", observedStatus: "verified" },
      { provider: "ads", scenario: "partial_not_qualified", observedStatus: "verified" },
      { provider: "rss", scenario: "private_directory_block", observedStatus: "blocked" },
      { provider: "youtube", scenario: "premium_bonus_exclusion", observedStatus: "excluded" }
    ]));
  });
});
