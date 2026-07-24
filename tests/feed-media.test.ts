import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { servePrivateFeed, servePublicFeed } from "../src/feed";
import {
  servePrivateEpisodeAudio,
  servePublicEpisodeAudio
} from "../src/media";

function baseEnv(overrides: Partial<PodcastEnv>): PodcastEnv {
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_KEY_PREFIX: "podcasts/",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    ...overrides
  } as PodcastEnv;
}

describe("public feed and media delivery", () => {
  it("renders a stable RSS enclosure from canonical episode state", async () => {
    const db = {
      prepare(query: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (!query.includes("FROM shows")) return null;
            return {
              id: "show_fixture",
              slug: "show-fixture",
              title: "Show Fixture",
              description: "Descripción.",
              language: "es",
              artwork_url: "https://dustwave.xyz/artwork.png",
              canonical_url: "https://dustwave.xyz/podcasts/show-fixture/",
              rss_slug: "show-fixture",
              author_name: "Dust Wave",
              category: "Arts",
              explicit: 0
            };
          },
          async all() {
            return {
              results: [{
                id: "episode_fixture",
                title: "Episode Fixture",
                summary: "Resumen.",
                guid: "urn:uuid:fixture",
                release_at: "2026-07-23T18:00:00.000Z",
                canonical_url: "https://dustwave.xyz/news/podcasts/show-fixture/episode-fixture/",
                duration_seconds: 90,
                audio_mime_type: "audio/mpeg",
                audio_bytes: 100,
                audio_filename: "fixture.mp3",
                explicit: 0,
                season_number: null,
                episode_number: 1
              }]
            };
          }
        };
      }
    } as unknown as D1Database;
    const response = await servePublicFeed(
      new Request("https://feeds.dustwave.xyz/show-fixture/rss.xml"),
      baseEnv({ DB: db }),
      "show-fixture"
    );
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/rss+xml");
    expect(xml).toContain("<title>Show Fixture</title>");
    expect(xml).toContain("https://media.dustwave.xyz/episodes/episode_fixture/audio");
    expect(xml).toContain('guid isPermaLink="false"');
    expect(xml).not.toContain("premium_bonus");
  });

  it("streams a valid byte range without buffering the full object", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              audio_key: "podcasts/show/episode/delivery.mp3",
              audio_bytes: 10,
              audio_mime_type: "audio/mpeg",
              audio_filename: "episode.mp3",
              audio_etag: '"etag"'
            };
          }
        };
      }
    } as unknown as D1Database;
    const body = new TextEncoder().encode("2345");
    const bucket = {
      async get(_key: string, options: R2GetOptions) {
        expect(options.range).toEqual({ offset: 2, length: 4 });
        return {
          body: new Response(body).body,
          size: 10,
          httpEtag: '"etag"',
          range: { offset: 2, length: 4 },
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "audio/mpeg");
          }
        };
      }
    } as unknown as R2Bucket;
    const response = await servePublicEpisodeAudio(
      new Request("https://media.dustwave.xyz/episodes/episode_fixture/audio", {
        headers: { range: "bytes=2-5" }
      }),
      baseEnv({ DB: db, MEDIA_BUCKET: bucket }),
      "episode_fixture"
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("2345");
  });

  it("serves entitled private RSS without exposing its bearer token to D1", async () => {
    const rawToken = "a".repeat(43);
    const boundValues: unknown[][] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            boundValues.push(values);
            return this;
          },
          async first() {
            if (!query.includes("FROM private_feed_tokens")) return null;
            return {
              id: "show_fixture",
              slug: "show-fixture",
              title: "Show Fixture Premium",
              description: "Descripción premium.",
              language: "es",
              artwork_url: null,
              canonical_url: "https://dustwave.xyz/podcasts/show-fixture/",
              rss_slug: "show-fixture",
              author_name: "Dust Wave",
              category: "Arts",
              explicit: 0,
              last_used_at: "2099-01-01 00:00:00"
            };
          },
          async all() {
            return {
              results: [{
                id: "episode_bonus",
                title: "Bonus Fixture",
                summary: "Sólo premium.",
                guid: "urn:uuid:bonus",
                release_at: "2026-07-23T17:00:00.000Z",
                canonical_url:
                  "https://dustwave.xyz/news/podcasts/show-fixture/bonus/",
                duration_seconds: 120,
                audio_mime_type: "audio/mpeg",
                audio_bytes: 200,
                audio_filename: "bonus.mp3",
                explicit: 0,
                season_number: null,
                episode_number: 2
              }]
            };
          },
          async run() {
            throw new Error("A fresh token should not cause a D1 touch");
          }
        };
      }
    } as unknown as D1Database;
    const response = await servePrivateFeed(
      new Request(
        `https://feeds.dustwave.xyz/v1/private/${rawToken}/show-fixture/rss.xml`
      ),
      baseEnv({
        DB: db,
        FEED_TOKEN_PEPPER: "private_feed_pepper_fixture"
      }),
      rawToken,
      "show-fixture"
    );
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(xml).toContain("<title>Show Fixture Premium</title>");
    expect(xml).toContain(
      `https://media.dustwave.xyz/v1/private/${rawToken}/episodes/episode_bonus/audio`
    );
    expect(boundValues.flat()).not.toContain(rawToken);
    expect(boundValues[0][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("streams private media with no shared-cache or CORS exposure", async () => {
    const rawToken = "b".repeat(43);
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              audio_key: "podcasts/show/bonus/delivery.mp3",
              audio_bytes: 5,
              audio_mime_type: "audio/mpeg",
              audio_filename: "bonus.mp3",
              audio_etag: '"private-etag"',
              last_used_at: "2099-01-01 00:00:00"
            };
          },
          async run() {
            throw new Error("A fresh token should not cause a D1 touch");
          }
        };
      }
    } as unknown as D1Database;
    const body = new TextEncoder().encode("audio");
    const bucket = {
      async get() {
        return {
          body: new Response(body).body,
          size: 5,
          httpEtag: '"private-etag"',
          writeHttpMetadata(headers: Headers) {
            headers.set("cache-control", "public, max-age=31536000");
          }
        };
      }
    } as unknown as R2Bucket;
    const response = await servePrivateEpisodeAudio(
      new Request(
        `https://media.dustwave.xyz/v1/private/${rawToken}/episodes/episode_bonus/audio`
      ),
      baseEnv({
        DB: db,
        MEDIA_BUCKET: bucket,
        FEED_TOKEN_PEPPER: "private_feed_pepper_fixture"
      }),
      rawToken,
      "episode_bonus"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(await response.text()).toBe("audio");
  });

  it("returns the same 404 when private-feed configuration is absent", async () => {
    const response = await servePrivateFeed(
      new Request(
        `https://feeds.dustwave.xyz/v1/private/${"c".repeat(43)}/show-fixture/rss.xml`
      ),
      baseEnv({ DB: {} as D1Database }),
      "c".repeat(43),
      "show-fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("feed_not_found");
  });

  it("does not read R2 when entitlement or token lookup fails", async () => {
    const rawToken = "d".repeat(43);
    let r2Reads = 0;
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        };
      }
    } as unknown as D1Database;
    const bucket = {
      async get() {
        r2Reads += 1;
        return null;
      },
      async head() {
        r2Reads += 1;
        return null;
      }
    } as unknown as R2Bucket;
    const response = await servePrivateEpisodeAudio(
      new Request(
        `https://media.dustwave.xyz/v1/private/${rawToken}/episodes/episode_bonus/audio`
      ),
      baseEnv({
        DB: db,
        MEDIA_BUCKET: bucket,
        FEED_TOKEN_PEPPER: "private_feed_pepper_fixture"
      }),
      rawToken,
      "episode_bonus"
    );

    expect(response.status).toBe(404);
    expect(r2Reads).toBe(0);
  });
});
