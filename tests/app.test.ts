import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/app";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz,http://localhost:8080",
    MEDIA_KEY_PREFIX: "podcasts/",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    ...overrides
  } as Env;
}

function createShowDatabase(): D1Database {
  const show = {
    id: "show_opera_en_la_selva",
    slug: "opera-en-la-selva",
    title: "Ópera en la Selva",
    description: "Belleza y alegría. Y un poco de tecnología de vez en cuando. / Beauty and joy. And a bit of tech from time to time.",
    description_en: "Beauty and joy. And a bit of tech from time to time.",
    language: "es",
    status: "coming_soon",
    artwork_url: "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png",
    canonical_url: "https://dustwave.xyz/podcasts/opera-en-la-selva/",
    youtube_channel_url: "https://youtube.com/@dustwavecollective",
    premium_enabled: 1,
    early_access_days: 7,
    free_mini_episode_enabled: 1
  };
  let values: unknown[] = [];

  const statement = (query: string) => ({
    bind(...bound: unknown[]) {
      values = bound;
      return this;
    },
    async first() {
      return query.includes("FROM shows") && values[0] === show.slug ? show : null;
    },
    async all() {
      if (query.includes("FROM show_prices")) {
        return {
          results: [
            { billing_period: "month", amount_cents: 500, currency: "USD" },
            { billing_period: "year", amount_cents: 5000, currency: "USD" }
          ]
        };
      }
      if (query.includes("FROM episodes")) {
        return { results: [] };
      }
      return { results: [show] };
    }
  });

  return {
    prepare: statement
  } as unknown as D1Database;
}

describe("podcast API", () => {
  it("reports service health without querying storage", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/health"),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "dust-wave-podcast",
      environment: "staging"
    });
  });

  it("reflects only an explicitly allowed CORS origin", async () => {
    const allowed = await handleRequest(
      new Request("https://podcast.example/health", {
        headers: { origin: "https://dustwave.xyz" }
      }),
      createEnv()
    );
    const denied = await handleRequest(
      new Request("https://podcast.example/health", {
        headers: { origin: "https://attacker.example" }
      }),
      createEnv()
    );

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://dustwave.xyz");
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("returns a structured 404 for unknown routes", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/unknown"),
      createEnv()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("rejects unsupported methods", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/health", { method: "POST" }),
      createEnv()
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });

  it("returns the seeded show with premium prices and no fabricated episodes", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/v1/shows/opera-en-la-selva"),
      createEnv({ DB: createShowDatabase() })
    );
    const payload = await response.json() as {
      show: {
        premiumEnabled: boolean;
        descriptionEn: string;
        earlyAccessDays: number;
        freeMiniEpisodeEnabled: boolean;
        prices: unknown[];
        episodes: unknown[];
      };
    };

    expect(response.status).toBe(200);
    expect(payload.show.premiumEnabled).toBe(true);
    expect(payload.show.descriptionEn).toBe("Beauty and joy. And a bit of tech from time to time.");
    expect(payload.show.earlyAccessDays).toBe(7);
    expect(payload.show.freeMiniEpisodeEnabled).toBe(true);
    expect(payload.show.prices).toHaveLength(2);
    expect(payload.show.episodes).toEqual([]);
  });

  it("keeps admin routes private without a session", async () => {
    for (const path of [
      "/v1/admin/shows",
      "/v1/admin/shows/show_opera_en_la_selva/episodes"
    ]) {
      const response = await handleRequest(
        new Request(`https://podcast.example${path}`),
        createEnv()
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("private");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("keeps sponsor operations private before loading inventory", async () => {
    for (const [path, body] of [
      ["/v1/admin/ads/preview", { episodeId: "episode_fixture" }],
      ["/v1/admin/ads/campaigns", { showId: "show_fixture" }],
      ["/v1/admin/ads/campaigns/campaign-fixture/creatives", {}],
      ["/v1/admin/episodes/episode-fixture/ad-plan", { markers: [] }],
      ["/v1/admin/ads/plans/adplan-fixture/approve", {}],
      ["/v1/admin/ads/campaigns/campaign-fixture/kill", {}]
    ] as const) {
      const response = await handleRequest(
        new Request(`https://podcast.example${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }),
        createEnv()
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});
