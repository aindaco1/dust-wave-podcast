import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/virtual-audio-staging-gate.yml", import.meta.url),
  "utf8"
);

describe("virtual-audio staging gate workflow", () => {
  it("runs bounded, non-canceling evidence refreshes with pinned actions", () => {
    expect(workflow).toContain('cron: "17 13 */3 * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: podcast-staging");
    expect(workflow).toContain(
      "uses: ./.github/actions/setup-processor-node"
    );
    expect(workflow).not.toContain("sudo apt-get install --yes ffmpeg");
    expect(workflow).toContain("ffprobe -version");
    for (const line of workflow.split("\n").filter((value) => value.includes("uses:"))) {
      expect(line).toMatch(
        /uses:\s+(?:\.\/\.github\/actions\/setup-processor-node|[^@]+@[a-f0-9]{40}\b)/
      );
    }
  });

  it("uses only the purpose-bound callback secret and publishes exact cleanup evidence", () => {
    expect(workflow).toContain(
      "MEDIA_PROCESSOR_CALLBACK_SECRET: ${{ secrets.MEDIA_PROCESSOR_CALLBACK_SECRET }}"
    );
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("--publish-evidence");
    expect(workflow).toContain("staging-gate.json");
    expect(workflow).toContain("protocol-matrix.json");
    expect(workflow).toContain("paired-load.json");
  });
});
