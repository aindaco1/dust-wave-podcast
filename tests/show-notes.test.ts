import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import {
  parseShowNotesProviderResponse,
  projectTranscriptForShowNotes
} from "../src/show-notes";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent,
  type VerifiedApprovedTranscript
} from "../src/transcripts";

describe("AI show-notes drafts", () => {
  it("uses only the verified approved transcript and never saves the draft", async () => {
    const fixture = await showNotesFixture();
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      draft: {
        summary: "A factual summary.",
        showNotesMarkdown: "## In this episode\n\n- A reviewed point",
        keywords: ["Ópera en la Selva"]
      },
      source: {
        language: "es",
        revision: 3,
        contentSha256: fixture.transcriptSha256,
        includedCueCount: 2,
        totalCueCount: 2,
        truncated: false
      },
      outputLanguage: "en",
      reviewRequired: true,
      saved: false
    });
    expect(fixture.aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.aiRun.mock.calls[0][0]).toBe(
      "@cf/meta/llama-4-scout-17b-16e-instruct"
    );
    expect(fixture.aiRun.mock.calls[0][1]).toMatchObject({
      max_tokens: 2_000,
      temperature: 0.2,
      response_format: { type: "json_schema" }
    });
    expect(JSON.stringify(fixture.aiRun.mock.calls[0][1])).toContain(
      "speakerAttributions"
    );
    expect(JSON.stringify(fixture.aiRun.mock.calls[0][1])).toContain(
      '"speakerAttributions":{"type":"array","maxItems":0'
    );
    expect(JSON.stringify(fixture.aiRun.mock.calls[0][1])).toContain(
      '"sections":{"type":"array","minItems":1,"maxItems":6'
    );
    expect(JSON.stringify(fixture.aiRun.mock.calls[0][1])).not.toContain(
      "showNotesMarkdown"
    );
    expect(JSON.stringify(fixture.aiRun.mock.calls[0][1])).not.toContain(
      "confirmedSpeakerLabels"
    );
    expect(
      fixture.writes.some(({ query }) => query.includes("UPDATE episodes"))
    ).toBe(false);
    const auditMetadata = fixture.writes
      .filter(({ query }) => query.includes("admin_audit_events"))
      .flatMap(({ values }) => values
        .filter((value) =>
          typeof value === "string" && value.startsWith("{")
        )
        .map((value) => JSON.parse(String(value))));
    expect(auditMetadata).toHaveLength(2);
    expect(JSON.stringify(auditMetadata)).not.toContain(
      "Contenido aprobado"
    );
  });

  it("repairs one invalid response without retaining its content", async () => {
    const fixture = await showNotesFixture();
    fixture.aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        summary: "A draft that needs repair.",
        sections: [{ heading: "Notes", bullets: ["Alonzo"] }],
        keywords: [],
        grounding: {
          namedEntities: [{ name: "Alonzo" }],
          speakerAttributions: []
        }
      })
    });

    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.aiRun).toHaveBeenCalledTimes(2);
    const repairInput = JSON.stringify(fixture.aiRun.mock.calls[1][1]);
    expect(repairInput).toContain("draft_schema_invalid");
    expect(repairInput).not.toContain("Alonzo");
  });

  it("fails closed before model invocation without a verified approval", async () => {
    const fixture = await showNotesFixture({ transcriptSha256: "0".repeat(64) });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "show_notes_approved_transcript_required"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("enforces the per-admin episode rate limit before model invocation", async () => {
    const fixture = await showNotesFixture({ recentCount: 6 });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toEqual({
      error: "show_notes_generation_rate_limited"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("keeps production-style disabled configuration fail-closed", async () => {
    const fixture = await showNotesFixture({ enabled: false });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "show_notes_ai_disabled"
    });
    expect(fixture.aiRun).not.toHaveBeenCalled();
  });

  it("returns a stable private error when provider output fails validation", async () => {
    const fixture = await showNotesFixture({
      providerResponse: {
        response: JSON.stringify({
          summary: "Safe",
          sections: [{
            heading: "Notes",
            bullets: ["<script>alert(1)</script>"]
          }],
          keywords: [],
          grounding: { namedEntities: [], speakerAttributions: [] }
        })
      }
    });
    const response = await handleRequest(fixture.request(), fixture.env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "show_notes_ai_unavailable"
    });
    expect(fixture.aiRun).toHaveBeenCalledTimes(2);
    expect(
      fixture.writes.some(({ values }) =>
        values.includes("show_notes.draft_failed")
      )
    ).toBe(true);
  });

  it("lists only validated private automatic drafts for review", async () => {
    const episodeEvidenceSha256 = await sha256Hex(JSON.stringify({
      title: "Ópera en la Selva",
      summary: "Existing reviewed summary."
    }));
    const readyRow = {
      id: "editorial_draft_fixture",
      source_language: "es",
      source_transcript_revision: 3,
      source_transcript_sha256: "a".repeat(64),
      included_cue_count: 12,
      total_cue_count: 12,
      transcript_truncated: 0,
      episode_evidence_sha256: episodeEvidenceSha256,
      current_episode_title: "Ópera en la Selva",
      current_episode_summary: "Existing reviewed summary.",
      output_language: "es",
      model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      prompt_version: "show-notes-v10-filter-ungrounded-content",
      draft_json: JSON.stringify({
        summary: "Resumen listo para revisar.",
        showNotesMarkdown: "## Temas\n\n- Punto verificado",
        keywords: ["Ópera"]
      }),
      draft_sha256: "b".repeat(64),
      completed_at: "2026-07-30 10:05:00"
    };
    const fixture = await showNotesFixture({
      savedRows: [
        {
          ...readyRow,
          id: "editorial_draft_stale",
          episode_evidence_sha256: "c".repeat(64)
        },
        readyRow
      ]
    });
    const response = await handleRequest(new Request(
      "https://feeds.dustwave.xyz/v1/admin/episodes/"
      + "episode_fixture/show-notes/drafts",
      {
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
          origin: "https://dustwave.xyz"
        }
      }
    ), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      episodeId: "episode_fixture",
      drafts: [{
        id: "editorial_draft_fixture",
        draft: {
          summary: "Resumen listo para revisar.",
          showNotesMarkdown: "## Temas\n\n- Punto verificado",
          keywords: ["Ópera"]
        },
        source: {
          language: "es",
          revision: 3,
          contentSha256: "a".repeat(64),
          includedCueCount: 12,
          totalCueCount: 12,
          truncated: false
        },
        outputLanguage: "es",
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
        promptVersion: "show-notes-v10-filter-ungrounded-content",
        draftSha256: "b".repeat(64),
        completedAt: "2026-07-30 10:05:00",
        reviewRequired: true,
        saved: true
      }]
    });
  });
});

describe("show-notes model boundaries", () => {
  it("builds deterministic bounded head, middle, and tail evidence", () => {
    const transcript = approvedTranscript(
      Array.from({ length: 12 }, (_unused, index) => ({
        id: `cue_${index}`,
        startsAtMs: index * 1_000,
        endsAtMs: (index + 1) * 1_000,
        speakerLabel: index % 2 ? "Jay" : "",
        text: `${index}-${"evidence ".repeat(45)}`
      }))
    );
    const first = projectTranscriptForShowNotes(transcript, 4_000);
    const second = projectTranscriptForShowNotes(transcript, 4_000);

    expect(first).toEqual(second);
    expect(first.truncated).toBe(true);
    expect(first.excerpt.length).toBeLessThanOrEqual(4_000);
    expect(first.excerpt).toContain("0-evidence");
    expect(first.excerpt).toContain("5-evidence");
    expect(first.excerpt).toContain("11-evidence");
    expect(first.excerpt).toContain("approved transcript cues omitted");
    expect(first.includedCueCount).toBeLessThan(first.totalCueCount);
  });

  it("keeps a long launch transcript whole inside the model input bound", () => {
    const transcript = approvedTranscript(
      Array.from({ length: 650 }, (_unused, index) => ({
        id: `cue_long_${index}`,
        startsAtMs: index * 1_000,
        endsAtMs: (index + 1) * 1_000,
        speakerLabel: "",
        text: `${index}-${"source evidence ".repeat(5)}`
      }))
    );
    const projection = projectTranscriptForShowNotes(transcript);

    expect(projection.excerpt.length).toBeGreaterThan(48_000);
    expect(projection.excerpt.length).toBeLessThanOrEqual(80_000);
    expect(projection.includedCueCount).toBe(650);
    expect(projection.totalCueCount).toBe(650);
    expect(projection.truncated).toBe(false);
  });

  it("normalizes valid JSON output and rejects active or deceptive text", () => {
    const episode = {
      title: "Ópera en la Selva",
      summary: "Existing reviewed summary."
    };
    const projection = projectTranscriptForShowNotes(approvedTranscript([{
      id: "cue_grounding",
      startsAtMs: 0,
      endsAtMs: 1_000,
      speakerLabel: "Jay",
      text: "Cine en la Selva"
    }]));
    expect(parseShowNotesProviderResponse({
      response: JSON.stringify({
        summary: "  Resumen revisable.  ",
        sections: [{ heading: "  Temas  ", bullets: ["  Uno  "] }],
        keywords: ["Cine", "cine", "Selva"],
        grounding: {
          namedEntities: [{ name: "selva" }],
          speakerAttributions: []
        }
      })
    }, { episode, projection })).toEqual({
      summary: "Resumen revisable.",
      showNotesMarkdown: "## Temas\n\n- Uno",
      keywords: ["Cine", "Selva"]
    });
    expect(() => parseShowNotesProviderResponse({
      response: JSON.stringify({
        summary: "Resumen",
        sections: [{
          heading: "Temas",
          bullets: ["<img src=x onerror=alert(1)>"]
        }],
        keywords: [],
        grounding: { namedEntities: [], speakerAttributions: [] }
      })
    }, { episode, projection })).toThrow(/sections\[0\]\.bullets\[0\] is invalid/);
    expect(() => parseShowNotesProviderResponse({
      response: JSON.stringify({
        summary: "Resumen\u202eespoofed",
        sections: [{ heading: "Temas", bullets: ["Seguro"] }],
        keywords: [],
        grounding: { namedEntities: [], speakerAttributions: [] }
      })
    }, { episode, projection })).toThrow(/summary is invalid/);
  });

  it("rejects ungrounded names and unconfirmed speaker attribution", () => {
    const episode = {
      title: "Ópera en la Selva",
      summary: "Existing reviewed summary."
    };
    const projection = projectTranscriptForShowNotes(approvedTranscript([{
      id: "cue_grounding",
      startsAtMs: 0,
      endsAtMs: 1_000,
      speakerLabel: "",
      text: "David: una afirmación sin etiqueta confirmada."
    }]));
    const base = {
      summary: "Resumen",
      sections: [{ heading: "Temas", bullets: ["Alonzo presenta"] }],
      keywords: []
    };

    expect(() => parseShowNotesProviderResponse({
      response: {
        ...base,
        grounding: {
          namedEntities: [{ name: "Alonzo" }],
          speakerAttributions: []
        }
      }
    }, { episode, projection })).toThrow(/sections are invalid/);
    expect(() => parseShowNotesProviderResponse({
      response: {
        ...base,
        grounding: {
          namedEntities: [],
          speakerAttributions: [{
            speakerLabel: "David",
            evidence: "David: una afirmación sin etiqueta confirmada."
          }]
        }
      }
    }, { episode, projection })).toThrow(/speaker grounding is invalid/);
  });

  it("removes ungrounded named content while preserving safe source topics", () => {
    const episode = {
      title: "Ópera en la Selva",
      summary: "Existing reviewed summary."
    };
    const projection = projectTranscriptForShowNotes(approvedTranscript([{
      id: "cue_filter",
      startsAtMs: 0,
      endsAtMs: 1_000,
      speakerLabel: "",
      text: "Cine en la Selva"
    }]));

    expect(parseShowNotesProviderResponse({
      response: {
        summary: "Alonzo presents a topic.",
        sections: [{
          heading: "Topics",
          bullets: ["Alonzo presents a topic.", "Independent film"]
        }],
        keywords: ["Alonzo", "film"],
        grounding: {
          namedEntities: [{ name: "Alonzo" }],
          speakerAttributions: []
        }
      }
    }, { episode, projection })).toEqual({
      summary: "Existing reviewed summary.",
      showNotesMarkdown: "## Topics\n\n- Independent film",
      keywords: ["film"]
    });
  });

  it("rejects attribution prose and invalid structured sections", () => {
    const episode = {
      title: "Dust Don't Settle",
      summary: "David Jennings and Alonzo explore independent film."
    };
    const projection = projectTranscriptForShowNotes(approvedTranscript([{
      id: "cue_quality",
      startsAtMs: 0,
      endsAtMs: 1_000,
      speakerLabel: "",
      text: "Independent film topics and local infrastructure."
    }]));
    const grounding = {
      namedEntities: [
        {
          name: "David Jennings"
        },
        {
          name: "Alonzo"
        }
      ],
      speakerAttributions: []
    };

    expect(() => parseShowNotesProviderResponse({
      response: {
        summary: "David Jennings and Alonzo explore independent film.",
        sections: [{
          heading: "Topics",
          bullets: ["Local infrastructure"]
        }],
        keywords: ["film"],
        grounding
      }
    }, { episode, projection })).toThrow(/attribution is invalid/);
    expect(() => parseShowNotesProviderResponse({
      response: {
        summary: "A neutral overview of independent film.",
        sections: [],
        keywords: ["film"],
        grounding: { namedEntities: [], speakerAttributions: [] }
      }
    }, { episode, projection })).toThrow(/sections are invalid/);
    expect(() => parseShowNotesProviderResponse({
      response: {
        summary: "A neutral overview of independent film.",
        sections: [{ heading: "Topics", bullets: ["- Preformatted"] }],
        keywords: ["film"],
        grounding: { namedEntities: [], speakerAttributions: [] }
      }
    }, { episode, projection })).toThrow(/must be plain text/);
  });
});

async function showNotesFixture({
  enabled = true,
  recentCount = 0,
  transcriptSha256,
  providerResponse = {
    response: JSON.stringify({
      summary: "A factual summary.",
      sections: [{
        heading: "In this episode",
        bullets: ["A reviewed point"]
      }],
      keywords: ["Ópera en la Selva"],
      grounding: {
        namedEntities: [{
          name: "Ópera en la Selva"
        }],
        speakerAttributions: []
      }
    }),
    usage: {
      prompt_tokens: 120,
      completion_tokens: 48,
      total_tokens: 168
    }
  },
  savedRows = []
}: {
  enabled?: boolean;
  recentCount?: number;
  transcriptSha256?: string;
  providerResponse?: unknown;
  savedRows?: Array<Record<string, unknown>>;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const contentJson = serializeTranscriptContent(
    canonicalTranscriptContent("es", [
      {
        id: "cue_001",
        startsAtMs: 0,
        endsAtMs: 2_000,
        speakerLabel: "Jay",
        speakerConfirmed: true,
        textMarkdown: "Contenido aprobado y revisado."
      },
      {
        id: "cue_002",
        startsAtMs: 2_000,
        endsAtMs: 4_000,
        speakerLabel: "",
        speakerConfirmed: false,
        textMarkdown: "Segunda evidencia."
      }
    ])
  );
  const approvedSha256 = transcriptSha256 ?? await sha256Hex(contentJson);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
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
              duration_seconds: 4,
              audio_key: null,
              audio_bytes: null,
              audio_etag: null,
              audio_mime_type: null,
              media_status: "missing"
            };
          }
          if (query.includes("SELECT title, summary")) {
            return {
              title: "Ópera en la Selva",
              summary: "Existing reviewed summary."
            };
          }
          if (query.includes("COUNT(*) AS count")) {
            return { count: recentCount };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "producer", show_id: "show_opera_en_la_selva" }]
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
      SHOW_NOTES_AI_ENABLED: enabled ? "true" : "false"
    } as unknown as PodcastEnv,
    aiRun,
    queries,
    writes,
    contentJson,
    transcriptSha256: approvedSha256,
    request() {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/episode_fixture/show-notes/draft",
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

function approvedTranscript(
  cues: VerifiedApprovedTranscript["cues"]
): VerifiedApprovedTranscript {
  return {
    language: "es",
    revision: 1,
    approvedAt: "2026-07-29T06:00:00.000Z",
    contentSha256: "a".repeat(64),
    cues
  };
}
