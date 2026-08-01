import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import contract from "../config/virtual-audio-synthetic-fixture.json"
  with { type: "json" };

describe("virtual-audio fixture generator", () => {
  it("rebuilds the exact contract without an encoder-version dependency", async () => {
    const output = await mkdtemp(
      path.join(tmpdir(), "dust-wave-virtual-audio-generator-")
    );
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-virtual-audio-fixtures.mjs", output],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(
        await readFile(path.join(output, "evidence.json"), "utf8")
      );
      const generated = new Map(
        evidence.artifacts.map((artifact) => [artifact.filename, artifact])
      );
      for (const artifact of [
        ...contract.sources,
        ...Object.values(contract.assemblies)
      ]) {
        expect(generated.get(artifact.filename)).toMatchObject({
          bytes: artifact.bytes,
          sha256: artifact.sha256
        });
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("uses only canonical self-contained seed frames for source bytes", async () => {
    const source = await readFile(
      new URL("../scripts/generate-virtual-audio-fixtures.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain("deterministicSourceBytes");
    expect(source).toContain("mainDataBegin !== 0");
    expect(source).not.toContain("libmp3lame");
    expect(source).not.toContain('"lavfi"');
    for (const fixture of contract.sources) {
      expect(Buffer.from(fixture.frameBase64, "base64").byteLength).toBe(
        fixture.frameBytes
      );
      expect(fixture.bytes).toBe(fixture.frameBytes * fixture.frameCount);
    }
  });
});
