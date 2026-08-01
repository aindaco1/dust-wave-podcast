import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditTranscriptReferenceFiles,
  parseYouTubeJson3Reference
} from "../scripts/lib/transcript-reference-audit.mjs";

describe("transcript reference audit", () => {
  it("builds a content-safe packet from canonical and YouTube inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dw-reference-audit-"));
    const transcriptPath = join(directory, "transcript.json");
    const referencePath = join(directory, "reference.json3");
    await writeFile(transcriptPath, JSON.stringify({
      schemaVersion: "podcast-transcript-v1",
      language: "es",
      cues: [
        { startsAtMs: 0, endsAtMs: 30_000, textMarkdown: "Ópera en la Selva" },
        { startsAtMs: 30_000, endsAtMs: 60_000, textMarkdown: "Dust Wave" }
      ]
    }));
    await writeFile(referencePath, JSON.stringify({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 30_000,
          segs: [{ utf8: "Opera en la selva" }]
        },
        {
          tStartMs: 30_000,
          dDurationMs: 30_000,
          segs: [{ utf8: "Dust Wave" }]
        }
      ]
    }));
    const packet = await auditTranscriptReferenceFiles({
      transcriptPath,
      referencePath,
      windowMs: 30_000,
      minimumSimilarity: 0.95
    });
    expect(packet.schemaVersion).toBe(
      "dustwave-transcript-reference-packet-v1"
    );
    expect(packet.audit.passing).toBe(true);
    expect(packet.transcriptInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.referenceInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(packet)).not.toContain("Ópera");
  });

  it("normalizes rolling YouTube events into non-overlapping cues", () => {
    const cues = parseYouTubeJson3Reference({
      events: [
        { tStartMs: 0, dDurationMs: 60_000 },
        { tStartMs: 1_000, dDurationMs: 5_000, segs: [{ utf8: "one" }] },
        { tStartMs: 3_000, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 4_000, dDurationMs: 5_000, segs: [{ utf8: "two" }] }
      ]
    });
    expect(cues).toEqual([
      { startsAtMs: 1_000, endsAtMs: 4_000, text: "one" },
      { startsAtMs: 4_000, endsAtMs: 9_000, text: "two" }
    ]);
  });

  it("fails closed for active caption controls and unsupported input", () => {
    expect(() => parseYouTubeJson3Reference({
      events: [{ tStartMs: 0, segs: [{ utf8: "bad\u0000text" }] }]
    })).toThrow(/text is invalid/);
    expect(() => parseYouTubeJson3Reference({ events: [] }))
      .toThrow(/events are invalid/);
  });
});
