import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import {
  validatePremiumPricePair
} from "../src/show-premium-prices";

describe("show premium price configuration", () => {
  it("accepts the launch pair and requires an annual discount", () => {
    expect(() => validatePremiumPricePair(500, 5_000)).not.toThrow();
    expect(() => validatePremiumPricePair(500, 6_000)).toThrow(
      /must include a discount/u
    );
    expect(() => validatePremiumPricePair(500, 400)).toThrow(
      /at least monthlyCents/u
    );
  });

  it("reads non-secret readiness and atomically clears stale provider links", async () => {
    const fixture = await priceFixture();
    const read = await handleRequest(fixture.request("GET"), fixture.env);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      showId: "show_opera_en_la_selva",
      monthlyCents: 500,
      annualCents: 5_000,
      providerReady: true,
      configurationLocked: false
    });

    const response = await handleRequest(
      fixture.request("PATCH", {
        monthlyCents: 600,
        annualCents: 6_000,
        expectedMonthlyCents: 500,
        expectedAnnualCents: 5_000,
        confirmation:
          "CONFIGURE_SHOW_PRICES show_opera_en_la_selva"
      }),
      fixture.env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      updated: true,
      idempotent: false,
      providerProvisioningRequired: true,
      monthlyCents: 600,
      annualCents: 6_000,
      providerReady: false
    });
    const priceUpdate = fixture.writes.find(({ query }) =>
      query.includes("UPDATE show_prices")
    );
    expect(priceUpdate?.values).toEqual(expect.arrayContaining([
      600,
      6_000,
      "show_opera_en_la_selva"
    ]));
    expect(
      fixture.writes.some(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(true);
  });

  it("rejects stale expected prices without a write", async () => {
    const fixture = await priceFixture();
    const response = await handleRequest(
      fixture.request("PATCH", {
        monthlyCents: 600,
        annualCents: 6_000,
        expectedMonthlyCents: 400,
        expectedAnnualCents: 4_000,
        confirmation:
          "CONFIGURE_SHOW_PRICES show_opera_en_la_selva"
      }),
      fixture.env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "show_price_configuration_conflict",
      monthlyCents: 500,
      annualCents: 5_000
    });
    expect(
      fixture.writes.some(({ query }) =>
        query.includes("UPDATE show_prices")
        || query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(false);
  });

  it("blocks a change after billing history exists", async () => {
    const fixture = await priceFixture({ subscriptionCount: 1 });
    const response = await handleRequest(
      fixture.request("PATCH", {
        monthlyCents: 600,
        annualCents: 6_000,
        expectedMonthlyCents: 500,
        expectedAnnualCents: 5_000,
        confirmation:
          "CONFIGURE_SHOW_PRICES show_opera_en_la_selva"
      }),
      fixture.env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "show_price_configuration_locked",
      blockers: ["billing_history_exists"]
    });
    expect(
      fixture.writes.some(({ query }) =>
        query.includes("UPDATE show_prices")
        || query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(false);
  });
});

async function priceFixture({
  subscriptionCount = 0
}: {
  subscriptionCount?: number;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  let updated = false;
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) return { recent: 1 };
          if (query.includes("SELECT id, billing_mode")) {
            return {
              id: "show_opera_en_la_selva",
              billing_mode: "test"
            };
          }
          if (query.includes("AS subscription_count")) {
            return {
              subscription_count: subscriptionCount,
              checkout_attempt_count: 0
            };
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
            return {
              results: [
                {
                  id: "price_opera_monthly_usd",
                  billing_period: "month",
                  amount_cents: updated ? 600 : 500,
                  currency: "USD",
                  stripe_price_id: updated ? null : "price_monthly",
                  provider_mode: "test",
                  active: 1
                },
                {
                  id: "price_opera_annual_usd",
                  billing_period: "year",
                  amount_cents: updated ? 6_000 : 5_000,
                  currency: "USD",
                  stripe_price_id: updated ? null : "price_annual",
                  provider_mode: "test",
                  active: 1
                }
              ]
            };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          if (query.includes("UPDATE show_prices")) updated = true;
          return {
            success: true,
            meta: {
              changes: query.includes("UPDATE show_prices") ? 2 : 1
            }
          };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret,
      STRIPE_MODE: "test",
      SUBSCRIPTION_CHECKOUT_ENABLED: "false"
    } as unknown as PodcastEnv,
    writes,
    request(
      method: "GET" | "PATCH",
      body?: Record<string, unknown>
    ) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/"
        + "show_opera_en_la_selva/premium-prices",
        {
          method,
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            ...(method === "PATCH"
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
