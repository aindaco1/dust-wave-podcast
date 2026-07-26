import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";
import { listAdminSubscribers } from "../src/subscribers";

describe("subscriber administration", () => {
  it("returns a bounded, pseudonymous multi-source subscription page", async () => {
    const fixture = subscriberFixture();
    const response = await listAdminSubscribers(
      fixture.request("?showId=show_opera&limit=1"),
      fixture.env
    );
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.privacy).toEqual({
      version: "subscriber-admin-minimized-v1",
      includesEmail: false,
      includesAddress: false,
      providerReferences: "super_admin_only"
    });
    expect(payload.subscribers).toHaveLength(1);
    expect(payload.subscribers[0]).toMatchObject({
      subscriptionId: "subscription_new",
      listenerId: "listener_new",
      showTitle: "Ópera en la Selva",
      status: "active",
      hasPrivateFeed: true,
      announcementsEnabled: true,
      sources: [
        {
          provider: "pool",
          status: "active"
        },
        {
          provider: "stripe",
          status: "active",
          providerCustomerId: "cus_fixture",
          providerSubscriptionId: "sub_fixture"
        }
      ]
    });
    expect(payload.pagination).toEqual({
      limit: 1,
      nextCursor: "subscription_new"
    });
    expect(payload.summary).toMatchObject({
      total: 2,
      active: 1,
      pastDue: 1
    });
    expect(JSON.stringify(payload)).not.toContain("listener@example.com");
    expect(JSON.stringify(fixture.bindings)).not.toContain(
      "listener@example.com"
    );
    const page = fixture.queries.find((query) =>
      query.includes("FROM subscriptions subscription")
    );
    expect(page).toContain("ORDER BY subscription.updated_at DESC");
    expect(page).toContain("LIMIT ?");
  });

  it("exports formula-safe CSV without email or address columns", async () => {
    const fixture = subscriberFixture({
      showTitle: "=IMPORTXML(\"bad\")"
    });
    const response = await listAdminSubscribers(
      fixture.request("?showId=show_opera&format=csv&limit=500"),
      fixture.env
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      "podcast-subscribers.csv"
    );
    expect(csv).toContain("\"'=IMPORTXML(\"\"bad\"\")\"");
    expect(csv).not.toMatch(/email|address/i);
  });

  it("requires a super-admin session before querying subscriber records", async () => {
    const fixture = subscriberFixture({ role: "admin" });
    const response = await listAdminSubscribers(
      fixture.request("?showId=show_opera"),
      fixture.env
    );

    expect(response.status).toBe(403);
    expect(
      fixture.queries.some((query) =>
        query.includes("FROM subscriptions subscription")
      )
    ).toBe(false);
  });
});

function subscriberFixture({
  role = "super_admin",
  showTitle = "Ópera en la Selva"
}: {
  role?: "super_admin" | "admin";
  showTitle?: string;
} = {}) {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const subscriptionRows = [
    {
      id: "subscription_new",
      listener_id: "listener_new",
      show_id: "show_opera",
      show_title: showTitle,
      price_id: "price_month",
      billing_period: "month",
      status: "active",
      current_period_end: "2026-08-26T00:00:00.000Z",
      canceled_at: null,
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z",
      has_private_feed: 1,
      announcements_enabled: 1,
      notification_language: "es"
    },
    {
      id: "subscription_old",
      listener_id: "listener_old",
      show_id: "show_opera",
      show_title: showTitle,
      price_id: "price_year",
      billing_period: "year",
      status: "past_due",
      current_period_end: "2026-08-01T00:00:00.000Z",
      canceled_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z",
      has_private_feed: 0,
      announcements_enabled: 0,
      notification_language: null
    }
  ];
  const sourceRows = [
    {
      listener_id: "listener_new",
      show_id: "show_opera",
      provider: "pool",
      provider_customer_id: null,
      provider_subscription_id: null,
      status: "active",
      current_period_end: "2026-08-26T00:00:00.000Z",
      canceled_at: null,
      updated_at: "2026-07-26T00:00:00.000Z"
    },
    {
      listener_id: "listener_new",
      show_id: "show_opera",
      provider: "stripe",
      provider_customer_id: "cus_fixture",
      provider_subscription_id: "sub_fixture",
      status: "active",
      current_period_end: "2026-08-26T00:00:00.000Z",
      canceled_at: null,
      updated_at: "2026-07-26T00:00:00.000Z"
    }
  ];
  const db = {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          bindings.push(bound);
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_subscribers",
              csrf_token_hash: "unused"
            };
          }
          if (query.includes("COUNT(*) AS total")) {
            return {
              total: 2,
              active: 1,
              past_due: 1,
              paused: 0,
              ended: 0,
              pending: 0
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return { results: [{ role, show_id: null }] };
          }
          if (query.includes("FROM subscriptions subscription")) {
            return { results: subscriptionRows };
          }
          if (query.includes("FROM subscription_entitlement_sources")) {
            if (query.includes("GROUP BY provider")) {
              return {
                results: [
                  { provider: "pool", total: 1, active: 1 },
                  { provider: "stripe", total: 1, active: 1 }
                ]
              };
            }
            return { results: sourceRows };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 }, values };
        }
      };
    }
  } as unknown as D1Database;
  return {
    queries,
    bindings,
    env: {
      DB: db,
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      SITE_ORIGIN: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: "subscriber-session-secret"
    } as unknown as PodcastEnv,
    request(query = "") {
      return new Request(
        `https://feeds.dustwave.xyz/v1/admin/subscribers${query}`,
        {
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=subscriber-session-token`,
            origin: "https://dustwave.xyz"
          }
        }
      );
    }
  };
}
