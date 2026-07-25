import { describe, expect, it } from "vitest";

import {
  resolveSegmentClipSelection,
  validateClipDuration
} from "../src/clips";
import type { TranscriptCue } from "../src/transcripts";

describe("clip recipe boundary", () => {
  it("derives immutable segment boundaries from approved cue IDs", () => {
    expect(resolveSegmentClipSelection(
      [
        cue("cue_001", 5_000, 9_000),
        cue("cue_002", 9_000, 14_500),
        cue("cue_003", 14_500, 20_000)
      ],
      "cue_001",
      "cue_002",
      30_000
    )).toEqual({
      startCueIndex: 0,
      endCueIndex: 1,
      startsAtMs: 5_000,
      endsAtMs: 14_500
    });
  });

  it("rejects unknown, reversed, short, long, and outside-audio ranges", () => {
    const cues = [
      cue("cue_001", 0, 500),
      cue("cue_002", 500, 181_000)
    ];
    expect(() => resolveSegmentClipSelection(
      cues,
      "missing",
      "cue_002",
      200_000
    )).toThrow(/not in the approved transcript/);
    expect(() => resolveSegmentClipSelection(
      cues,
      "cue_002",
      "cue_001",
      200_000
    )).toThrow(/not in the approved transcript/);
    expect(() => validateClipDuration(0, 500, 200_000))
      .toThrow(/1–180 seconds/);
    expect(() => validateClipDuration(0, 180_001, 200_000))
      .toThrow(/1–180 seconds/);
    expect(() => validateClipDuration(1_000, 5_000, 4_999))
      .toThrow(/1–180 seconds/);
  });
});

function cue(
  id: string,
  startsAtMs: number,
  endsAtMs: number
): TranscriptCue {
  return {
    id,
    startsAtMs,
    endsAtMs,
    speakerLabel: "",
    speakerConfirmed: false,
    textMarkdown: "Caption"
  };
}
