import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLaunchLabRun,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";
import { runLaunchLabStripeReadiness } from "../src/launch-lab-stripe";

const migrationPath = fileURLToPath(new URL(
  "../migrations/0080_launch_lab_fixture_boundary.sql",
  import.meta.url
));

describe("Launch Lab Stripe readiness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attests exact inactive test objects, fails mismatch, and recovers", async () => {
    const fixture = stripeFixture();
    let productActive = true;
    const requestedPaths = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      const objects = {
        "/v1/products/prod_opera_fixture": {
          id: "prod_opera_fixture",
          object: "product",
          livemode: false,
          active: productActive,
          metadata: {
            show_id: "show_opera",
            platform: "dust_wave_podcast"
          }
        },
        "/v1/prices/price_opera_monthly": providerPrice("month"),
        "/v1/prices/price_opera_annual": providerPrice("year")
      };
      const object = objects[url.pathname];
      return new Response(JSON.stringify(object ?? { error: {} }), {
        status: object ? 200 : 404,
        headers: {
          "content-type": "application/json",
          "request-id": "req_launch_lab_fixture"
        }
      });
    }));
    try {
      const runId = "launch_lab_run_stripe_0001";
      expect(await ensureLaunchLabRun(fixture.db, {
        runId,
        showId: "show_lab",
        sourceCommit: "a".repeat(40)
      })).toBe(true);
      await seedLaunchLabScenarios(fixture.db, runId);
      const env = {
        DB: fixture.db,
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_launch_lab_fixture"
      };

      await runLaunchLabStripeReadiness(env, runId);
      expect(stripeStates(fixture.sqlite)).toEqual([
        { scenario: "api_test_mode", state: "passed" },
        { scenario: "product_price_contract", state: "failed" }
      ]);

      productActive = false;
      await runLaunchLabStripeReadiness(env, runId);
      expect(stripeStates(fixture.sqlite)).toEqual([
        { scenario: "api_test_mode", state: "passed" },
        { scenario: "product_price_contract", state: "passed" }
      ]);
      expect(requestedPaths).not.toContain("/v1/products/prod_lab_forbidden");
      expect(requestedPaths).toHaveLength(6);
    } finally {
      fixture.sqlite.close();
    }
  });
});

function providerPrice(interval) {
  const annual = interval === "year";
  return {
    id: annual ? "price_opera_annual" : "price_opera_monthly",
    object: "price",
    livemode: false,
    active: false,
    currency: "usd",
    unit_amount: annual ? 5000 : 500,
    tax_behavior: "exclusive",
    lookup_key: annual ? "opera_annual" : "opera_monthly",
    product: "prod_opera_fixture",
    recurring: {
      interval,
      interval_count: 1,
      trial_period_days: null
    },
    metadata: {
      show_id: "show_opera",
      billing_period: interval
    }
  };
}

function stripeStates(sqlite) {
  return sqlite.prepare(
    `SELECT scenario, state
     FROM launch_lab_provider_scenarios
     WHERE provider = 'stripe'
       AND scenario IN ('api_test_mode', 'product_price_contract')
     ORDER BY scenario`
  ).all();
}

function stripeFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE shows (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      premium_enabled INTEGER NOT NULL DEFAULT 0,
      billing_mode TEXT NOT NULL DEFAULT 'test',
      stripe_product_id TEXT
    );
    CREATE TABLE show_prices (
      id TEXT PRIMARY KEY,
      show_id TEXT NOT NULL,
      billing_period TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      stripe_price_id TEXT,
      stripe_lookup_key TEXT,
      tax_behavior TEXT NOT NULL,
      provider_mode TEXT NOT NULL,
      active INTEGER NOT NULL
    );
  `);
  sqlite.exec(readFileSync(migrationPath, "utf8"));
  sqlite.prepare(
    `INSERT INTO shows (
       id, status, title, premium_enabled, billing_mode, stripe_product_id,
       test_fixture
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "show_opera",
    "coming_soon",
    "Ópera en la Selva",
    1,
    "test",
    "prod_opera_fixture",
    0
  );
  sqlite.prepare(
    `INSERT INTO shows (
       id, status, title, premium_enabled, billing_mode, stripe_product_id,
       test_fixture
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "show_lab",
    "coming_soon",
    "Launch Lab",
    1,
    "test",
    "prod_lab_forbidden",
    1
  );
  const insertPrice = sqlite.prepare(
    `INSERT INTO show_prices VALUES (?, ?, ?, ?, 'USD', ?, ?, 'exclusive', 'test', 1)`
  );
  insertPrice.run(
    "price_monthly",
    "show_opera",
    "month",
    500,
    "price_opera_monthly",
    "opera_monthly"
  );
  insertPrice.run(
    "price_annual",
    "show_opera",
    "year",
    5000,
    "price_opera_annual",
    "opera_annual"
  );
  const db = sqliteD1(sqlite);
  return { sqlite, db };
}

function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(query).all(...values) };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
}
