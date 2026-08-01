import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import registry from "../config/processor-dispatch-registry.json"
  with { type: "json" };

const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("processor dispatch registry", () => {
  it("points only to present workflows with the declared dispatch input", () => {
    expect(Object.keys(registry.processors)).toHaveLength(8);
    for (const [processorType, processor] of Object.entries(registry.processors)) {
      expect(processorType).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
      expect(processor.workflow).toMatch(/^process-[a-z0-9-]+\.yml$/);
      expect(processor.input).toMatch(/^[a-z][a-z0-9_]+$/);
      const workflowPath = join(
        repositoryRoot,
        ".github",
        "workflows",
        processor.workflow
      );
      expect(existsSync(workflowPath)).toBe(true);
      const workflow = readFileSync(workflowPath, "utf8");
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).toMatch(
        new RegExp(`\\n\\s{6}${processor.input}:\\n`)
      );
      expect(workflow).toContain("cancel-in-progress: false");
    }
  });

  it("keeps the dispatcher permission-minimized and actions SHA-pinned", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/dispatch-processors.yml"),
      "utf8"
    );
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toMatch(/permissions:\s*write-all/);
    for (const line of workflow.split("\n").filter((value) => value.includes("uses:"))) {
      expect(line).toMatch(
        /uses:\s+(?:\.\/\.github\/actions\/setup-processor-node|[^@]+@[a-f0-9]{40}\b)/
      );
    }
  });

  it("centralizes the locked Node setup for every processor workflow", () => {
    const setupAction = readFileSync(
      join(repositoryRoot, ".github/actions/setup-processor-node/action.yml"),
      "utf8"
    );
    expect(setupAction).toMatch(
      /uses:\s+actions\/setup-node@[a-f0-9]{40}\b/
    );
    expect(setupAction).toContain(
      "cache: ${{ inputs.install-dependencies == 'true' && 'npm' || '' }}"
    );
    expect(setupAction).toContain("run: npm ci");

    const workflowNames = [
      ...Object.values(registry.processors).map(({ workflow }) => workflow),
      "process-ad-plan.yml"
    ];
    for (const workflowName of workflowNames) {
      const workflow = readFileSync(
        join(repositoryRoot, ".github/workflows", workflowName),
        "utf8"
      );
      expect(workflow).toContain(
        "uses: ./.github/actions/setup-processor-node"
      );
      expect(workflow).not.toContain("uses: actions/setup-node@");
      expect(workflow).not.toMatch(/^\s*run:\s+npm ci\s*$/m);
    }
  });
});
