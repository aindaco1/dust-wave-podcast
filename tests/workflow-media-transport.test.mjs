import { readFile } from "node:fs/promises";

import {
  describe,
  expect,
  it
} from "vitest";

const WORKFLOWS = [
  ".github/workflows/process-audio-enhancement-preview.yml",
  ".github/workflows/process-clip-render.yml"
];
const STAGING_MEDIA_CLIENT =
  "scripts/lib/staging-media-processor-client.mjs";

describe("signed workflow media uploads", () => {
  for (const workflowPath of WORKFLOWS) {
    it(`${workflowPath} uses the resilient streaming transport`, async () => {
      const workflow = await readFile(workflowPath, "utf8");
      const uploadIndexes = indexesOf(workflow, "--upload-file");

      expect(uploadIndexes.length).toBeGreaterThan(0);
      for (const uploadIndex of uploadIndexes) {
        const commandPrefix = workflow.slice(
          Math.max(0, uploadIndex - 900),
          uploadIndex
        );
        expect(commandPrefix).toContain("curl --http1.1");
        expect(commandPrefix).toContain("--retry-all-errors");
        expect(commandPrefix).toContain('--header "Expect:"');
      }
    });
  }

  it("uses the same resilient transport for multipart media clients", async () => {
    const client = await readFile(STAGING_MEDIA_CLIENT, "utf8");

    expect(client).toContain('"--http1.1"');
    expect(client).toContain('"--retry-all-errors"');
    expect(client).toContain('"--header", "Expect:"');
    expect(client).toContain('"--data-binary", "@-"');
  });
});

function indexesOf(value, pattern) {
  const indexes = [];
  let offset = 0;
  while ((offset = value.indexOf(pattern, offset)) !== -1) {
    indexes.push(offset);
    offset += pattern.length;
  }
  return indexes;
}
