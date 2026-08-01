import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url);
const processorWorkflows = [
  ".github/workflows/process-ad-plan.yml",
  ".github/workflows/process-alignment.yml",
  ".github/workflows/process-audio-enhancement-preview.yml",
  ".github/workflows/process-audio-qc.yml",
  ".github/workflows/process-clip-render.yml",
  ".github/workflows/process-transcription-chunks.yml"
];

describe("media processor signing output", () => {
  it("masks the derived signature before exposing step outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dust-wave-signing-"));
    try {
      const bodyPath = join(directory, "body.json");
      const outputPath = join(directory, "github-output.txt");
      await writeFile(bodyPath, '{"jobId":"fixture"}', "utf8");

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["scripts/sign-media-processor-body.mjs", bodyPath],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            MEDIA_PROCESSOR_CALLBACK_SECRET: "fixture-processor-secret"
          }
        }
      );
      const output = await readFile(outputPath, "utf8");
      const signature = output.match(/^signature=([a-f0-9]{64})$/m)?.[1];

      expect(signature).toBeDefined();
      expect(stdout).toBe(`::add-mask::${signature}\n`);
      expect(stderr).toBe("");
      expect(output).toMatch(/^timestamp=\d+$/m);
      expect(output).not.toContain("::add-mask::");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const workflowPath of processorWorkflows) {
    it(`${workflowPath} lets the signer manage GitHub outputs`, async () => {
      const workflow = await readFile(
        new URL(`../${workflowPath}`, import.meta.url),
        "utf8"
      );

      expect(workflow).not.toMatch(
        /sign-(?:media-processor-body|ad-plan-callback)\.mjs[\s\S]{0,180}>>\s*"\$GITHUB_OUTPUT"/
      );
    });
  }
});
