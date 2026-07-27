import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  getAdminPodcastAnalyticsOverview,
  recordPodcastMediaDelivery,
  recordPodcastPlayerEvent
} from "../src/podcast-analytics";

function analyticsHarness() {
  const boundValues: unknown[][] = [];
  const batches: Array<Array<{ values: unknown[] }>> = [];
  const dataPoints: AnalyticsEngineDataPoint[] = [];
  const db = {
    prepare(query: string) {
      const statement = {
        query,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          boundValues.push(values);
          return this;
        },
        async first() {
          if (query.includes("FROM episodes")) {
            return {
              id: "episode_fixture",
              show_id: "show_fixture",
              duration_seconds: 120,
              audio_bytes: 1_200
            };
          }
          return null;
        }
      };
      return statement;
    },
    async batch(statements: Array<{ values: unknown[] }>) {
      batches.push(statements);
      return [];
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    ANALYTICS: {
      writeDataPoint(point: AnalyticsEngineDataPoint) {
        dataPoints.push(point);
      }
    },
    ANALYTICS_HASH_SECRET: "analytics_hash_secret_fixture",
    ALLOWED_ORIGINS: "https://dustwave.xyz,https://www.dustwave.xyz",
    SITE_ORIGIN: "https://dustwave.xyz"
  } as unknown as PodcastEnv;
  return { env, boundValues, batches, dataPoints };
}

function listenerRequest(
  url: string,
  init: RequestInit = {}
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Spotify/9.0 (iPhone; iOS 19) Mozilla/5.0"
    );
  }
  if (!headers.has("cf-connecting-ip")) {
    headers.set(
      "cf-connecting-ip",
      "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd"
    );
  }
  return new Request(url, { ...init, headers });
}

describe("privacy-minimized podcast analytics", () => {
  it("records one qualified minute without persisting raw network data", async () => {
    const harness = analyticsHarness();
    await recordPodcastMediaDelivery(
      listenerRequest(
        "https://media.dustwave.xyz/episodes/episode_fixture/audio"
      ),
      harness.env,
      {
        id: "episode_fixture",
        showId: "show_fixture",
        durationSeconds: 120,
        audioBytes: 1_200
      },
      { bytesServed: 600, status: 206 }
    );

    expect(harness.batches).toHaveLength(1);
    expect(harness.batches[0]).toHaveLength(2);
    expect(harness.boundValues.flat()).not.toContain(
      "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd"
    );
    expect(harness.boundValues.flat()).not.toContain(
      "Spotify/9.0 (iPhone; iOS 19) Mozilla/5.0"
    );
    expect(harness.boundValues.flat()[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.dataPoints[0]?.doubles?.[0]).toBe(1);
    expect(harness.dataPoints[0]?.blobs).toContain("spotify");
    expect(harness.dataPoints[0]?.blobs).toContain("mobile");
  });

  it("observes but does not count a sub-minute range or known bot", async () => {
    const harness = analyticsHarness();
    await recordPodcastMediaDelivery(
      listenerRequest(
        "https://media.dustwave.xyz/episodes/episode_fixture/audio"
      ),
      harness.env,
      {
        id: "episode_fixture",
        showId: "show_fixture",
        durationSeconds: 120,
        audioBytes: 1_200
      },
      { bytesServed: 599, status: 206 }
    );
    expect(harness.batches).toHaveLength(0);
    expect(harness.dataPoints[0]?.doubles?.[0]).toBe(0);

    await recordPodcastMediaDelivery(
      listenerRequest(
        "https://media.dustwave.xyz/episodes/episode_fixture/audio",
        { headers: { "user-agent": "ExampleBot/1.0" } }
      ),
      harness.env,
      {
        id: "episode_fixture",
        showId: "show_fixture",
        durationSeconds: 120,
        audioBytes: 1_200
      },
      { bytesServed: 1_200, status: 200 }
    );
    expect(harness.dataPoints).toHaveLength(1);
  });

  it("accepts a valid first-party 60-second player event", async () => {
    const harness = analyticsHarness();
    const response = await recordPodcastPlayerEvent(
      listenerRequest(
        "https://feeds.dustwave.xyz/v1/analytics/player-events",
        {
          method: "POST",
          headers: {
            origin: "https://dustwave.xyz",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            episodeId: "episode_fixture",
            event: "engaged_play",
            seconds: 60
          })
        }
      ),
      harness.env
    );

    expect(response.status).toBe(202);
    expect(harness.batches).toHaveLength(1);
    expect(harness.dataPoints[0]?.blobs).toContain("engaged_play");
  });

  it("rejects cross-origin player events and anonymous admin reads", async () => {
    const harness = analyticsHarness();
    const rejected = await recordPodcastPlayerEvent(
      listenerRequest(
        "https://feeds.dustwave.xyz/v1/analytics/player-events",
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            episodeId: "episode_fixture",
            event: "engaged_play",
            seconds: 60
          })
        }
      ),
      harness.env
    );
    expect(rejected.status).toBe(403);
    expect(harness.batches).toHaveLength(0);

    const admin = await getAdminPodcastAnalyticsOverview(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/show_fixture/analytics/overview?days=30"
      ),
      harness.env,
      "show_fixture"
    );
    expect(admin.status).toBe(401);
    expect(admin.headers.get("cache-control")).toContain("private");
  });
});
