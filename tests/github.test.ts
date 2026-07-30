import { describe, expect, it } from "vitest";

import {
  buildEpisodeNewsPublication,
  publishEpisodeNewsSnapshot
} from "../src/github";
import type { PodcastEnv } from "../src/env";

const episode = {
  id: "episode_1",
  show_slug: "opera-en-la-selva",
  slug: "episode-one",
  title: "Episode one",
  summary: "Public teaser copy.",
  access: "public" as const,
  public_at: "2026-07-25T12:00:00.000Z",
  canonical_url:
    "https://dustwave.xyz/news/podcasts/opera-en-la-selva/episode-one/",
  duration_seconds: 120,
  audio_mime_type: "audio/mpeg",
  audio_bytes: 12_345,
  publication_revision: 2
};

const origins = {
  mediaOrigin: "https://media.dustwave.xyz/",
  feedOrigin: "https://feeds.dustwave.xyz/"
};

describe("canonical News publication snapshots", () => {
  it("keeps public episode media on the versioned full-page contract", () => {
    expect(buildEpisodeNewsPublication(episode, origins)).toMatchObject({
      publicationSchemaVersion: 1,
      pageMode: "full_episode",
      audioUrl: "https://media.dustwave.xyz/episodes/episode_1/audio",
      downloadUrl:
        "https://media.dustwave.xyz/episodes/episode_1/audio?download=1",
      peaksUrl:
        "https://media.dustwave.xyz/episodes/episode_1/peaks",
      transcriptUrl:
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/episode-one/transcripts",
      chapterUrl:
        "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/"
        + "episodes/episode-one/chapters.json"
    });
  });

  it("constructs premium teasers without entitled media or private timing", () => {
    const publication = buildEpisodeNewsPublication(
      { ...episode, access: "premium_bonus" },
      origins
    );
    expect(publication).toEqual({
      publicationSchemaVersion: 1,
      pageMode: "premium_teaser",
      id: "episode_1",
      showSlug: "opera-en-la-selva",
      slug: "episode-one",
      title: "Episode one",
      summary: "Public teaser copy.",
      publicAt: "2026-07-25T12:00:00.000Z",
      url: "/news/podcasts/opera-en-la-selva/episode-one/",
      canonicalUrl:
        "https://dustwave.xyz/news/podcasts/opera-en-la-selva/episode-one/",
      subscribeUrl: "/podcasts/opera-en-la-selva/#podcast-membership",
      publicationRevision: 2
    });
    expect(JSON.stringify(publication)).not.toMatch(
      /audio|download|transcript|chapter|duration|premiumAt|token/i
    );
  });

  it("allows a due premium bonus into the media-free News publisher", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          return {
            bind() {
              return this;
            },
            async first() {
              return { ...episode, access: "premium_bonus" };
            }
          };
        }
      },
      GITHUB_PUBLISH_MODE: "dry_run"
    } as unknown as PodcastEnv;

    await expect(
      publishEpisodeNewsSnapshot(env, episode.id, episode.publication_revision)
    ).resolves.toEqual({ published: false, dryRun: true });
    expect(queries[0]).toContain("'premium_bonus'");
    expect(queries[0]).toContain("e.media_status = 'ready'");
  });
});
