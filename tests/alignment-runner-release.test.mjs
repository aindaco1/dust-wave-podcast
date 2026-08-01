import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  describe,
  expect,
  it
} from "vitest";

const BUNDLER_REVISION = "32111c2a8dd62d891c4309f7638a86c31a789dc3";
const EXECUTION_REVISION = "e611801d2af82dcdb079444b7e8a7eea4309d1a6";
const RUNNER_REMOTE =
  "https://github.com/aindaco1/dust-wave-alignment-runner.git";
const execFileAsync = promisify(execFile);

describe("alignment runner release and execution identities", () => {
  it("pins the release branch that contains the private bundle assembler", async () => {
    const [gitmodules, project, bundleContract, indexEntry] = await Promise.all([
      readFile(".gitmodules", "utf8"),
      readFile("alignment-runner/pyproject.toml", "utf8"),
      readFile("alignment-runner/docs/BENCHMARK_BUNDLE.md", "utf8"),
      execFileAsync("git", ["-C", "alignment-runner", "rev-parse", "HEAD"])
    ]);

    expect(gitmodules).toContain("branch = release/0.2.2");
    expect(gitmodules).toContain(`url = ${RUNNER_REMOTE}`);
    expect(indexEntry.stdout).toBe(`${BUNDLER_REVISION}\n`);
    expect(project).toMatch(/version = "0\.2\.2"/);
    expect(bundleContract).toContain(
      `execution revision \`${EXECUTION_REVISION}\``
    );
    expect(bundleContract).toContain("alignment-benchmark-workspace-v1");
  });

  it("detaches the staging workflow at the reviewed execution commit", async () => {
    const workflow = await readFile(
      ".github/workflows/process-alignment.yml",
      "utf8"
    );

    expect(workflow).toContain(`= "${EXECUTION_REVISION}"`);
    expect(workflow).toContain(`= "${RUNNER_REMOTE}"`);
    expect(workflow).toContain("git -C alignment-runner fetch");
    expect(workflow).toContain("--depth=1");
    expect(workflow).toContain('"$EXPECTED_RUNNER_REVISION"');
    expect(workflow).toContain("git -C alignment-runner checkout");
    expect(workflow).toContain("--detach");
  });

  it("keeps bundler and execution revisions deliberately distinct", () => {
    expect(BUNDLER_REVISION).not.toBe(EXECUTION_REVISION);
  });
});
