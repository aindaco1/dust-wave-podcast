import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { servePublicFeed } from "../src/feed";
import { servePublicEpisodeAudio } from "../src/media";

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
                public_at: "2026-07-23T18:00:00.000Z",
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
});
