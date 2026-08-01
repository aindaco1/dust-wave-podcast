import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import {
  parseChapterDraftProviderResponse
} from "../src/chapter-drafts";
import type { PodcastEnv } from "../src/env";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent,
  type VerifiedApprovedTranscript
} from "../src/transcripts";

describe("AI chapter review drafts", () => {
  it("maps exact approved cue identities to an unsaved chapter proposal", async () => {
    const fixture = await chapterDraftFixture();
    const response = await handleRequest(fixture.request(), fixture.env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      draft: {
        chapters: [
          {
            startsAtMs: 0,
            title: "Opening context",
            url: "",
            imageUrl: "",
            toc: true
          },
          {
            startsAtMs: 60_000,
            title: "Creative process",
            url: "",
            imageUrl: "",
            toc: true
          }
        ]
      },
      source: {
        language: "es",
        revision: 3,
        contentSha256: fixture.transcriptSha256,
        includedCueCount: 3,
        totalCueCount: 3,
        truncated: false
      },
      outputLanguage: "en",
      reviewRequired: true,
      saved: false
    });
    expect(fixture.aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.aiRun.mock.calls[0][0]).toBe(
      "@cf/meta/llama-3.1-8b-instruct-fast"
    );
    expect(fixture.aiRun.mock.calls[0][1]).toMatchObject({
      max_tokens: 1_200,
      temperature: 0.2,
      response_format: { type: "json_schema" }
    });
    expect(
      fixture.writes.some(({ query }) =>
        /episode_chapter_(?:sets|revisions|mutations)/.test(query)
      )
    ).toBe(false);
    const auditMetadata = fixture.writes
      .filter(({ query }) => query.includes("admin_audit_events"))
      .flatMap(({ values }) => values
        .filter((value) =>
          typeof value === "string" && value.startsWith("{")
        )
        .map((value) => JSON.parse(String(value))));
    expect(auditMetadata).toHaveLength(2);
    expect(JSON.stringify(auditMetadata)).not.toContain("evidencia aprobada");
  });

  it("fails closed before AI without an exact verified approval", async () => {
    const fixture = await chapterDraftFixture({
      transcriptSha256: "0".repeat(64)
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "chapter_draft_approved_transcript_required"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("requires complete bounded transcript coverage", async () => {
    const fixture = await chapterDraftFixture({
      cueCount: 100,
      cueTextLength: 900
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "chapter_draft_full_transcript_required"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
    expect(
      fixture.writes.some(({ query }) => query.includes("admin_audit_events"))
    ).toBe(false);
  });

  it("atomically rate limits a producer before AI invocation", async () => {
    const fixture = await chapterDraftFixture({ recentCount: 6 });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toEqual({
      error: "chapter_draft_generation_rate_limited"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("keeps the production-style configuration fail closed", async () => {
    const fixture = await chapterDraftFixture({ enabled: false });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "chapter_draft_ai_disabled"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("returns a stable private error for invented or unsafe provider output", async () => {
    const fixture = await chapterDraftFixture({
      providerResponse: {
        response: JSON.stringify({
          chapters: [
            { cueId: "cue_001", title: "Opening" },
            { cueId: "invented_cue", title: "<img src=x>" }
          ]
        })
      }
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "chapter_draft_ai_unavailable"
    });
    expect(
      fixture.writes.some(({ values }) =>
        values.includes("chapter_draft.failed")
      )
    ).toBe(true);
  });

  it("lists only current alignment-pinned private proposals", async () => {
    const source = await chapterDraftFixture();
    const episodeEvidenceSha256 = await sha256Hex(JSON.stringify({
      title: "Ópera en la Selva",
      durationSeconds: 90
    }));
    const readyRow = {
      id: "editorial_chapter_draft_fixture",
      source_alignment_revision_id: "alignment_revision_fixture",
      source_language: "es",
      source_transcript_revision: 3,
      source_transcript_sha256: source.transcriptSha256,
      included_cue_count: 3,
      total_cue_count: 3,
      transcript_truncated: 0,
      episode_evidence_sha256: episodeEvidenceSha256,
      current_episode_title: "Ópera en la Selva",
      current_duration_seconds: 90,
      output_language: "es",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      prompt_version: "chapter-draft-v1",
      draft_json: JSON.stringify({
        chapters: [
          {
            id: "chapter_ai_aaaaaaaaaaaaaaaaaaaaaaaa",
            startsAtMs: 0,
            title: "Apertura",
            url: "",
            imageUrl: "",
            toc: true
          },
          {
            id: "chapter_ai_bbbbbbbbbbbbbbbbbbbbbbbb",
            startsAtMs: 60_000,
            title: "Proceso creativo",
            url: "",
            imageUrl: "",
            toc: true
          }
        ]
      }),
      draft_sha256: "b".repeat(64),
      completed_at: "2026-07-30 10:05:00"
    };
    const fixture = await chapterDraftFixture({
      transcriptSha256: source.transcriptSha256,
      savedRows: [
        {
          ...readyRow,
          id: "editorial_chapter_draft_stale",
          episode_evidence_sha256: "c".repeat(64)
        },
        readyRow
      ]
    });
    const response = await handleRequest(new Request(
      "https://feeds.dustwave.xyz/v1/admin/episodes/"
      + "episode_fixture/chapters/drafts",
      {
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
          origin: "https://dustwave.xyz"
        }
      }
    ), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      episodeId: "episode_fixture",
      drafts: [{
        id: "editorial_chapter_draft_fixture",
        draft: {
          chapters: [
            { startsAtMs: 0, title: "Apertura" },
            { startsAtMs: 60_000, title: "Proceso creativo" }
          ]
        },
        source: {
          language: "es",
          revision: 3,
          contentSha256: source.transcriptSha256,
          alignmentRevisionId: "alignment_revision_fixture",
          includedCueCount: 3,
          totalCueCount: 3,
          truncated: false
        },
        outputLanguage: "es",
        promptVersion: "chapter-draft-v1",
        reviewRequired: true,
        saved: true
      }]
    });
  });
});

describe("AI chapter output validation", () => {
  it("rejects reordered cue identities and normalizes the first marker to zero", async () => {
    const transcript = approvedTranscript();
    await expect(parseChapterDraftProviderResponse(
      {
        response: JSON.stringify({
          chapters: [
            { cueId: "cue_002", title: "Wrong first cue" }
          ]
        })
      },
      transcript,
      90_000
    )).rejects.toThrow(/cue selection is invalid/);

    const chapters = await parseChapterDraftProviderResponse(
      {
        response: JSON.stringify({
          chapters: [
            { cueId: "cue_001", title: "  Apertura  " },
            { cueId: "cue_003", title: "Proceso creativo" }
          ]
        })
      },
      transcript,
      90_000
    );
    expect(chapters.map(({ startsAtMs, title }) => ({ startsAtMs, title })))
      .toEqual([
        { startsAtMs: 0, title: "Apertura" },
        { startsAtMs: 60_000, title: "Proceso creativo" }
      ]);
    expect(chapters.every(({ id }) =>
      /^chapter_ai_[a-f0-9]{24}$/.test(id)
    )).toBe(true);
  });
});

async function chapterDraftFixture({
  enabled = true,
  recentCount = 0,
  transcriptSha256,
  cueCount = 3,
  cueTextLength = 24,
  savedRows = [],
  providerResponse = {
    response: JSON.stringify({
      chapters: [
        { cueId: "cue_001", title: "Opening context" },
        { cueId: "cue_003", title: "Creative process" }
      ]
    }),
    usage: {
      prompt_tokens: 140,
      completion_tokens: 32,
      total_tokens: 172
    }
  }
}: {
  enabled?: boolean;
  recentCount?: number;
  transcriptSha256?: string;
  cueCount?: number;
  cueTextLength?: number;
  savedRows?: Array<Record<string, unknown>>;
  providerResponse?: unknown;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const cues = Array.from({ length: cueCount }, (_unused, index) => ({
    id: `cue_${String(index + 1).padStart(3, "0")}`,
    startsAtMs: index * 30_000,
    endsAtMs: index * 30_000 + 29_000,
    speakerLabel: "Jay",
    speakerConfirmed: true,
    textMarkdown: `${index + 1} evidencia-aprobada-${"x".repeat(
      cueTextLength
    )}`
  }));
  const contentJson = serializeTranscriptContent(
    canonicalTranscriptContent("es", cues)
  );
  const approvedSha256 = transcriptSha256 ?? await sha256Hex(contentJson);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (
            query.includes("duration_seconds")
            && query.includes("FROM episodes")
          ) {
            return {
              id: "episode_fixture",
              show_id: "show_opera_en_la_selva",
              duration_seconds: cueCount * 30,
              audio_key: null,
              audio_bytes: null,
              audio_etag: null,
              audio_mime_type: null,
              media_status: "missing"
            };
          }
          if (query.includes("SELECT title")) {
            return { title: "Ópera en la Selva" };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{
                role: "producer",
                show_id: "show_opera_en_la_selva"
              }]
            };
          }
          if (query.includes("FROM transcripts t")) {
            return {
              results: [{
                episode_id: "episode_fixture",
                language: "es",
                revision: 3,
                content_json: contentJson,
                content_sha256: approvedSha256,
                approved_at: "2026-07-29T06:00:00.000Z"
              }]
            };
          }
          if (query.includes("FROM editorial_ai_drafts")) {
            return { results: savedRows };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          return {
            success: true,
            meta: {
              changes: query.includes("SELECT COUNT(*)")
                ? recentCount >= 6 ? 0 : 1
                : 1
            }
          };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  const aiRun = vi.fn(async (
    _model: string,
    _input: unknown,
    _options?: unknown
  ) => providerResponse);
  return {
    env: {
      AI: { run: aiRun },
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret,
      CHAPTER_DRAFT_AI_ENABLED: enabled ? "true" : "false"
    } as unknown as PodcastEnv,
    aiRun,
    writes,
    transcriptSha256: approvedSha256,
    request() {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/chapters/draft",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            "x-podcast-csrf": csrfToken
          },
          body: JSON.stringify({
            sourceLanguage: "es",
            outputLanguage: "en"
          })
        }
      );
    }
  };
}

function approvedTranscript(): VerifiedApprovedTranscript {
  return {
    language: "es",
    revision: 3,
    approvedAt: "2026-07-29T06:00:00.000Z",
    contentSha256: "a".repeat(64),
    cues: [
      {
        id: "cue_001",
        startsAtMs: 500,
        endsAtMs: 29_000,
        speakerLabel: "Jay",
        text: "Apertura"
      },
      {
        id: "cue_002",
        startsAtMs: 30_000,
        endsAtMs: 59_000,
        speakerLabel: "Jay",
        text: "Contexto"
      },
      {
        id: "cue_003",
        startsAtMs: 60_000,
        endsAtMs: 89_000,
        speakerLabel: "Jay",
        text: "Proceso"
      }
    ]
  };
}
