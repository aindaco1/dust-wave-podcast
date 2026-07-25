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
              return {
                status: "queued",
                scheduled_at: "2026-07-25 00:00:00"
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
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
        && values[0] === "dynamic-feed"
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
                scheduled_at: "2026-07-25 00:00:00"
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
});
