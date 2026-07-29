import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import {
  parseClipDraftProviderResponse
} from "../src/clip-drafts";
import type { PodcastEnv } from "../src/env";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent,
  type VerifiedApprovedTranscript
} from "../src/transcripts";

describe("AI clip review drafts", () => {
  it("maps exact approved cue ranges to unsaved bounded candidates", async () => {
    const fixture = await clipDraftFixture();
    const response = await handleRequest(fixture.request(), fixture.env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      draft: {
        candidates: [
          {
            title: "A vivid opening",
            reason: "A self-contained story with a clear hook.",
            startCueId: "cue_001",
            endCueId: "cue_002",
            startsAtMs: 0,
            endsAtMs: 59_000,
            durationMs: 59_000
          },
          {
            title: "The creative decision",
            reason: "A useful explanation for artists.",
            startCueId: "cue_003",
            endCueId: "cue_004",
            startsAtMs: 60_000,
            endsAtMs: 119_000,
            durationMs: 59_000
          }
        ]
      },
      source: {
        language: "es",
        revision: 3,
        contentSha256: fixture.transcriptSha256,
        includedCueCount: 4,
        totalCueCount: 4,
        truncated: false
      },
      outputLanguage: "en",
      reviewRequired: true,
      saved: false
    });
    expect(fixture.aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.aiRun.mock.calls[0][0]).toBe(
      "@cf/meta/llama-3.2-3b-instruct"
    );
    expect(fixture.aiRun.mock.calls[0][1]).toMatchObject({
      max_tokens: 1_400,
      temperature: 0.2,
      response_format: { type: "json_schema" }
    });
    expect(fixture.writes.every(({ query }) =>
      query.includes("admin_audit_events")
    )).toBe(true);
    const auditMetadata = fixture.writes
      .filter(({ query }) => query.includes("admin_audit_events"))
      .flatMap(({ values }) => values
        .filter((value) =>
          typeof value === "string" && value.startsWith("{")
        )
        .map((value) => JSON.parse(String(value))));
    expect(auditMetadata).toHaveLength(2);
    expect(JSON.stringify(auditMetadata)).not.toContain("evidencia aprobada");
    expect(JSON.stringify(auditMetadata)).not.toContain("A vivid opening");
  });

  it("fails closed before AI without an exact verified approval", async () => {
    const fixture = await clipDraftFixture({
      transcriptSha256: "0".repeat(64)
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "clip_draft_approved_transcript_required"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("requires complete bounded transcript coverage", async () => {
    const fixture = await clipDraftFixture({
      cueCount: 100,
      cueTextLength: 700
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "clip_draft_full_transcript_required"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
    expect(
      fixture.writes.some(({ query }) => query.includes("admin_audit_events"))
    ).toBe(false);
  });

  it("rate limits atomically and stays disabled in production style", async () => {
    const limited = await clipDraftFixture({ recentCount: 6 });
    const limitedResponse = await handleRequest(
      limited.request(),
      limited.env
    );
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("3600");
    expect(limited.aiRun).not.toHaveBeenCalled();

    const disabled = await clipDraftFixture({ enabled: false });
    const disabledResponse = await handleRequest(
      disabled.request(),
      disabled.env
    );
    expect(disabledResponse.status).toBe(503);
    expect(await disabledResponse.json()).toEqual({
      error: "clip_draft_ai_disabled"
    });
    expect(disabled.aiRun).not.toHaveBeenCalled();
  });

  it("returns a private stable error for unsafe provider output", async () => {
    const fixture = await clipDraftFixture({
      providerResponse: {
        response: JSON.stringify({
          candidates: [{
            title: "<img src=x>",
            reason: "Invented",
            startCueId: "cue_001",
            endCueId: "invented_cue"
          }]
        })
      }
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "clip_draft_ai_unavailable"
    });
    expect(
      fixture.writes.some(({ values }) => values.includes("clip_draft.failed"))
    ).toBe(true);
  });
});

describe("AI clip output validation", () => {
  it("rejects overlap, bad duration, and generated markup", async () => {
    const transcript = approvedTranscript();
    await expect(parseClipDraftProviderResponse(
      provider([
        candidate("cue_001", "cue_002"),
        candidate("cue_002", "cue_003")
      ]),
      transcript
    )).rejects.toThrow(/cue selection is invalid/);

    await expect(parseClipDraftProviderResponse(
      provider([candidate("cue_001", "cue_004")]),
      transcript
    )).rejects.toThrow(/duration is invalid/);

    await expect(parseClipDraftProviderResponse(
      provider([{
        ...candidate("cue_001", "cue_002"),
        title: "<strong>Unsafe</strong>"
      }]),
      transcript
    )).rejects.toThrow(/clip title is invalid/);
  });

  it("derives immutable candidate identity and timing from cue evidence", async () => {
    const first = await parseClipDraftProviderResponse(
      provider([candidate("cue_001", "cue_002")]),
      approvedTranscript()
    );
    const second = await parseClipDraftProviderResponse(
      provider([{
        ...candidate("cue_001", "cue_002"),
        title: "A different editable title"
      }]),
      approvedTranscript()
    );
    expect(first[0]).toMatchObject({
      startCueId: "cue_001",
      endCueId: "cue_002",
      startsAtMs: 0,
      endsAtMs: 59_000,
      durationMs: 59_000
    });
    expect(first[0].id).toMatch(/^clip_candidate_[a-f0-9]{24}$/);
    expect(first[0].id).toBe(second[0].id);
  });
});

function provider(candidates: Array<Record<string, unknown>>) {
  return { response: JSON.stringify({ candidates }) };
}

function candidate(startCueId: string, endCueId: string) {
  return {
    title: "A vivid opening",
    reason: "A self-contained story with a clear hook.",
    startCueId,
    endCueId
  };
}

async function clipDraftFixture({
  enabled = true,
  recentCount = 0,
  transcriptSha256,
  cueCount = 4,
  cueTextLength = 24,
  providerResponse = provider([
    candidate("cue_001", "cue_002"),
    {
      title: "The creative decision",
      reason: "A useful explanation for artists.",
      startCueId: "cue_003",
      endCueId: "cue_004"
    }
  ])
}: {
  enabled?: boolean;
  recentCount?: number;
  transcriptSha256?: string;
  cueCount?: number;
  cueTextLength?: number;
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
      CLIP_DRAFT_AI_ENABLED: enabled ? "true" : "false"
    } as unknown as PodcastEnv,
    aiRun,
    writes,
    transcriptSha256: approvedSha256,
    request() {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/clips/draft",
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
        startsAtMs: 0,
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
      },
      {
        id: "cue_004",
        startsAtMs: 90_000,
        endsAtMs: 119_000,
        speakerLabel: "Jay",
        text: "Cierre"
      }
    ]
  };
}
