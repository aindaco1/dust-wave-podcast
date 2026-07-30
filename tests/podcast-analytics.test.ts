import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  getAdminPodcastAnalyticsOverview,
  recordPodcastMediaDelivery,
  recordPodcastPlayerEvent
} from "../src/podcast-analytics";

function analyticsHarness({ authorized = false } = {}) {
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
          if (authorized && query.includes("FROM admin_sessions")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: "csrf_fixture"
            };
          }
          if (authorized && query.includes("FROM subscriptions")) {
            return { listener_count: 4 };
          }
          return null;
        },
        async all() {
          if (authorized && query.includes("FROM admin_user_roles")) {
            return {
              results: [{
                role: "analyst",
                show_id: "show_fixture"
              }]
            };
          }
          if (
            authorized
            && query.includes("FROM podcast_analytics_rollups")
          ) {
            const windowDate = new Date().toISOString().slice(0, 10);
            return {
              results: [
                {
                  event_type: "qualified_download",
                  window_date: windowDate,
                  episode_id: "episode_fixture",
                  episode_title: "Episode fixture",
                  app_code: "browser",
                  device_code: "desktop",
                  country_code: "US",
                  event_count: 10
                },
                {
                  event_type: "engaged_play",
                  window_date: windowDate,
                  episode_id: "episode_fixture",
                  episode_title: "Episode fixture",
                  app_code: "browser",
                  device_code: "desktop",
                  country_code: "US",
                  event_count: 5
                }
              ]
            };
          }
          if (
            authorized
            && query.includes("FROM podcast_analytics_progress_rollups")
          ) {
            const windowDate = new Date().toISOString().slice(0, 10);
            return {
              results: [25, 50, 75, 100].map(
                (milestone, index) => ({
                  window_date: windowDate,
                  episode_id: "episode_fixture",
                  episode_title: "Episode fixture",
                  milestone_percent: milestone,
                  event_count: 4 - index
                })
              )
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
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
    ...(authorized
      ? { ADMIN_SESSION_SECRET: "admin_session_secret_fixture" }
      : {}),
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

  it("records only validated web-player completion milestones", async () => {
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
            event: "web_player_completion",
            seconds: 120,
            milestones: [25, 50, 75, 100]
          })
        }
      ),
      harness.env
    );

    expect(response.status).toBe(202);
    expect(harness.batches).toHaveLength(1);
    expect(harness.batches[0]).toHaveLength(8);
    expect(harness.dataPoints).toHaveLength(4);
    expect(harness.dataPoints.map((point) => point.doubles?.[3])).toEqual(
      [25, 50, 75, 100]
    );
    expect(harness.boundValues.flat()).not.toContain(
      "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd"
    );
    expect(harness.boundValues.flat()).not.toContain(
      "Spotify/9.0 (iPhone; iOS 19) Mozilla/5.0"
    );
  });

  it("rejects impossible, duplicate, or unordered completion claims", async () => {
    const harness = analyticsHarness();
    const request = (seconds: number, milestones: number[]) =>
      recordPodcastPlayerEvent(
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
              event: "web_player_completion",
              seconds,
              milestones
            })
          }
        ),
        harness.env
      );

    await expect(request(60, [100])).rejects.toThrow(
      "seconds do not reach"
    );
    await expect(request(120, [25, 25])).rejects.toThrow(
      "unique ascending"
    );
    await expect(request(120, [50, 25])).rejects.toThrow(
      "unique ascending"
    );
    expect(harness.batches).toHaveLength(0);
    expect(harness.dataPoints).toHaveLength(0);
  });

  it("returns bounded completion counts and rates to a show analyst", async () => {
    const harness = analyticsHarness({ authorized: true });
    const response = await getAdminPodcastAnalyticsOverview(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/show_fixture/analytics/overview?days=7",
        {
          headers: {
            cookie:
              "dustwave_podcast_admin_session=session_token_fixture"
          }
        }
      ),
      harness.env,
      "show_fixture"
    );
    const payload = await response.json<{
      totals: {
        qualifiedDownloads: number;
        engagedPlays: number;
        activePremiumListeners: number;
      };
      episodes: Array<{
        webPlayerCompletion: Record<string, number>;
        webPlayerCompletionRates: Record<string, number>;
      }>;
      webPlayerCompletion: {
        scope: string;
        engagedPlays: number;
        counts: Record<string, number>;
        rates: Record<string, number>;
      };
    }>();

    expect(response.status).toBe(200);
    expect(payload.totals).toEqual({
      qualifiedDownloads: 10,
      engagedPlays: 5,
      activePremiumListeners: 4
    });
    expect(payload.webPlayerCompletion).toMatchObject({
      scope: "dust_wave_web_player_only",
      engagedPlays: 5,
      counts: { 25: 4, 50: 3, 75: 2, 100: 1 },
      rates: { 25: 0.8, 50: 0.6, 75: 0.4, 100: 0.2 }
    });
    expect(payload.episodes[0]).toMatchObject({
      webPlayerCompletion: { 25: 4, 50: 3, 75: 2, 100: 1 },
      webPlayerCompletionRates: {
        25: 0.8,
        50: 0.6,
        75: 0.4,
        100: 0.2
      }
    });
    expect(response.headers.get("cache-control")).toContain("private");
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
