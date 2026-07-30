import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import { buildProjectedSiteShow } from "../src/show-site-projection";

const catalogSha = "a".repeat(40);
const currentShow = {
  id: "show_opera_en_la_selva",
  slug: "opera-en-la-selva",
  title: "Old title",
  description: "Old description",
  descriptionEn: "Old English description",
  language: "es",
  status: "coming_soon",
  sourceUrl: "https://operaenlaselva.substack.com/",
  feedUrl: "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml",
  artwork: "/img/podcasts/opera-en-la-selva/artwork.png",
  wordmark: "/img/podcasts/opera-en-la-selva/wordmark.png",
  socialImage: "/img/podcasts/opera-en-la-selva/social-card.jpg",
  premium: {
    enabled: false,
    currency: "USD",
    monthlyCents: 400,
    annualCents: 40_000,
    benefits: ["Episodios extra", "Acceso anticipado"]
  },
  earlyAccess: {
    mode: "days_before_public",
    days: 3,
    allowEpisodeOverride: true
  },
  freeMiniEpisode: {
    enabled: false,
    maximumPerShow: 1
  },
  episodes: []
};
const sourceShow = {
  id: "show_opera_en_la_selva",
  slug: "opera-en-la-selva",
  title: "Ópera en la Selva",
  description: "Belleza y alegría.",
  description_en: "Beauty and joy.",
  language: "es",
  status: "active",
  artwork_url:
    "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png",
  canonical_url: "https://dustwave.xyz/podcasts/opera-en-la-selva/",
  rss_slug: "opera-en-la-selva",
  youtube_channel_url:
    "https://www.youtube.com/@dustwavecollective",
  premium_enabled: 1,
  early_access_days: 7,
  free_mini_episode_enabled: 1,
  author_name: "Jay Renteria",
  category: "Arts",
  explicit: 0
};
const prices = [
  { billing_period: "month" as const, amount_cents: 500, currency: "USD" },
  { billing_period: "year" as const, amount_cents: 5000, currency: "USD" }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("show site projection", () => {
  it("projects Worker-owned fields and preserves site-owned presentation", () => {
    const result = buildProjectedSiteShow(currentShow, sourceShow, prices);

    expect(result.blockers).toEqual([]);
    expect(result.changedFields).toEqual(expect.arrayContaining([
      "title",
      "description",
      "status",
      "canonicalUrl",
      "feedArtworkUrl",
      "youtubeChannel",
      "authorName",
      "category",
      "explicit",
      "premium",
      "earlyAccess",
      "freeMiniEpisode"
    ]));
    expect(result.projectedShow).toMatchObject({
      title: "Ópera en la Selva",
      descriptionEn: "Beauty and joy.",
      canonicalUrl: "https://dustwave.xyz/podcasts/opera-en-la-selva/",
      authorName: "Jay Renteria",
      category: "Arts",
      explicit: false,
      premium: {
        enabled: true,
        currency: "USD",
        monthlyCents: 500,
        annualCents: 5000,
        benefits: ["Episodios extra", "Acceso anticipado"]
      },
      earlyAccess: {
        mode: "days_before_public",
        days: 7,
        allowEpisodeOverride: true
      },
      freeMiniEpisode: {
        enabled: true,
        maximumPerShow: 1
      }
    });
    expect(result.projectedShow.artwork).toBe(currentShow.artwork);
    expect(result.projectedShow.wordmark).toBe(currentShow.wordmark);
    expect(result.projectedShow.socialImage).toBe(currentShow.socialImage);
    expect(result.projectedShow.sourceUrl).toBe(currentShow.sourceUrl);
    expect(result.projectedShow.episodes).toBe(currentShow.episodes);
  });

  it("blocks premium projection without both active USD prices", () => {
    const result = buildProjectedSiteShow(
      { ...currentShow, artwork: "" },
      sourceShow,
      prices.slice(0, 1)
    );

    expect(result.blockers).toEqual([
      "site_artwork_missing",
      "active_annual_usd_price_missing"
    ]);
  });

  it("routes preview and publish as a SHA-bound dry run without a PUT", async () => {
    const fixture = await projectionFixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return githubCatalogResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await handleRequest(
      fixture.request("GET"),
      fixture.env
    );
    const previewPayload = await preview.json() as {
      catalogSha: string;
      changedFields: string[];
      blockers: string[];
    };
    expect(preview.status).toBe(200);
    expect(previewPayload.catalogSha).toBe(catalogSha);
    expect(previewPayload.blockers).toEqual([]);
    expect(previewPayload.changedFields).toContain("premium");

    const publish = await handleRequest(
      fixture.request("POST", {
        expectedCatalogSha: catalogSha,
        confirmation:
          "PUBLISH_SHOW_CATALOG show_opera_en_la_selva"
      }),
      fixture.env
    );
    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({
      showId: "show_opera_en_la_selva",
      published: false,
      dryRun: true,
      idempotent: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.writes.some(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    )).toBe(true);
  });

  it("rejects a stale reviewed catalog SHA without writing GitHub", async () => {
    const fixture = await projectionFixture();
    const fetchMock = vi.fn(async () => githubCatalogResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      fixture.request("POST", {
        expectedCatalogSha: "b".repeat(40),
        confirmation:
          "PUBLISH_SHOW_CATALOG show_opera_en_la_selva"
      }),
      fixture.env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "show_site_projection_conflict"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.writes.some(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    )).toBe(false);
  });
});

async function projectionFixture() {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return { recent: 1 };
          }
          if (query.includes("FROM shows") && query.includes("rss_slug")) {
            return sourceShow;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          }
          if (query.includes("FROM show_prices")) {
            return { results: prices };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          return { success: true };
        }
      };
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret,
      GITHUB_OWNER: "aindaco1",
      GITHUB_REPO: "dust-wave-new",
      GITHUB_REF: "release/1.2.0-youtube-preflight",
      GITHUB_PUBLISH_MODE: "dry_run"
    } as unknown as PodcastEnv,
    writes,
    request(method: "GET" | "POST", body?: Record<string, unknown>) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/"
        + "show_opera_en_la_selva/site-projection",
        {
          method,
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            ...(method === "POST"
              ? {
                  "content-type": "application/json",
                  "x-podcast-csrf": csrfToken
                }
              : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        }
      );
    }
  };
}

function githubCatalogResponse(): Response {
  return Response.json({
    encoding: "base64",
    content: btoa(JSON.stringify([currentShow])),
    sha: catalogSha
  });
}
