import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATED_CHAPTER_SOURCES_SQL,
  scheduleAutomaticChapterDrafts
} from "../src/chapter-drafts";
import type { PodcastEnv } from "../src/env";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent
} from "../src/transcripts";

describe("automatic chapter drafts", () => {
  it("persists one exact-alignment private proposal without editing chapters", async () => {
    const contentJson = serializeTranscriptContent(
      canonicalTranscriptContent("es", [
        {
          id: "cue_001",
          startsAtMs: 0,
          endsAtMs: 29_000,
          speakerLabel: "Jay",
          speakerConfirmed: true,
          textMarkdown: "Apertura aprobada."
        },
        {
          id: "cue_002",
          startsAtMs: 30_000,
          endsAtMs: 59_000,
          speakerLabel: "Jay",
          speakerConfirmed: true,
          textMarkdown: "Proceso creativo aprobado."
        }
      ])
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
            if (query === AUTOMATED_CHAPTER_SOURCES_SQL) {
              return { results: [{
                episode_id: "episode_fixture",
                episode_title: "Ópera en la Selva",
                episode_duration_seconds: 60,
                show_language: "es",
                working_master_id: "master_fixture",
                transcript_id: "transcript_fixture",
                source_language: "es",
                transcript_revision: 3,
                transcript_sha256: transcriptSha256,
                alignment_revision_id: "alignment_revision_fixture"
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
            ) return { success: true, meta: { changes: 0 } };
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
        chapters: [
          { cueId: "cue_001", title: "Apertura" },
          { cueId: "cue_002", title: "Proceso creativo" }
        ]
      }),
      usage: { total_tokens: 94 }
    }));
    const env = {
      ENVIRONMENT: "staging",
      CHAPTER_DRAFT_AUTOMATION_MODE: "staging_generate",
      CHAPTER_DRAFT_AI_ENABLED: "true",
      DB: db,
      AI: { run: aiRun }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticChapterDrafts(env)).toBe(1);
    expect(await scheduleAutomaticChapterDrafts(env)).toBe(0);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(draftStatus).toBe("ready");
    const insertion = statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO editorial_ai_drafts")
    );
    expect(insertion?.query.match(/\?/g)?.length).toBe(
      insertion?.values.length
    );
    expect(insertion?.values).toEqual(expect.arrayContaining([
      "chapters",
      "alignment_revision_fixture",
      "master_fixture",
      transcriptSha256,
      "chapter-draft-v1"
    ]));
    expect(statements.some(({ query }) =>
      /(?:INSERT|UPDATE|DELETE)[\s\S]*episode_chapter_(?:sets|revisions|mutations)/
        .test(query)
    )).toBe(false);
    const audit = statements.find(({ query, values }) =>
      query.includes("INSERT INTO admin_audit_events")
      && values.includes("chapter_draft.automatic_completed")
    );
    expect(audit?.values[1]).toBeNull();
    expect(String(audit?.values[5])).not.toContain("Apertura aprobada");
    expect(String(audit?.values[5])).not.toContain("Proceso creativo");
  });

  it("never inspects production state", async () => {
    const env = {
      ENVIRONMENT: "production",
      CHAPTER_DRAFT_AUTOMATION_MODE: "disabled",
      CHAPTER_DRAFT_AI_ENABLED: "false",
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

    expect(await scheduleAutomaticChapterDrafts(env)).toBe(0);
  });

  it("fails a staging schema scan closed before model invocation", async () => {
    const aiRun = vi.fn();
    const env = {
      ENVIRONMENT: "staging",
      CHAPTER_DRAFT_AUTOMATION_MODE: "staging_generate",
      CHAPTER_DRAFT_AI_ENABLED: "true",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      },
      AI: { run: aiRun }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticChapterDrafts(env)).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
