import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const script = path.join(
  repositoryRoot,
  "scripts/write-launch-readiness-summary.mjs"
);

describe("launch readiness summary", () => {
  it("validates a bounded policy-failure report without requiring a summary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "launch-report-"));
    const reportPath = path.join(directory, "report.json");
    writeFileSync(reportPath, JSON.stringify(validReport()), "utf8");

    expect(() => execFileSync(
      process.execPath,
      [script, "--validate-only"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: "",
          LAUNCH_GATE_REPORT: reportPath
        },
        stdio: "pipe"
      }
    )).not.toThrow();
  });

  it("rejects an invalid report during validation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "launch-report-"));
    const reportPath = path.join(directory, "report.json");
    writeFileSync(reportPath, "{}", "utf8");

    const result = spawnSync(
      process.execPath,
      [script, "--validate-only"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, LAUNCH_GATE_REPORT: reportPath },
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
  });

  it("writes the bounded policy failure into the GitHub summary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "launch-report-"));
    const reportPath = path.join(directory, "report.json");
    const summaryPath = path.join(directory, "summary.md");
    writeFileSync(reportPath, JSON.stringify(validReport()), "utf8");

    execFileSync(process.execPath, [script], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        LAUNCH_GATE_REPORT: reportPath
      },
      stdio: "pipe"
    });

    expect(readFileSync(summaryPath, "utf8")).toContain(
      "| FAIL | Stripe test-mode gate | controlled mutation remains |"
    );
  });
});

function validReport() {
  return {
    schemaVersion: 1,
    nodes: [{
      status: "FAIL",
      label: "Stripe test-mode gate",
      detail: "controlled mutation remains"
    }],
    summary: {
      safe: false,
      launchReady: false,
      passCount: 0,
      blockCount: 0,
      waitCount: 0,
      failCount: 1
    }
  };
}
