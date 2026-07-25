import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  canonicalTranscriptContent,
  normalizeTranscriptCues,
  serializeTranscriptContent,
  servePublicEpisodeTranscripts
} from "../src/transcripts";

type RevisionFixture = {
  language: "en" | "es";
  revision: number;
  content_json: string;
  content_sha256: string;
  approved_at: string;
};

describe("public approved transcript projection", () => {
  it("returns only immutable approved bilingual revisions as plain timed text", async () => {
    const spanish = await revisionFixture(
      "es",
      "<u>Belleza</u>, **alegría**, y *selva*.",
      "Jay"
    );
    const english = await revisionFixture(
      "en",
      "**Beauty**, joy, and the *jungle*.",
      "Jay"
    );
    const response = await servePublicEpisodeTranscripts(
      new Request(
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/belleza-y-alegria/transcripts",
        { headers: { origin: "https://unrelated-public-reader.example" } }
      ),
      publicEnv(transcriptDatabase([english, spanish])),
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const payload = await response.json() as {
      schemaVersion: number;
      episode: { canonicalUrl: string };
      transcripts: Array<{
        language: string;
        revision: number;
        contentSha256: string;
        cues: Array<{
          speakerLabel: string;
          text: string;
          startsAtMs: number;
        }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.episode.canonicalUrl).toBe(
      "https://dustwave.xyz/news/podcasts/opera-en-la-selva/"
      + "belleza-y-alegria/"
    );
    expect(payload.transcripts.map(({ language }) => language)).toEqual([
      "en",
      "es"
    ]);
    expect(payload.transcripts[0].contentSha256).toBe(english.content_sha256);
    expect(payload.transcripts[0].cues[0]).toMatchObject({
      speakerLabel: "Jay",
      startsAtMs: 1_000,
      text: "Beauty, joy, and the jungle."
    });
    expect(payload.transcripts[1].cues[0].text).toBe(
      "Belleza, alegría, y selva."
    );
    expect(JSON.stringify(payload)).not.toContain("textMarkdown");
  });

  it("fails closed on malformed or hash-mismatched approved revision data", async () => {
    const hashMismatch = await revisionFixture(
      "en",
      "Approved words.",
      ""
    );
    hashMismatch.content_sha256 = "0".repeat(64);
    const malformed: RevisionFixture = {
      language: "es",
      revision: 1,
      content_json: JSON.stringify({
        schemaVersion: 1,
        language: "es",
        cues: [{
          id: "cue_unsafe",
          startsAtMs: 0,
          endsAtMs: 2_000,
          speakerLabel: "",
          speakerConfirmed: false,
          textMarkdown: "<img src=x onerror=alert(1)>"
        }]
      }),
      content_sha256: "1".repeat(64),
      approved_at: "2026-07-25 12:00:00"
    };
    const response = await servePublicEpisodeTranscripts(
      new Request(
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/belleza-y-alegria/transcripts"
      ),
      publicEnv(transcriptDatabase([hashMismatch, malformed])),
      "opera-en-la-selva",
      "belleza-y-alegria"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcripts: [] });
  });

  it("conceals draft, future, and premium-only episode records behind a 404", async () => {
    let transcriptRead = false;
    const db = transcriptDatabase([], null, () => {
      transcriptRead = true;
    });
    const response = await servePublicEpisodeTranscripts(
      new Request(
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/premium-bonus/transcripts"
      ),
      publicEnv(db),
      "opera-en-la-selva",
      "premium-bonus"
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "episode_not_found" });
    expect(transcriptRead).toBe(false);
  });

  it("supports body-free HEAD and weak conditional requests", async () => {
    const revision = await revisionFixture("es", "Texto aprobado.", "");
    const env = publicEnv(transcriptDatabase([revision]));
    const url =
      "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
      + "episodes/belleza-y-alegria/transcripts";
    const initial = await servePublicEpisodeTranscripts(
      new Request(url),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const etag = initial.headers.get("etag") as string;
    const head = await servePublicEpisodeTranscripts(
      new Request(url, { method: "HEAD" }),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const notModified = await servePublicEpisodeTranscripts(
      new Request(url, {
        headers: { "if-none-match": `W/${etag}, "unrelated"` }
      }),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(etag);
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("etag")).toBe(etag);
  });
});

async function revisionFixture(
  language: "en" | "es",
  textMarkdown: string,
  speakerLabel: string
): Promise<RevisionFixture> {
  const content = canonicalTranscriptContent(
    language,
    normalizeTranscriptCues([{
      id: `cue_${language}_001`,
      startsAtMs: 1_000,
      endsAtMs: 3_000,
      speakerLabel,
      speakerConfirmed: Boolean(speakerLabel),
      textMarkdown
    }])
  );
  const contentJson = serializeTranscriptContent(content);
  return {
    language,
    revision: 1,
    content_json: contentJson,
    content_sha256: await sha256(contentJson),
    approved_at: "2026-07-25 12:00:00"
  };
}

function transcriptDatabase(
  revisions: RevisionFixture[],
  episode: { id: string; canonical_url: string } | null = {
    id: "episode_belleza_y_alegria",
    canonical_url:
      "https://dustwave.xyz/news/podcasts/opera-en-la-selva/"
      + "belleza-y-alegria/"
  },
  onTranscriptRead: () => void = () => {}
): D1Database {
  return {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (!query.includes("FROM episodes e")) {
            throw new Error("Unexpected public transcript first query");
          }
          if (!query.includes("e.media_status = 'ready'")) {
            throw new Error("Public transcript query must require ready media");
          }
          return episode;
        },
        async all() {
          if (!query.includes("FROM transcripts t")) {
            throw new Error("Unexpected public transcript list query");
          }
          onTranscriptRead();
          return { results: revisions };
        }
      };
    }
  } as unknown as D1Database;
}

function publicEnv(db: D1Database): PodcastEnv {
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_KEY_PREFIX: "podcasts/",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    DB: db
  } as unknown as PodcastEnv;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
