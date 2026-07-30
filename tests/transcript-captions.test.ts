import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent,
  serveAdminEpisodeTranscriptCaptions
} from "../src/transcripts";

const content = canonicalTranscriptContent("es", [{
  id: "cue_1",
  startsAtMs: 1_000,
  endsAtMs: 3_000,
  speakerLabel: "Jay",
  speakerConfirmed: true,
  textMarkdown: "**Hola** & <u>selva</u>"
}, {
  id: "cue_2",
  startsAtMs: 3_000,
  endsAtMs: 5_000,
  speakerLabel: "Invitada",
  speakerConfirmed: false,
  textMarkdown: "Una voz por confirmar."
}]);
const contentJson = serializeTranscriptContent(content);

describe("private saved transcript caption exports", () => {
  it("downloads exact checksum-verified WebVTT and SubRip revisions", async () => {
    const contentSha256 = await sha256Hex(contentJson);
    const env = authorizedEnv(contentSha256);
    const webVtt = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("vtt"),
      env,
      "episode_fixture",
      "es",
      "vtt"
    );

    expect(webVtt.status).toBe(200);
    expect(webVtt.headers.get("content-type"))
      .toBe("text/vtt; charset=utf-8");
    expect(webVtt.headers.get("content-language")).toBe("es");
    expect(webVtt.headers.get("x-podcast-transcript-revision")).toBe("4");
    expect(webVtt.headers.get("content-disposition")).toBe(
      'attachment; filename="transcript-es-revision-4.vtt"'
    );
    expect(webVtt.headers.get("cache-control"))
      .toBe("private, no-store, max-age=0");
    expect(webVtt.headers.get("access-control-allow-origin"))
      .toBe("https://dustwave.xyz");
    expect(webVtt.headers.get("access-control-allow-credentials")).toBe("true");
    expect(webVtt.headers.get("cross-origin-resource-policy"))
      .toBe("same-site");
    expect(await webVtt.text()).toBe([
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:03.000",
      "<v Jay>Hola &amp; selva</v>",
      "",
      "2",
      "00:00:03.000 --> 00:00:05.000",
      "Una voz por confirmar.",
      ""
    ].join("\n"));

    const subRip = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("srt"),
      env,
      "episode_fixture",
      "es",
      "srt"
    );
    expect(subRip.status).toBe(200);
    expect(subRip.headers.get("content-type"))
      .toBe("application/x-subrip; charset=utf-8");
    expect(subRip.headers.get("content-disposition")).toBe(
      'attachment; filename="transcript-es-revision-4.srt"'
    );
    expect(await subRip.text()).toBe([
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "Jay: Hola &amp; selva",
      "",
      "2",
      "00:00:03,000 --> 00:00:05,000",
      "Una voz por confirmar.",
      ""
    ].join("\n"));

    const etag = subRip.headers.get("etag") as string;
    const notModified = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("srt", { "if-none-match": etag }),
      env,
      "episode_fixture",
      "es",
      "srt"
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-length")).toBeNull();

    const head = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("vtt", {}, "HEAD"),
      env,
      "episode_fixture",
      "es",
      "vtt"
    );
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(1);
    expect(await head.text()).toBe("");
  });

  it("fails closed on digest drift and before transcript reads outside scope", async () => {
    const mismatch = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("srt"),
      authorizedEnv("0".repeat(64)),
      "episode_fixture",
      "es",
      "srt"
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: "transcript_content_mismatch"
    });

    let transcriptReads = 0;
    const outOfScope = await serveAdminEpisodeTranscriptCaptions(
      adminRequest("vtt"),
      authorizedEnv("0".repeat(64), "show_other", () => {
        transcriptReads += 1;
      }),
      "episode_fixture",
      "es",
      "vtt"
    );
    expect(outOfScope.status).toBe(404);
    expect(await outOfScope.json()).toEqual({ error: "episode_not_found" });
    expect(transcriptReads).toBe(0);
  });
});

function adminRequest(
  format: "vtt" | "srt",
  headers: Record<string, string> = {},
  method = "GET"
): Request {
  return new Request(
    "https://feeds.dustwave.xyz/v1/admin/episodes/episode_fixture/"
      + `transcripts/es/captions.${format}`,
    {
      method,
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
        origin: "https://dustwave.xyz",
        ...headers
      }
    }
  );
}

function authorizedEnv(
  contentSha256: string,
  roleShowId = "show_fixture",
  onTranscriptRead: () => void = () => {}
): PodcastEnv {
  const db = {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("FROM admin_sessions s")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: "unused"
            };
          }
          if (query.includes("FROM episodes")) {
            return {
              id: "episode_fixture",
              show_id: "show_fixture",
              duration_seconds: 5,
              audio_key: null,
              audio_bytes: null,
              audio_etag: null,
              audio_mime_type: null,
              media_status: "pending"
            };
          }
          if (query.includes("FROM transcripts t")) {
            onTranscriptRead();
            return {
              id: "transcript_fixture",
              language: "es",
              source: "editor",
              status: "needs_review",
              content_json: contentJson,
              content_sha256: contentSha256,
              revision: 4,
              speaker_labels_confirmed: 0,
              approved_revision: 3,
              approved_at: "2026-07-28 00:00:00",
              created_at: "2026-07-27 00:00:00",
              updated_at: "2026-07-29 00:00:00",
              alignment_id: null,
              alignment_status: null,
              alignment_adapter: null,
              alignment_model: null,
              alignment_completed_at: null,
              aligned_word_count: 0
            };
          }
          return null;
        },
        async all() {
          return {
            results: [{ role: "producer", show_id: roleShowId }]
          };
        },
        async run() {
          return { meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database;
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_KEY_PREFIX: "podcasts/",
    MEDIA_BUCKET_NAME: "dustwave-media-staging",
    ADMIN_SESSION_SECRET: "admin_session_secret_fixture",
    DB: db
  } as unknown as PodcastEnv;
}
