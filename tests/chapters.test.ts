import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  canonicalChapterContent,
  normalizeEpisodeChapters,
  serializeChapterContent,
  servePrivateEpisodeChapters,
  servePublicEpisodeChapters
} from "../src/chapters";

describe("episode chapter review contract", () => {
  it("normalizes ordered, bilingual-capable chapters without losing safe links", () => {
    const chapters = normalizeEpisodeChapters([
      chapter("chapter_intro", 0, "Introducción / Introduction"),
      {
        ...chapter("chapter_selva", 125_500, "La selva / The jungle"),
        url: "https://dustwave.xyz/news/",
        imageUrl: "https://media.dustwave.xyz/chapters/selva.jpg",
        toc: false
      }
    ], 240_000);

    expect(chapters).toEqual([
      {
        id: "chapter_intro",
        startsAtMs: 0,
        title: "Introducción / Introduction",
        url: "",
        imageUrl: "",
        toc: true
      },
      {
        id: "chapter_selva",
        startsAtMs: 125_500,
        title: "La selva / The jungle",
        url: "https://dustwave.xyz/news/",
        imageUrl: "https://media.dustwave.xyz/chapters/selva.jpg",
        toc: false
      }
    ]);
  });

  it("rejects unsafe, unordered, and out-of-duration chapter state", () => {
    expect(() => normalizeEpisodeChapters([
      chapter("chapter_intro", 1, "Intro")
    ])).toThrow(/first chapter/i);
    expect(() => normalizeEpisodeChapters([
      chapter("chapter_intro", 0, "Intro"),
      chapter("chapter_next", 0, "Next")
    ])).toThrow(/after the previous/);
    expect(() => normalizeEpisodeChapters([
      chapter("chapter_intro", 0, "Intro"),
      chapter("chapter_next", 60_000, "Next")
    ], 60_000)).toThrow(/episode duration/);
    expect(() => normalizeEpisodeChapters([{
      ...chapter("chapter_intro", 0, "Intro"),
      url: "http://tracking.example/chapter"
    }])).toThrow(/HTTPS URL/);
    expect(() => normalizeEpisodeChapters([
      chapter("chapter_intro", 0, "Safe\u202espoofed")
    ])).toThrow(/unsafe control/);
    expect(() => normalizeEpisodeChapters([
      { ...chapter("chapter_intro", 0, "Hidden"), toc: false }
    ])).toThrow(/table of contents/);
  });

  it("serves an approved revision as Podcasting 2.0 JSON chapters", async () => {
    const content = canonicalChapterContent(normalizeEpisodeChapters([
      chapter("chapter_intro", 0, "Introducción / Introduction"),
      {
        ...chapter("chapter_guest", 94_250, "Invitada / Guest"),
        imageUrl: "https://media.dustwave.xyz/chapters/guest.jpg",
        url: "https://dustwave.xyz/people/guest/",
        toc: false
      }
    ]));
    const contentJson = serializeChapterContent(content);
    const response = await servePublicEpisodeChapters(
      new Request(
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/belleza-y-alegria/chapters.json"
      ),
      publicEnv(chapterDatabase({
        revision: 2,
        content_json: contentJson,
        content_sha256: await sha256(contentJson)
      })),
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const payload = await response.json() as {
      version: string;
      chapters: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/json+chapters"
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(payload).toEqual({
      version: "1.2.0",
      chapters: [
        { startTime: 0, title: "Introducción / Introduction" },
        {
          startTime: 94.25,
          title: "Invitada / Guest",
          img: "https://media.dustwave.xyz/chapters/guest.jpg",
          url: "https://dustwave.xyz/people/guest/",
          toc: false
        }
      ]
    });
    expect(JSON.stringify(payload)).not.toContain("chapter_guest");
  });

  it("fails closed on missing, malformed, or hash-mismatched approval data", async () => {
    const url =
      "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
      + "episodes/belleza-y-alegria/chapters.json";
    const missing = await servePublicEpisodeChapters(
      new Request(url),
      publicEnv(chapterDatabase(null)),
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const tampered = await servePublicEpisodeChapters(
      new Request(url),
      publicEnv(chapterDatabase({
        revision: 1,
        content_json: serializeChapterContent(canonicalChapterContent(
          normalizeEpisodeChapters([chapter("chapter_intro", 0, "Intro")])
        )),
        content_sha256: "0".repeat(64)
      })),
      "opera-en-la-selva",
      "belleza-y-alegria"
    );

    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(tampered.status).toBe(404);
    expect(await tampered.json()).toEqual({ error: "chapters_not_found" });
  });

  it("supports body-free HEAD, weak ETags, and private fail-closed routing", async () => {
    const contentJson = serializeChapterContent(canonicalChapterContent(
      normalizeEpisodeChapters([chapter("chapter_intro", 0, "Intro")])
    ));
    const env = publicEnv(chapterDatabase({
      revision: 1,
      content_json: contentJson,
      content_sha256: await sha256(contentJson)
    }));
    const url =
      "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
      + "episodes/belleza-y-alegria/chapters.json";
    const initial = await servePublicEpisodeChapters(
      new Request(url),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const etag = initial.headers.get("etag") as string;
    const head = await servePublicEpisodeChapters(
      new Request(url, { method: "HEAD" }),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const notModified = await servePublicEpisodeChapters(
      new Request(url, { headers: { "if-none-match": `W/${etag}` } }),
      env,
      "opera-en-la-selva",
      "belleza-y-alegria"
    );
    const privateMissing = await servePrivateEpisodeChapters(
      new Request(
        `https://feeds.dustwave.xyz/v1/private/${"a".repeat(43)}/`
        + "opera-en-la-selva/episodes/bonus/chapters.json"
      ),
      { ...env, FEED_TOKEN_PEPPER: undefined } as unknown as PodcastEnv,
      "a".repeat(43),
      "opera-en-la-selva",
      "bonus"
    );

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(privateMissing.status).toBe(404);
    expect(privateMissing.headers.get("cache-control")).toContain("private");
    expect(privateMissing.headers.has("access-control-allow-origin")).toBe(false);
  });
});

function chapter(id: string, startsAtMs: number, title: string) {
  return {
    id,
    startsAtMs,
    title,
    url: "",
    imageUrl: "",
    toc: true
  };
}

function chapterDatabase(
  revision: {
    revision: number;
    content_json: string;
    content_sha256: string;
  } | null,
  episode: { id: string } | null = { id: "episode_fixture" }
): D1Database {
  return {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("FROM episodes e")) return episode;
          if (query.includes("FROM episode_chapter_approvals")) {
            return revision;
          }
          throw new Error("Unexpected chapter query");
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
