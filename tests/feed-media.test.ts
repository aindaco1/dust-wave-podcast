import { describe, expect, it } from "vitest";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "../src/env";
import { servePrivateFeed, servePublicFeed } from "../src/feed";
import {
  servePrivateEpisodeAudio,
  servePublicEpisodeAudio
} from "../src/media";
import {
  canonicalTranscriptContent,
  loadVerifiedApprovedTranscriptLanguagesByEpisode,
  serializeTranscriptContent
} from "../src/transcripts";

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
    const transcriptRows = await Promise.all([
      approvedTranscriptRow("episode_fixture", "en"),
      approvedTranscriptRow("episode_fixture", "es")
    ]);
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
              podcast_guid: "d21642df-1816-55c8-b308-6209066e9ef6",
              author_name: "Fixture Author",
              category: "Arts",
              explicit: 0
            };
          },
          async all() {
            if (query.includes("FROM transcripts t")) {
              expect(query).toContain("FROM transcript_approvals latest");
              expect(query).toContain(
                "r.speaker_labels_confirmed = 1"
              );
              return { results: transcriptRows };
            }
            return {
              results: [{
                id: "episode_fixture",
                slug: "episode-fixture",
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
                episode_number: 1,
                has_approved_chapters: 1
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
    expect(xml).toContain("<itunes:author>Fixture Author</itunes:author>");
    expect(xml).toContain("<itunes:name>Fixture Author</itunes:name>");
    expect(xml.match(/<podcast:guid>/gu)).toHaveLength(1);
    expect(xml).toContain(
      "<podcast:guid>d21642df-1816-55c8-b308-6209066e9ef6"
      + "</podcast:guid>"
    );
    expect(xml).toContain("https://media.dustwave.xyz/episodes/episode_fixture/audio");
    expect(xml).toContain('guid isPermaLink="false"');
    expect(xml).toContain(
      '<podcast:chapters url="https://feeds.dustwave.xyz/v1/shows/'
      + 'show-fixture/episodes/episode-fixture/chapters.json" '
      + 'type="application/json+chapters"/>'
    );
    expect(xml).toContain(
      '<podcast:transcript url="https://feeds.dustwave.xyz/v1/shows/'
      + 'show-fixture/episodes/episode-fixture/transcripts/en.vtt" '
      + 'type="text/vtt" language="en"/>'
    );
    expect(xml).toContain(
      '<podcast:transcript url="https://feeds.dustwave.xyz/v1/shows/'
      + 'show-fixture/episodes/episode-fixture/transcripts/es.vtt" '
      + 'type="text/vtt" language="es"/>'
    );
    expect(xml).not.toContain("premium_bonus");

    transcriptRows[0].content_sha256 = "0".repeat(64);
    const responseAfterTamper = await servePublicFeed(
      new Request("https://feeds.dustwave.xyz/show-fixture/rss.xml"),
      baseEnv({ DB: db }),
      "show-fixture"
    );
    const xmlAfterTamper = await responseAfterTamper.text();
    expect(xmlAfterTamper).not.toContain(
      "/episodes/episode-fixture/transcripts/en.vtt"
    );
    expect(xmlAfterTamper).toContain(
      "/episodes/episode-fixture/transcripts/es.vtt"
    );
  });

  it("keeps identical verified transcript payloads scoped to each episode", async () => {
    const first = await approvedTranscriptRow("episode_first", "en");
    const second = {
      ...first,
      episode_id: "episode_second"
    };
    const boundValues: unknown[][] = [];
    const db = {
      prepare(query: string) {
        expect(query).toContain(
          "length(CAST(r.content_json AS BLOB)) <= ?"
        );
        return {
          bind(...values: unknown[]) {
            boundValues.push(values);
            return this;
          },
          async all() {
            return { results: [first, second] };
          }
        };
      }
    } as unknown as D1Database;

    const languages = await loadVerifiedApprovedTranscriptLanguagesByEpisode(
      db,
      ["episode_first", "episode_second", "episode_first"]
    );

    expect(languages.get("episode_first")).toEqual(["en"]);
    expect(languages.get("episode_second")).toEqual(["en"]);
    expect(boundValues).toEqual([[
      "episode_first",
      "episode_second",
      1_000_000
    ]]);
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

  it("serves body-free enclosure HEAD metadata without reading the object", async () => {
    let bodyReads = 0;
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
    const bucket = {
      async head(key: string) {
        expect(key).toBe("podcasts/show/episode/delivery.mp3");
        return {
          size: 10,
          httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "audio/mpeg");
          }
        };
      },
      async get() {
        bodyReads += 1;
        return null;
      }
    } as unknown as R2Bucket;
    const response = await servePublicEpisodeAudio(
      new Request(
        "https://media.dustwave.xyz/episodes/episode_fixture/audio",
        { method: "HEAD" }
      ),
      baseEnv({ DB: db, MEDIA_BUCKET: bucket }),
      "episode_fixture"
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("etag")).toBe('"etag"');
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(bodyReads).toBe(0);
  });

  it("serves entitled private RSS without exposing its bearer token to D1", async () => {
    const rawToken = "a".repeat(43);
    const boundValues: unknown[][] = [];
    const transcriptRows = [
      await approvedTranscriptRow("episode_bonus", "es")
    ];
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
              podcast_guid: "d21642df-1816-55c8-b308-6209066e9ef6",
              author_name: "Premium Fixture Author",
              category: "Arts",
              explicit: 0,
              last_used_at: "2099-01-01 00:00:00"
            };
          },
          async all() {
            if (query.includes("FROM transcripts t")) {
              expect(query).toContain("FROM transcript_approvals latest");
              expect(query).toContain(
                "r.speaker_labels_confirmed = 1"
              );
              return { results: transcriptRows };
            }
            return {
              results: [{
                id: "episode_bonus",
                slug: "bonus",
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
                episode_number: 2,
                has_approved_chapters: 1
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
      "<itunes:author>Premium Fixture Author</itunes:author>"
    );
    expect(xml).toContain(
      "<itunes:name>Premium Fixture Author</itunes:name>"
    );
    expect(xml).toContain(
      "<podcast:guid>d21642df-1816-55c8-b308-6209066e9ef6"
      + "</podcast:guid>"
    );
    expect(xml).toContain(
      `https://media.dustwave.xyz/v1/private/${rawToken}/episodes/episode_bonus/audio`
    );
    expect(xml).toContain(
      `https://feeds.dustwave.xyz/v1/private/${rawToken}/show-fixture/`
      + "episodes/bonus/chapters.json"
    );
    expect(xml).toContain(
      `<podcast:transcript url="https://feeds.dustwave.xyz/v1/private/`
      + `${rawToken}/show-fixture/episodes/bonus/transcripts/es.vtt" `
      + 'type="text/vtt" language="es"/>'
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

async function approvedTranscriptRow(
  episodeId: string,
  language: "en" | "es"
): Promise<Record<string, unknown>> {
  const contentJson = serializeTranscriptContent(
    canonicalTranscriptContent(language, [{
      id: `cue_${episodeId}_${language}`,
      startsAtMs: 0,
      endsAtMs: 2_000,
      speakerLabel: "",
      speakerConfirmed: false,
      textMarkdown: language === "es"
        ? "Texto aprobado."
        : "Approved text."
    }])
  );
  return {
    episode_id: episodeId,
    language,
    revision: 1,
    content_json: contentJson,
    content_sha256: await sha256Hex(contentJson),
    speaker_labels_confirmed: 1,
    approved_at: "2026-07-25T12:00:00.000Z"
  };
}
