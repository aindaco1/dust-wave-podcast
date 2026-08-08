import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/launch-readiness-monitor.yml",
    import.meta.url
  ),
  "utf8"
);

describe("launch readiness monitor workflow", () => {
  it("runs a bounded daily, non-canceling, staging-only monitor", () => {
    expect(workflow).toContain('cron: "43 13 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: podcast-staging");
    expect(workflow).toContain("npm run gate:launch:staging");
    expect(workflow).toContain("--json");
    expect(workflow).not.toContain("--require-ready");
  });

  it("uses only read-gate credentials and pins every external action", () => {
    expect(workflow).toContain(
      "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"
    );
    expect(workflow).toContain(
      "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
    );
    expect(workflow).toContain(
      "STRIPE_API_KEY: ${{ secrets.STRIPE_API_KEY }}"
    );
    expect(workflow).toContain(
      "PODCAST_LAUNCH_EPISODE_ID: ${{ vars.PODCAST_LAUNCH_EPISODE_ID }}"
    );
    expect(workflow).not.toContain("MEDIA_PROCESSOR_CALLBACK_SECRET");
    for (const line of workflow.split("\n").filter((value) => value.includes("uses:"))) {
      expect(line).toMatch(/uses:\s+[^@]+@[a-f0-9]{40}\b/);
    }
  });

  it("retains only the content-free report and enforces execution safety", () => {
    expect(workflow).toContain("write-launch-readiness-summary.mjs");
    expect(workflow).toContain("report.json");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow).toContain('test "$GATE_STATUS" = "0"');
  });

  it("reports a credential block without installing an expiring token", () => {
    expect(workflow).toContain('echo "configured=false"');
    expect(workflow).toContain(
      "scoped staging read credentials are not configured"
    );
    expect(workflow).toContain(
      "steps.gate.outputs.configured == 'true'"
    );
    expect(workflow).toContain('if [ "$GATE_CONFIGURED" != "true" ]');
  });
});
