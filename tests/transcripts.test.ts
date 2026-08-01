import { describe, expect, it } from "vitest";

import {
  canonicalTranscriptContent,
  normalizeTranscriptCues,
  serializeTranscriptContent,
  verifyTranscriptRevisionCommit
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
    expect(() => normalizeTranscriptCues([
      {
        ...cue("cue_001", 0, 2_000),
        textMarkdown: "Safe prefix\u202espoofed direction"
      }
    ])).toThrow(/direction-override/);
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

  it("verifies exact committed revision evidence instead of D1 batch metadata", async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const evidence = transcriptRevisionCommitEvidence();

    await expect(verifyTranscriptRevisionCommit(
      transcriptRevisionVerificationDatabase(queries, evidence.transcriptId),
      evidence
    )).resolves.toBe(true);

    expect(queries).toHaveLength(1);
    expect(queries[0].query).toContain("JOIN transcript_mutations mutation");
    expect(queries[0].query).toContain("JOIN transcript_revisions revision");
    expect(queries[0].query).toContain("JOIN admin_audit_events audit");
    expect(queries[0].query).toContain("transcript.approved_revision IS NULL");
    expect(queries[0].values).toEqual([
      evidence.mutationId,
      evidence.baseRevision,
      evidence.targetRevision,
      evidence.contentSha256,
      evidence.revisionId,
      evidence.auditId,
      evidence.transcriptId,
      evidence.targetRevision,
      evidence.contentSha256,
      1
    ]);
  });

  it("fails closed when exact transcript revision evidence is absent", async () => {
    await expect(verifyTranscriptRevisionCommit(
      transcriptRevisionVerificationDatabase([], null),
      transcriptRevisionCommitEvidence()
    )).resolves.toBe(false);
  });
});

function transcriptRevisionCommitEvidence() {
  return {
    transcriptId: "transcript_fixture",
    mutationId: "mutation_fixture",
    revisionId: "transcript_revision_fixture",
    auditId: "audit_fixture",
    baseRevision: 3,
    targetRevision: 4,
    contentSha256: "a".repeat(64),
    speakerLabelsConfirmed: true
  };
}

function transcriptRevisionVerificationDatabase(
  queries: Array<{ query: string; values: unknown[] }>,
  transcriptId: string | null
): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          queries.push({ query, values });
          return statement;
        },
        async first() {
          return transcriptId ? { id: transcriptId } : null;
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

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
