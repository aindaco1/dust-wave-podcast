import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  AUTOMATED_SHOW_NOTES_SOURCES_SQL,
  scheduleAutomaticShowNotesDrafts
} from "../src/show-notes";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent
} from "../src/transcripts";

describe("automatic show-notes drafts", () => {
  it("persists one exact-revision private proposal without editing the episode", async () => {
    const contentJson = serializeTranscriptContent(
      canonicalTranscriptContent("es", [{
        id: "cue_001",
        startsAtMs: 0,
        endsAtMs: 2_000,
        speakerLabel: "Jay",
        speakerConfirmed: true,
        textMarkdown: "Contenido aprobado y revisado."
      }])
    );
    const transcriptSha256 = await sha256Hex(contentJson);
    const statements: Array<{ query: string; values: unknown[] }> = [];
    let draftStatus = "";
    const db = {
      prepare(query: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            values = bound;
            statements.push({ query, values });
            return statement;
          },
          async all() {
            if (query === AUTOMATED_SHOW_NOTES_SOURCES_SQL) {
              return { results: [{
                episode_id: "episode_fixture",
                episode_title: "Ópera en la Selva",
                episode_summary: "Una conversación.",
                show_language: "es",
                working_master_id: "master_fixture",
                transcript_id: "transcript_fixture",
                source_language: "es",
                transcript_revision: 3,
                transcript_sha256: transcriptSha256
              }] };
            }
            if (query.includes("FROM transcripts t")) {
              return { results: [{
                episode_id: "episode_fixture",
                language: "es",
                revision: 3,
                content_json: contentJson,
                content_sha256: transcriptSha256,
                approved_at: "2026-07-30T10:00:00.000Z"
              }] };
            }
            return { results: [] };
          },
          async run() {
            if (query.includes("INSERT OR IGNORE INTO editorial_ai_drafts")) {
              if (draftStatus) return { success: true, meta: { changes: 0 } };
              draftStatus = "generating";
              return { success: true, meta: { changes: 1 } };
            }
            if (
              query.includes("UPDATE editorial_ai_drafts")
              && query.includes("attempt_count = attempt_count + 1")
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            if (
              query.includes("UPDATE editorial_ai_drafts")
              && query.includes("status = 'ready'")
            ) {
              if (draftStatus !== "generating") {
                return { success: true, meta: { changes: 0 } };
              }
              draftStatus = "ready";
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          }
        };
        return statement;
      },
      async batch(batch: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(batch.map((statement) => statement.run()));
      }
    } as unknown as D1Database;
    const aiRun = vi.fn(async () => ({
      response: JSON.stringify({
        summary: "Resumen factual.",
        showNotesMarkdown: "## Temas\n\n- Evidencia revisada",
        keywords: ["Ópera", "Selva"],
        grounding: {
          namedEntities: [{
            name: "Ópera en la Selva",
            evidence: "Ópera en la Selva"
          }],
          speakerAttributions: []
        }
      }),
      usage: { total_tokens: 123 }
    }));
    const env = {
      ENVIRONMENT: "staging",
      SHOW_NOTES_AUTOMATION_MODE: "staging_generate",
      SHOW_NOTES_AI_ENABLED: "true",
      DB: db,
      AI: { run: aiRun }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticShowNotesDrafts(env)).toBe(1);
    expect(await scheduleAutomaticShowNotesDrafts(env)).toBe(0);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(draftStatus).toBe("ready");
    const insertion = statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO editorial_ai_drafts")
    );
    expect(insertion?.query.match(/\?/g)?.length).toBe(
      insertion?.values.length
    );
    expect(insertion?.values[0]).toMatch(/^editorial_draft_[a-f0-9]{40}$/);
    expect(insertion?.values).toEqual(expect.arrayContaining([
      "episode_fixture",
      "master_fixture",
      "transcript_fixture",
      "es",
      3,
      transcriptSha256,
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "show-notes-v6-grounded-quality"
    ]));
    expect(statements.some(({ query }) => query.includes("UPDATE episodes")))
      .toBe(false);
    const audit = statements.find(({ query, values }) =>
      query.includes("INSERT INTO admin_audit_events")
      && values.includes("show_notes.automatic_draft_completed")
    );
    expect(audit?.values[1]).toBeNull();
    expect(String(audit?.values[5])).not.toContain("Contenido aprobado");
    expect(String(audit?.values[5])).not.toContain("Resumen factual");
  });

  it("never inspects production state", async () => {
    const env = {
      ENVIRONMENT: "production",
      SHOW_NOTES_AUTOMATION_MODE: "disabled",
      SHOW_NOTES_AI_ENABLED: "false",
      DB: {
        prepare() {
          throw new Error("production database must not be read");
        }
      },
      AI: {
        run() {
          throw new Error("production model must not be called");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticShowNotesDrafts(env)).toBe(0);
  });

  it("fails a staging schema scan closed before model invocation", async () => {
    const aiRun = vi.fn();
    const env = {
      ENVIRONMENT: "staging",
      SHOW_NOTES_AUTOMATION_MODE: "staging_generate",
      SHOW_NOTES_AI_ENABLED: "true",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      },
      AI: { run: aiRun }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticShowNotesDrafts(env)).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
