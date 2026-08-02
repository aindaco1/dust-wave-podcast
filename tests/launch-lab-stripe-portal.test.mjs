import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureLaunchLabRun } from "../src/launch-lab-ledger";
import {
  advanceLaunchLabStripePortal,
  cleanupLaunchLabStripePortal
} from "../src/launch-lab-stripe-portal";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const runId = "launch_stripe_portal_0001";
const sourceCommit = "c".repeat(40);
const customerId = "cus_launch_lab_portal";
const configurationId = "bpc_launch_lab_portal";
const returnUrl =
  "https://dust-wave-website-staging.pages.dev/podcasts/account/";
const portalUrl = "https://billing.stripe.com/p/session/launch_lab_portal";

describe("Launch Lab Stripe Customer Portal", () => {
  let fixture;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fixture?.sqlite.close();
    fixture = undefined;
  });

  it("verifies the exact Portal session and deletes its isolated customer", async () => {
    fixture = await portalFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await advance()).phase).toBe("customer_ready");
    expect((await advance()).phase).toBe("portal_verified");
    expect(provider.portalParams).toEqual({
      configuration: configurationId,
      customer: customerId,
      return_url: returnUrl
    });
    expect((await advance()).phase).toBe("customer_deleted");
    expect(await advance()).toEqual({
      schemaVersion: "dust-wave-launch-lab-stripe-portal-v1",
      phase: "complete",
      complete: true,
      portalVerified: true,
      customerDeleted: true
    });

    expect(provider.paths).toEqual([
      "/v1/customers",
      `/v1/customers/${customerId}`,
      "/v1/billing_portal/sessions",
      `/v1/customers/${customerId}`
    ]);
    expect(provider.idempotencyKeys).toEqual([
      `${runId}:portal-customer`,
      `${runId}:portal-session`
    ]);
    expect(fixture.sqlite.prepare(
      `SELECT phase, portal_verified, customer_deleted,
              transition_count, last_error_code
       FROM launch_lab_stripe_portal_rehearsals
       WHERE run_id = ?`
    ).get(runId)).toEqual({
      phase: "complete",
      portal_verified: 1,
      customer_deleted: 1,
      transition_count: 4,
      last_error_code: null
    });
    expect(fixture.sqlite.prepare(
      "PRAGMA table_info(launch_lab_stripe_portal_rehearsals)"
    ).all().map(({ name }) => name)).not.toContain("portal_url");
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("cleans up a partial rehearsal without creating a Portal session", async () => {
    fixture = await portalFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await advance()).phase).toBe("customer_ready");
    expect(await cleanupLaunchLabStripePortal(fixture.env, runId)).toEqual({
      schemaVersion: "dust-wave-launch-lab-stripe-portal-v1",
      phase: "aborted",
      complete: true,
      portalVerified: false,
      customerDeleted: true
    });
    expect(provider.paths).toEqual([
      "/v1/customers",
      `/v1/customers/${customerId}`
    ]);
  });

  it("recovers an ambiguously created customer during unconditional cleanup", async () => {
    fixture = await portalFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    fixture.sqlite.prepare(
      `INSERT INTO launch_lab_stripe_portal_rehearsals (run_id)
       VALUES (?)`
    ).run(runId);

    expect(await cleanupLaunchLabStripePortal(fixture.env, runId)).toEqual({
      schemaVersion: "dust-wave-launch-lab-stripe-portal-v1",
      phase: "aborted",
      complete: true,
      portalVerified: false,
      customerDeleted: true
    });
    expect(provider.paths).toEqual([
      "/v1/customers",
      `/v1/customers/${customerId}`
    ]);
    expect(provider.idempotencyKeys).toEqual([
      `${runId}:portal-customer`
    ]);
  });

  it("rejects provider drift and keeps cleanup resumable", async () => {
    fixture = await portalFixture();
    const provider = providerFixture({
      portal: { return_url: "https://example.com/unsafe-return" }
    });
    vi.stubGlobal("fetch", provider.fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await advance()).phase).toBe("customer_ready");
    await expect(advance()).rejects.toThrow("session_mismatch");
    expect(fixture.sqlite.prepare(
      `SELECT phase, last_error_code
       FROM launch_lab_stripe_portal_rehearsals
       WHERE run_id = ?`
    ).get(runId)).toEqual({
      phase: "customer_ready",
      last_error_code: "launch_lab_stripe_portal_session_mismatch"
    });
    expect((await cleanupLaunchLabStripePortal(fixture.env, runId)).phase)
      .toBe("aborted");
    expect(provider.paths.at(-1)).toBe(`/v1/customers/${customerId}`);
  });

  it("fails before D1 and provider I/O outside staging test mode", async () => {
    fixture = await portalFixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(advanceLaunchLabStripePortal({
      ...fixture.env,
      ENVIRONMENT: "production"
    }, runId)).rejects.toThrow("not_available");
    await expect(advanceLaunchLabStripePortal({
      ...fixture.env,
      STRIPE_MODE: "live"
    }, runId)).rejects.toThrow("not_available");
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM launch_lab_stripe_portal_rehearsals"
    ).get()).toEqual({ count: 0 });
  });

  async function advance() {
    return advanceLaunchLabStripePortal(fixture.env, runId);
  }
});

async function portalFixture() {
  const sqlite = migratedSqlite();
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, premium_enabled, test_fixture
     ) VALUES (
       'show_dust_wave_launch_lab', 'dust-wave-launch-lab',
       'Dust Wave Launch Lab',
       'https://staging.example/podcasts/dust-wave-launch-lab/',
       'dust-wave-launch-lab', 1, 1
     )`
  ).run();
  const db = sqliteD1(sqlite);
  expect(await ensureLaunchLabRun(db, {
    runId,
    showId: "show_dust_wave_launch_lab",
    sourceCommit
  })).toBe(true);
  return {
    sqlite,
    env: {
      DB: db,
      ENVIRONMENT: "staging",
      SITE_ORIGIN: "https://dust-wave-website-staging.pages.dev",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_launch_lab_portal",
      STRIPE_PORTAL_CONFIGURATION_ID: configurationId
    }
  };
}

function providerFixture({ portal = {} } = {}) {
  const provider = {
    paths: [],
    idempotencyKeys: [],
    portalParams: null
  };
  provider.fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    provider.paths.push(url.pathname);
    const method = init.method ?? "GET";
    const idempotencyKey = new Headers(init.headers).get("idempotency-key");
    if (idempotencyKey) provider.idempotencyKeys.push(idempotencyKey);
    let object;
    if (url.pathname === "/v1/customers" && method === "POST") {
      object = customerObject();
    } else if (
      url.pathname === `/v1/customers/${customerId}`
      && method === "GET"
    ) {
      object = customerObject();
    } else if (
      url.pathname === "/v1/billing_portal/sessions"
      && method === "POST"
    ) {
      provider.portalParams = Object.fromEntries(
        new URLSearchParams(String(init.body ?? ""))
      );
      object = {
        id: "bps_launch_lab_portal",
        object: "billing_portal.session",
        livemode: false,
        customer: customerId,
        configuration: configurationId,
        return_url: returnUrl,
        url: portalUrl,
        ...portal
      };
    } else if (
      url.pathname === `/v1/customers/${customerId}`
      && method === "DELETE"
    ) {
      object = { id: customerId, object: "customer", deleted: true };
    }
    return new Response(JSON.stringify(object ?? { error: { code: "missing" } }), {
      status: object ? 200 : 404,
      headers: {
        "content-type": "application/json",
        "request-id": "req_launch_lab_portal"
      }
    });
  });
  return provider;
}

function customerObject() {
  return {
    id: customerId,
    object: "customer",
    livemode: false,
    deleted: false,
    metadata: {
      platform: "dust_wave_podcast",
      launch_lab_fixture: "billing_portal_v1",
      launch_lab_run_id: runId
    }
  };
}
