import { describe, expect, it } from "vitest";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "../src/env";
import {
  PublicFeedValidationError,
  validateAndRecordPublicFeed,
  validatePublicPodcastFeed
} from "../src/feed-validation";
import { servePublicFeed } from "../src/feed";
import {
  canonicalTranscriptContent,
  serializeTranscriptContent
} from "../src/transcripts";

describe("canonical feed launch validation", () => {
  it("validates and records the exact generated RSS body during Publish", async () => {
    const fixture = await feedFixture();
    const evidence = await validateAndRecordPublicFeed(
      fixture.env,
      "show_opera"
    );

    expect(evidence).toMatchObject({
      showId: "show_opera",
      feedUrl:
        "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml",
      validatorVersion: "dustwave-rss-launch-v3",
      itemCount: 1
    });
    expect(evidence.feedSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      fixture.statements.some(({ query, values }) =>
        query.includes("INSERT INTO show_feed_validations")
        && values[0] === "show_opera"
        && values[1] === "valid"
        && values[4] === evidence.feedSha256
        && values[5] === 1
        && values[6] === null
      )
    ).toBe(true);
  });

  it("rejects missing launch metadata and a mismatched canonical self URL", async () => {
    const fixture = await feedFixture();
    const feedUrl =
      "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml";
    const response = await servePublicFeed(
      new Request(feedUrl),
      fixture.env,
      "opera-en-la-selva"
    );
    const xml = await response.text();

    expect(validatePublicPodcastFeed(xml, feedUrl)).toEqual({
      itemCount: 1
    });
    expect(xml).toContain(
      'type="text/vtt" language="es"/>'
    );
    expect(xml).toContain(
      "<podcast:guid>d21642df-1816-55c8-b308-6209066e9ef6"
      + "</podcast:guid>"
    );
    expect(() =>
      validatePublicPodcastFeed(
        xml.replace("<itunes:owner>", ""),
        feedUrl
      )
    ).toThrowError(expect.objectContaining({
      name: "PublicFeedValidationError",
      code: "feed_metadata_incomplete"
    }));
    expect(() =>
      validatePublicPodcastFeed(
        xml,
        "https://feeds.dustwave.xyz/another-show/rss.xml"
      )
    ).toThrowError(expect.objectContaining({
      code: "feed_metadata_incomplete"
    }));
    const item = xml.match(/<item>[\s\S]*?<\/item>/u)?.[0];
    if (!item) throw new Error("Expected the generated feed fixture item.");
    expect(() =>
      validatePublicPodcastFeed(
        xml.replace("</channel>", `${item}</channel>`),
        feedUrl
      )
    ).toThrowError(expect.objectContaining({
      code: "feed_guid_invalid"
    }));
    expect(() =>
      validatePublicPodcastFeed(
        xml.replace(
          'type="text/vtt" language="es"/>',
          'type="text/html" language="es"/>'
        ),
        feedUrl
      )
    ).toThrowError(expect.objectContaining({
      code: "feed_transcript_metadata_invalid"
    }));
    expect(() =>
      validatePublicPodcastFeed(
        xml.replace(
          "d21642df-1816-55c8-b308-6209066e9ef6",
          "d21642df-1816-45c8-b308-6209066e9ef6"
        ),
        feedUrl
      )
    ).toThrowError(expect.objectContaining({
      code: "feed_channel_guid_invalid"
    }));
    expect(() =>
      validatePublicPodcastFeed(
        xml.replace(
          "</podcast:guid>",
          "</podcast:guid>"
            + "<podcast:guid>"
            + "d21642df-1816-55c8-b308-6209066e9ef6"
            + "</podcast:guid>"
        ),
        feedUrl
      )
    ).toThrowError(expect.objectContaining({
      code: "feed_channel_guid_invalid"
    }));
  });

  it("records a closed failure without persisting feed content", async () => {
    const fixture = await feedFixture({ category: "" });

    await expect(
      validateAndRecordPublicFeed(fixture.env, "show_opera")
    ).rejects.toThrowError(expect.objectContaining({
      code: "feed_channel_metadata_incomplete"
    }));
    const failure = fixture.statements.find(({ query, values }) =>
      query.includes("INSERT INTO show_feed_validations")
      && values[1] === "failed"
    );
    expect(failure?.values.slice(4, 9)).toEqual([
      null,
      null,
      "feed_channel_metadata_incomplete",
      expect.any(String),
      null
    ]);
    expect(JSON.stringify(failure)).not.toContain(
      "Historias de música, bosque y comunidad."
    );
  });

  it("rejects unsafe XML declarations before inspecting item metadata", () => {
    expect(() =>
      validatePublicPodcastFeed(
        '<?xml version="1.0" encoding="UTF-8"?>'
          + '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
          + '<rss version="2.0"><channel></channel></rss>',
        "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml"
      )
    ).toThrowError(expect.objectContaining<Partial<PublicFeedValidationError>>({
      code: "feed_document_invalid"
    }));
  });
});

async function feedFixture({
  category = "Arts"
}: {
  category?: string;
} = {}): Promise<{
  env: PodcastEnv;
  statements: Array<{ query: string; values: unknown[] }>;
}> {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const contentJson = serializeTranscriptContent(
    canonicalTranscriptContent("es", [{
      id: "cue_episode_opera_1_es",
      startsAtMs: 0,
      endsAtMs: 2_000,
      speakerLabel: "",
      speakerConfirmed: false,
      textMarkdown: "Texto aprobado."
    }])
  );
  const transcriptRow = {
    episode_id: "episode_opera_1",
    language: "es",
    revision: 1,
    content_json: contentJson,
    content_sha256: await sha256Hex(contentJson),
    speaker_labels_confirmed: 1,
    approved_at: "2026-07-25T12:00:00.000Z"
  };
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          statements.push({ query, values });
          return this;
        },
        async first() {
          if (
            query.includes("SELECT id, rss_slug")
            && query.includes("status != 'archived'")
          ) {
            return {
              id: "show_opera",
              rss_slug: "opera-en-la-selva"
            };
          }
          if (
            query.includes("rss_slug, podcast_guid, author_name")
            && query.includes("WHERE rss_slug = ?")
          ) {
            return {
              id: "show_opera",
              slug: "opera-en-la-selva",
              title: "Ópera en la Selva",
              description: "Historias de música, bosque y comunidad.",
              language: "es",
              artwork_url: "https://dustwave.xyz/opera.jpg",
              canonical_url:
                "https://dustwave.xyz/podcasts/opera-en-la-selva/",
              rss_slug: "opera-en-la-selva",
              podcast_guid: "d21642df-1816-55c8-b308-6209066e9ef6",
              author_name: "Dust Wave",
              category,
              explicit: 0
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM transcripts t")) {
            return { results: [transcriptRow] };
          }
          if (query.includes("FROM episodes episode")) {
            return {
              results: [{
                id: "episode_opera_1",
                slug: "el-primer-episodio",
                title: "El primer episodio",
                summary: "Una introducción.",
                guid: "urn:dustwave:episode:opera-1",
                release_at: "2026-07-25T12:00:00.000Z",
                canonical_url:
                  "https://dustwave.xyz/news/el-primer-episodio/",
                duration_seconds: 600,
                audio_mime_type: "audio/mpeg",
                audio_bytes: 1_000,
                audio_filename: "opera-1.mp3",
                explicit: 0,
                season_number: 1,
                episode_number: 1,
                has_approved_chapters: 0
              }]
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      FEED_ORIGIN: "https://feeds.dustwave.xyz",
      MEDIA_ORIGIN: "https://media.dustwave.xyz",
      PODCAST_AUTHOR_NAME: "Dust Wave",
      PODCAST_OWNER_EMAIL: "podcasts@dustwave.xyz"
    } as unknown as PodcastEnv,
    statements
  };
}
