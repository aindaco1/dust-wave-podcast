import { describe, expect, it } from "vitest";

import {
  canonicalTranscriptContent,
  normalizeTranscriptCues,
  serializeTranscriptContent
} from "../src/transcripts";

describe("transcript review contract", () => {
  it("normalizes bilingual timed-text cues without inventing word timing", () => {
    const cues = normalizeTranscriptCues([
      {
        id: "cue_001",
        startsAtMs: 0,
        endsAtMs: 2_250,
        speakerLabel: "Jay",
        speakerConfirmed: true,
        textMarkdown: "  **Belleza** y alegría.  "
      },
      {
        id: "cue_002",
        startsAtMs: 2_250,
        endsAtMs: 4_000,
        speakerLabel: "",
        speakerConfirmed: true,
        textMarkdown: "Beauty and *joy*."
      }
    ], 4_000);

    expect(cues).toEqual([
      {
        id: "cue_001",
        startsAtMs: 0,
        endsAtMs: 2_250,
        speakerLabel: "Jay",
        speakerConfirmed: true,
        textMarkdown: "**Belleza** y alegría."
      },
      {
        id: "cue_002",
        startsAtMs: 2_250,
        endsAtMs: 4_000,
        speakerLabel: "",
        speakerConfirmed: false,
        textMarkdown: "Beauty and *joy*."
      }
    ]);
    expect(canonicalTranscriptContent("es", cues)).toEqual({
      schemaVersion: 1,
      language: "es",
      cues
    });
    expect(cues).not.toHaveProperty("words");
  });

  it("rejects overlap, duplicate IDs, and timing past the reviewed duration", () => {
    expect(() => normalizeTranscriptCues([
      cue("cue_001", 0, 2_000),
      cue("cue_002", 1_999, 3_000)
    ], 4_000)).toThrow(/overlaps/);
    expect(() => normalizeTranscriptCues([
      cue("cue_001", 0, 2_000),
      cue("cue_001", 2_000, 3_000)
    ], 4_000)).toThrow(/duplicate id/);
    expect(() => normalizeTranscriptCues([
      cue("cue_001", 0, 4_001)
    ], 4_000)).toThrow(/episode duration/);
  });

  it("rejects active HTML and unsafe speaker labels at the server boundary", () => {
    expect(() => normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        textMarkdown: "<img src=x onerror=alert(1)>"
      }
    ])).toThrow(/emphasis and underline only/);
    expect(() => normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        speakerLabel: "<svg onload=alert(1)>"
      }
    ])).toThrow(/speakerLabel is invalid/);
  });

  it("allows only the shared timed-text emphasis/underline representation", () => {
    expect(normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        textMarkdown: "<u>Subrayado</u>, **fuerte**, y *énfasis*."
      }
    ])[0].textMarkdown).toBe(
      "<u>Subrayado</u>, **fuerte**, y *énfasis*."
    );
    expect(() => normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        textMarkdown: "<u>Unclosed"
      }
    ])).toThrow(/invalid underline markup/);
    expect(() => normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        textMarkdown: "</u>Unopened"
      }
    ])).toThrow(/invalid underline markup/);
  });

  it("caps the canonical transcript payload before it reaches D1", () => {
    const cues = normalizeTranscriptCues(
      Array.from({ length: 500 }, (_unused, index) => ({
        ...cue(
          `cue_${String(index).padStart(4, "0")}`,
          index * 2_000,
          (index + 1) * 2_000
        ),
        textMarkdown: "á".repeat(1_000)
      }))
    );

    expect(() => serializeTranscriptContent(
      canonicalTranscriptContent("es", cues)
    )).toThrow(/one-megabyte review limit/);
  });
});

function cue(id: string, startsAtMs: number, endsAtMs: number) {
  return {
    id,
    startsAtMs,
    endsAtMs,
    speakerLabel: "",
    speakerConfirmed: false,
    textMarkdown: "Caption"
  };
}
