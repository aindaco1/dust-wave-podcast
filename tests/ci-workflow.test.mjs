import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("CI workflow", () => {
  it("bounds media package downloads without installing recommendations", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8"
    );

    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("--no-install-recommends");
    expect(workflow).toContain("Acquire::Retries=3");
    expect(workflow).toContain("Acquire::http::Timeout=30");
  });
});
