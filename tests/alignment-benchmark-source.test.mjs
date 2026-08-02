import { describe, expect, it } from "vitest";

import {
  buildCaptionWordTimeline,
  clipYouTubeJson3Reference,
  planCaptionDenseWindows
} from "../scripts/lib/alignment-benchmark-source.mjs";

describe("alignment benchmark source preparation", () => {
  it("selects the exact number of dense, non-overlapping windows", () => {
    const words = [];
    for (let region = 0; region < 5; region += 1) {
      for (let index = 0; index < 140; index += 1) {
        words.push({ startsAtMs: region * 130_000 + index * 700, text: "voz" });
      }
    }
    const windows = planCaptionDenseWindows({
      words,
      sourceDurationMs: 650_000,
      fixtureCount: 4,
      windowDurationMs: 120_000,
      gridMs: 1_000,
      minimumGapMs: 1_000,
      minimumReferenceWords: 100
    });
    expect(windows).toHaveLength(4);
    expect(windows.every((window) => window.referenceWordCount >= 100)).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].startsAtMs).toBeGreaterThanOrEqual(
        windows[index - 1].endsAtMs + 1_000
      );
    }
  });

  it("fails closed instead of filling a speech-density shortfall", () => {
    expect(() => planCaptionDenseWindows({
      words: [{ startsAtMs: 0, text: "voz" }],
      sourceDurationMs: 500_000,
      fixtureCount: 2,
      windowDurationMs: 120_000,
      minimumReferenceWords: 2
    })).toThrow(/cannot supply/);
  });

  it("tokenizes Unicode captions and rebases private reference events", () => {
    const words = buildCaptionWordTimeline([
      { startsAtMs: 1_000, endsAtMs: 2_000, text: "Ópera, Selva y Dust Wave" }
    ]);
    expect(words.map((word) => word.text)).toEqual([
      "Ópera", "Selva", "y", "Dust", "Wave"
    ]);
    const clipped = clipYouTubeJson3Reference({
      events: [
        { tStartMs: 1_000, dDurationMs: 500, segs: [{ utf8: "antes" }] },
        { tStartMs: 5_000, dDurationMs: 5_000, segs: [{ utf8: "dentro" }] },
        { tStartMs: 20_000, dDurationMs: 5_000, segs: [{ utf8: "después" }] }
      ]
    }, 4_000, 15_000);
    expect(clipped.events).toEqual([
      { tStartMs: 1_000, dDurationMs: 5_000, segs: [{ utf8: "dentro" }] }
    ]);
  });
});
