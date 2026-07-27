import { describe, expect, it } from "vitest";

import {
  processPodcastJob,
  scheduleDuePublications
} from "../src/jobs";
import type { PodcastEnv } from "../src/env";
import type { PodcastJob } from "../src/types";

describe("publication job revisions", () => {
  it("queues the revision stored on the durable job, not a later episode value", async () => {
    const sent: PodcastJob[] = [];
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          return {
            async run() {
              return { success: true };
            },
            async all() {
              return {
                results: [{
                  id: "job_due",
                  show_id: "show_opera",
                  episode_id: "episode_opera",
                  destination: "news",
                  publication_revision: 2
                }]
              };
            }
          };
        }
      },
      JOBS: {
        async send(job: PodcastJob) {
          sent.push(job);
        }
      }
    } as unknown as PodcastEnv;

    await scheduleDuePublications(env);

    expect(
      queries.some((query) =>
        query.includes("Previous attempt did not finish")
        && query.includes("'-15 minutes'")
      )
    ).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({
        id: "job_due",
        type: "publish-news",
        publicationRevision: 2
      })
    ]);
    expect(
      queries.some((query) =>
        query.includes("j.publication_revision")
        && !query.includes("e.publication_revision")
      )
    ).toBe(true);
  });

  it("loads a queued job only when its immutable revision matches", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const env = {
      DB: {
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
                query.includes("rss_slug, author_name")
                && query.includes("WHERE rss_slug = ?")
              ) {
                return {
                  id: "show_opera",
                  slug: "opera-en-la-selva",
                  title: "Ópera en la Selva",
                  description: "Una conversación sobre la ópera.",
                  language: "es",
                  artwork_url: "https://dustwave.xyz/opera.jpg",
                  canonical_url:
                    "https://dustwave.xyz/podcasts/opera-en-la-selva/",
                  rss_slug: "opera-en-la-selva",
                  author_name: "Dust Wave",
                  category: "Arts",
                  explicit: 0
                };
              }
              return {
                status: "queued",
                scheduled_at: "2026-07-25 00:00:00",
                destination: "rss",
                show_id: "show_opera",
                current_publication_revision: 4,
                site_status: null,
                github_commit_sha: null
              };
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      },
      FEED_ORIGIN: "https://feeds.dustwave.xyz",
      MEDIA_ORIGIN: "https://media.dustwave.xyz",
      PODCAST_AUTHOR_NAME: "Dust Wave",
      PODCAST_OWNER_EMAIL: "podcasts@dustwave.xyz"
    } as unknown as PodcastEnv;
    const job: PodcastJob = {
      id: "job_rss_revision_4",
      type: "publish-rss",
      showId: "show_opera",
      episodeId: "episode_opera",
      publicationRevision: 4,
      requestedAt: "2026-07-25T00:00:00.000Z"
    };

    await processPodcastJob(env, job);

    expect(
      statements.find(({ query }) =>
        query.includes("AND publication_revision = ?")
      )?.values
    ).toEqual(["job_rss_revision_4", "episode_opera", 4]);
    expect(
      statements.some(({ query, values }) =>
        query.includes("status = 'succeeded'")
        && String(values[0]).startsWith("validated-feed:")
      )
    ).toBe(true);
    expect(
      statements.some(({ query, values }) =>
        query.includes("INSERT INTO show_feed_validations")
        && values[0] === "show_opera"
        && values[1] === "valid"
        && values[5] === 0
      )
    ).toBe(true);
    expect(
      statements.some(({ query, values }) =>
        query.includes("status IN ('queued', 'failed')")
        && values.slice(0, 3).join(",")
          === "job_rss_revision_4,episode_opera,4"
      )
    ).toBe(true);
  });

  it("does not run a duplicate message while another worker owns the job", async () => {
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
              return {
                status: "running",
                scheduled_at: "2026-07-25 00:00:00",
                destination: "news",
                show_id: "show_opera",
                current_publication_revision: 2,
                site_status: null,
                github_commit_sha: null
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
    } as unknown as PodcastEnv;

    await processPodcastJob(env, {
      id: "job_news_revision_2",
      type: "publish-news",
      showId: "show_opera",
      episodeId: "episode_opera",
      publicationRevision: 2,
      requestedAt: "2026-07-25T00:00:00.000Z"
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("j.status");
    expect(queries[0]).toContain("site_publications");
  });

  it("finishes a News retry from committed site evidence without a second provider write", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(query: string) {
          let values: unknown[] = [];
          return {
            bind(...bound: unknown[]) {
              values = bound;
              statements.push({ query, values });
              return this;
            },
            async first() {
              return {
                status: "failed",
                scheduled_at: "2026-07-25 00:00:00",
                destination: "news",
                show_id: "show_opera",
                current_publication_revision: 5,
                site_status: "succeeded",
                github_commit_sha: "commit_already_published"
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      },
      GITHUB_PUBLISH_MODE: "live"
    } as unknown as PodcastEnv;

    await processPodcastJob(env, {
      id: "job_news_revision_5",
      type: "publish-news",
      showId: "show_opera",
      episodeId: "episode_opera",
      publicationRevision: 5,
      requestedAt: "2026-07-25T00:00:00.000Z"
    });

    expect(
      statements.some(({ query }) =>
        query.includes("FROM episodes e")
        && query.includes("e.status = 'published'")
      )
    ).toBe(false);
    expect(
      statements.some(({ query, values }) =>
        query.includes("status = 'succeeded'")
        && values[0] === "commit_already_published"
      )
    ).toBe(true);
  });

  it("cancels a queued message whose revision is no longer current", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(query: string) {
          let values: unknown[] = [];
          return {
            bind(...bound: unknown[]) {
              values = bound;
              statements.push({ query, values });
              return this;
            },
            async first() {
              return {
                status: "queued",
                scheduled_at: "2026-07-25 00:00:00",
                destination: "news",
                show_id: "show_opera",
                current_publication_revision: 8,
                site_status: null,
                github_commit_sha: null
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
    } as unknown as PodcastEnv;

    await processPodcastJob(env, {
      id: "job_news_revision_7",
      type: "publish-news",
      showId: "show_opera",
      episodeId: "episode_opera",
      publicationRevision: 7,
      requestedAt: "2026-07-25T00:00:00.000Z"
    });

    expect(statements).toHaveLength(2);
    expect(statements[1]?.query).toContain("status = 'canceled'");
    expect(statements[1]?.query).toContain("status IN ('queued', 'failed')");
    expect(statements[1]?.values).toEqual([
      "job_news_revision_7",
      "episode_opera",
      7
    ]);
  });

  it("rejects a queue payload that disagrees with durable destination state", async () => {
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
              return {
                status: "queued",
                scheduled_at: "2026-07-25 00:00:00",
                destination: "rss",
                show_id: "show_opera",
                current_publication_revision: 9,
                site_status: null,
                github_commit_sha: null
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
    } as unknown as PodcastEnv;

    await expect(processPodcastJob(env, {
      id: "job_rss_revision_9",
      type: "publish-news",
      showId: "show_opera",
      episodeId: "episode_opera",
      publicationRevision: 9,
      requestedAt: "2026-07-25T00:00:00.000Z"
    })).rejects.toThrow("Publication job does not match durable state");
    expect(queries).toHaveLength(1);
  });
});
