import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { listAdminShows } from "../src/admin";
import {
  getAdminLaunchLab,
  openAdminLaunchLabHostedCheckout
} from "../src/launch-lab-admin";
import type { PodcastEnv } from "../src/env";

describe("Launch Lab admin boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is absent in production before authentication or database access", async () => {
    let databaseAccessed = false;
    const env = {
      ENVIRONMENT: "production",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          databaseAccessed = true;
          throw new Error("production database must not be queried");
        }
      }
    } as unknown as PodcastEnv;

    const response = await getAdminLaunchLab(
      new Request("https://feeds.dustwave.xyz/v1/admin/launch-lab"),
      env
    );

    expect(response.status).toBe(404);
    expect(databaseAccessed).toBe(false);
  });

  it("returns content-free, read-only evidence to staging super-admins", async () => {
    const fixture = launchLabAdminFixture();
    const response = await getAdminLaunchLab(fixture.request, fixture.env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(payload).toMatchObject({
      schemaVersion: "dust-wave-launch-lab-admin-v1",
      available: true,
      fixture: {
        exists: true,
        testFixture: true,
        publiclyDiscoverable: false,
        billable: false,
        launchGateEligible: false
      },
      latest: {
        schemaVersion: "dust-wave-launch-lab-run-v1",
        runId: "launch_admin_fixture_0001",
        sourceCommit: "a".repeat(40),
        status: "running",
        passed: false,
        launchGateEligible: false
      }
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /providerId|recipient|listener|email_|stripe_/u
    );
    expect(fixture.queries.some((query) =>
      query.includes("UPDATE launch_lab_runs")
      || query.includes("UPDATE launch_lab_provider_scenarios")
    )).toBe(false);
  });

  it("keeps immutable fixtures out of the normal publishing show list", async () => {
    const fixture = adminShowListFixture();
    const response = await listAdminShows(fixture.request, fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      shows: [{ id: "show_opera_en_la_selva", testFixture: false }]
    });
    expect(fixture.queries.find((query) =>
      query.includes("FROM shows s")
    )).toContain("WHERE s.test_fixture = 0");
  });

  it("hands an open hosted session only to a CSRF-authenticated super-admin", async () => {
    const secret = "admin_session_secret_fixture";
    const sessionToken = "session_fixture";
    const csrfToken = "csrf_fixture";
    const csrfHash = await sha256Hex(`${secret}:${csrfToken}`);
    const queries: string[] = [];
    const db = databaseFixture(queries, {
      first(query) {
        if (query.includes("FROM launch_lab_stripe_checkouts")) {
          return {
            run_id: "launch_admin_checkout_0001",
            phase: "session_open",
            checkout_attempt_id: "checkout_launch_lab_hosted_admin_0001",
            provider_customer_id: "cus_admin_hosted_fixture",
            provider_session_id: "cs_test_admin_hosted_fixture",
            provider_subscription_id: null,
            cleanup_requested: 0,
            customer_deleted: 0,
            transition_count: 3
          };
        }
        return undefined;
      }
    }, csrfHash);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "cs_test_admin_hosted_fixture",
      object: "checkout.session",
      livemode: false,
      mode: "subscription",
      status: "open",
      customer: "cus_admin_hosted_fixture",
      client_reference_id: "checkout_launch_lab_hosted_admin_0001",
      metadata: {
        dustwave_checkout_attempt_id: "checkout_launch_lab_hosted_admin_0001",
        dustwave_show_id: "show_dust_wave_launch_lab",
        launch_lab_fixture: "hosted_checkout_v1",
        launch_lab_run_id: "launch_admin_checkout_0001"
      },
      url: "https://checkout.stripe.com/c/pay/admin_hosted_fixture",
      expires_at: 1_796_227_200
    }), {
      headers: { "content-type": "application/json" }
    })));
    const response = await openAdminLaunchLabHostedCheckout(new Request(
      "https://feeds.dustwave.xyz/v1/admin/launch-lab/stripe-checkout",
      {
        method: "POST",
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
          origin: "https://dustwave.xyz",
          "x-podcast-csrf": csrfToken
        }
      }
    ), {
      ...adminEnv(db, "staging"),
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_admin_hosted"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: "dust-wave-launch-lab-checkout-handoff-v1",
      checkout: {
        url: "https://checkout.stripe.com/c/pay/admin_hosted_fixture",
        expiresAt: "2026-12-02T16:00:00.000Z"
      }
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the hosted handoff absent in production before D1", async () => {
    let touched = false;
    const response = await openAdminLaunchLabHostedCheckout(new Request(
      "https://feeds.dustwave.xyz/v1/admin/launch-lab/stripe-checkout",
      { method: "POST" }
    ), {
      ENVIRONMENT: "production",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          touched = true;
          throw new Error("production D1 must remain untouched");
        }
      }
    } as unknown as PodcastEnv);
    expect(response.status).toBe(404);
    expect(touched).toBe(false);
  });
});

function launchLabAdminFixture(): {
  env: PodcastEnv;
  request: Request;
  queries: string[];
} {
  const queries: string[] = [];
  const db = databaseFixture(queries, {
    first(query) {
      if (query.includes("SELECT COUNT(*) AS fixture_count")) {
        return { fixture_count: 1 };
      }
      if (query.includes("FROM launch_lab_runs") && query.includes("WHERE id = ?")) {
        return {
          id: "launch_admin_fixture_0001",
          show_id: "show_launch_lab_fixture",
          source_commit: "a".repeat(40),
          status: "running",
          started_at: "2026-08-01 20:00:00",
          completed_at: null
        };
      }
      return undefined;
    },
    all(query) {
      if (query.includes("FROM launch_lab_runs")) {
        return [{ id: "launch_admin_fixture_0001" }];
      }
      if (query.includes("FROM launch_lab_provider_scenarios")) {
        return [{
          provider: "resend",
          scenario: "delivered",
          expected_status: "delivered",
          state: "passed",
          observed_status: "delivered",
          failure_code: null
        }, {
          provider: "youtube",
          scenario: "unlisted_upload",
          expected_status: "verified",
          state: "pending",
          observed_status: null,
          failure_code: null
        }];
      }
      return undefined;
    }
  });
  return {
    env: adminEnv(db, "staging"),
    request: adminRequest("/v1/admin/launch-lab"),
    queries
  };
}

function adminShowListFixture(): {
  env: PodcastEnv;
  request: Request;
  queries: string[];
} {
  const queries: string[] = [];
  const db = databaseFixture(queries, {
    all(query) {
      if (query.includes("FROM shows s")) {
        return [{
          id: "show_opera_en_la_selva",
          slug: "opera-en-la-selva",
          title: "Ópera en la Selva",
          description: "Historias de música y comunidad.",
          description_en: "Stories of music and community.",
          language: "es",
          status: "coming_soon",
          artwork_url: null,
          canonical_url: "https://dustwave.xyz/podcasts/opera-en-la-selva/",
          rss_slug: "opera-en-la-selva",
          podcast_guid: null,
          youtube_channel_url: null,
          premium_enabled: 1,
          early_access_days: 7,
          free_mini_episode_enabled: 1,
          author_name: "Dust Wave",
          category: "Arts",
          explicit: 0,
          test_fixture: 0,
          episode_count: 0
        }];
      }
      return undefined;
    }
  });
  return {
    env: adminEnv(db, "staging"),
    request: adminRequest("/v1/admin/shows"),
    queries
  };
}

function databaseFixture(
  queries: string[],
  handlers: {
    first?: (query: string, values: unknown[]) => unknown;
    all?: (query: string, values: unknown[]) => unknown[] | undefined;
  },
  csrfTokenHash = "unused"
): D1Database {
  return {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_launch_lab",
              csrf_token_hash: csrfTokenHash
            };
          }
          return handlers.first?.(query, values) ?? null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return { results: [{ role: "super_admin", show_id: null }] };
          }
          return { results: handlers.all?.(query, values) ?? [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  } as unknown as D1Database;
}

function adminEnv(db: D1Database, environment: string): PodcastEnv {
  return {
    DB: db,
    ENVIRONMENT: environment,
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: "admin_session_secret_fixture"
  } as unknown as PodcastEnv;
}

function adminRequest(path: string): Request {
  return new Request("https://feeds.dustwave.xyz" + path, {
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
      origin: "https://dustwave.xyz"
    }
  });
}
