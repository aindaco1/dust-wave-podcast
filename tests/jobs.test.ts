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
              return { success: true };
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
  });
});
