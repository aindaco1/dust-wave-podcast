import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleStripeWebhook } from "../src/billing";
import {
  ensureLaunchLabRun,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";
import {
  advanceLaunchLabHostedCheckout,
  requestLaunchLabHostedCheckoutCleanup
} from "../src/launch-lab-stripe-checkout";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const runId = "launch_hosted_checkout_0001";
const sourceCommit = "b".repeat(40);
const webhookSecret = "whsec_launch_lab_hosted_checkout";
const customerId = "cus_launch_lab_hosted";
const sessionId = "cs_test_launch_lab_hosted";
const subscriptionId = "sub_launch_lab_hosted";
const priceId = "price_launch_lab_hosted";
const fixtureEmail = "launch-lab-checkout@example.com";
const periodEnd = 1_796_227_200;

describe("Launch Lab hosted Checkout", () => {
  let fixture;

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture?.sqlite.close();
  });

  it("waits for hosted completion and signed projections, then cleans up", async () => {
    fixture = await hostedFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    expect((await advance()).phase).toBe("customer_ready");
    expect((await advance()).phase).toBe("attempt_ready");
    expect((await advance()).phase).toBe("session_open");
    expect(await advance()).toMatchObject({
      phase: "session_open",
      requiresBrowser: true,
      complete: false
    });

    provider.sessionStatus = "complete";
    provider.paymentStatus = "paid";
    await sendEvent("evt_hosted_checkout", "checkout.session.completed", {
      ...provider.sessionObject(),
      customer_details: { email: fixtureEmail }
    });
    expect((await advance()).phase).toBe("checkout_completed");
    expect((await advance()).phase).toBe("cancellation_requested");
    expect((await advance()).phase).toBe("cancellation_requested");

    await sendEvent("evt_hosted_canceled", "customer.subscription.deleted", {
      id: subscriptionId,
      object: "subscription",
      customer: customerId,
      status: "canceled",
      current_period_end: periodEnd,
      metadata: {
        dustwave_checkout_attempt_id: checkoutAttemptId()
      }
    });
    expect((await advance()).phase).toBe("canceled");
    expect((await advance()).phase).toBe("customer_deleted");
    expect(await advance()).toMatchObject({
      phase: "complete",
      complete: true,
      requiresBrowser: false
    });

    expect(fixture.sqlite.prepare(
      `SELECT state, observed_status
       FROM launch_lab_provider_scenarios
       WHERE run_id = ? AND provider = 'stripe'
         AND scenario = 'checkout_success'`
    ).get(runId)).toEqual({ state: "passed", observed_status: "active" });
    for (const table of [
      "subscription_checkout_attempts",
      "subscription_entitlement_sources",
      "subscriptions",
      "listener_accounts"
    ]) {
      expect(fixture.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`
      ).get()).toEqual({ count: 0 });
    }
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all())
      .toEqual([]);
    expect(provider.paths.filter((path) => path === "/v1/checkout/sessions"))
      .toHaveLength(1);
    expect(provider.paths.filter((path) => path === `/v1/customers/${customerId}`))
      .toHaveLength(1);
  });

  it("expires an abandoned session and removes its exact fixture", async () => {
    fixture = await hostedFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    expect((await advance()).phase).toBe("customer_ready");
    expect((await advance()).phase).toBe("attempt_ready");
    expect((await advance()).phase).toBe("session_open");

    expect(await cleanup()).toMatchObject({
      phase: "session_open",
      cleanupRequested: true,
      complete: false
    });
    expect(provider.sessionStatus).toBe("expired");
    expect((await cleanup()).phase).toBe("session_open");
    expect(await cleanup()).toMatchObject({
      phase: "aborted",
      complete: true,
      requiresBrowser: false
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM subscription_checkout_attempts"
    ).get()).toEqual({ count: 0 });
    expect(provider.paths.filter((path) =>
      path === `/v1/checkout/sessions/${sessionId}/expire`
    )).toHaveLength(1);
    expect(provider.paths.filter((path) => path === `/v1/customers/${customerId}`))
      .toHaveLength(1);
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all())
      .toEqual([]);
  });

  it("fails before provider I/O outside staging test mode", async () => {
    fixture = await hostedFixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(advanceLaunchLabHostedCheckout({
      ...fixture.env,
      ENVIRONMENT: "production"
    }, runId)).rejects.toThrow("not_available");
    await expect(advanceLaunchLabHostedCheckout({
      ...fixture.env,
      STRIPE_MODE: "live"
    }, runId)).rejects.toThrow("not_available");
    expect(fetch).not.toHaveBeenCalled();
  });

  async function advance() {
    return advanceLaunchLabHostedCheckout(fixture.env, runId);
  }

  async function cleanup() {
    return requestLaunchLabHostedCheckoutCleanup(fixture.env, runId);
  }

  async function sendEvent(eventId, type, object) {
    const payload = JSON.stringify({
      id: eventId,
      type,
      livemode: false,
      created: 1_787_990_400 + (type === "checkout.session.completed" ? 1 : 2),
      data: { object }
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const response = await handleStripeWebhook(new Request(
      "https://staging-feeds.dustwave.xyz/v1/webhooks/stripe",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${timestamp},v1=${signature}`
        },
        body: payload
      }
    ), fixture.env);
    expect(response.status).toBe(200);
  }
});

async function hostedFixture() {
  const sqlite = migratedSqlite();
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, description, language, status, canonical_url,
       rss_slug, premium_enabled, test_fixture
     ) VALUES (?, ?, ?, '', 'es', 'coming_soon', ?, ?, 1, 1)`
  ).run(
    "show_dust_wave_launch_lab",
    "dust-wave-launch-lab",
    "Dust Wave Launch Lab",
    "https://staging.dustwave.xyz/podcasts/dust-wave-launch-lab/",
    "dust-wave-launch-lab"
  );
  sqlite.prepare(
    `UPDATE launch_lab_stripe_fixture_config
     SET provider_product_id = 'prod_launch_lab_hosted',
         provider_price_id = ?
     WHERE id = 'subscription_monthly_v1'`
  ).run(priceId);
  sqlite.prepare(
    `INSERT INTO show_prices (
       id, show_id, billing_period, amount_cents, currency,
       stripe_price_id, stripe_lookup_key, tax_behavior,
       provider_mode, active
     ) VALUES (?, ?, 'month', 100, 'USD', ?, ?, 'exclusive', 'test', 0)`
  ).run(
    "price_dust_wave_launch_lab_monthly_v1",
    "show_dust_wave_launch_lab",
    priceId,
    "dust_wave_launch_lab_monthly_v1"
  );
  const db = sqliteD1(sqlite);
  expect(await ensureLaunchLabRun(db, {
    runId,
    showId: "show_dust_wave_launch_lab",
    sourceCommit
  })).toBe(true);
  await seedLaunchLabScenarios(db, runId);
  return {
    sqlite,
    env: {
      DB: db,
      ENVIRONMENT: "staging",
      SITE_ORIGIN: "https://dust-wave-website-staging.pages.dev",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_launch_lab_hosted",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      LISTENER_EMAIL_LOOKUP_PEPPER: "launch_lab_listener_pepper",
      TAX_QUOTE_HASH_SECRET: "launch_lab_tax_pepper"
    }
  };
}

function providerFixture() {
  const provider = {
    paths: [],
    sessionStatus: "open",
    paymentStatus: "unpaid"
  };
  provider.sessionObject = () => ({
    id: sessionId,
    object: "checkout.session",
    livemode: false,
    mode: "subscription",
    status: provider.sessionStatus,
    payment_status: provider.paymentStatus,
    customer: customerId,
    subscription: provider.sessionStatus === "complete" ? subscriptionId : null,
    client_reference_id: checkoutAttemptId(),
    metadata: {
      dustwave_checkout_attempt_id: checkoutAttemptId(),
      dustwave_show_id: "show_dust_wave_launch_lab",
      dustwave_price_id: "price_dust_wave_launch_lab_monthly_v1",
      platform: "dust_wave_podcast",
      launch_lab_fixture: "hosted_checkout_v1",
      launch_lab_run_id: runId
    },
    url: "https://checkout.stripe.com/c/pay/launch_lab_hosted",
    expires_at: Math.floor(Date.now() / 1_000) + 1_800
  });
  provider.fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    provider.paths.push(url.pathname);
    const method = init.method ?? "GET";
    let object;
    if (url.pathname === "/v1/customers" && method === "POST") {
      object = {
        id: customerId,
        object: "customer",
        livemode: false,
        metadata: {
          platform: "dust_wave_podcast",
          launch_lab_fixture: "hosted_checkout_v1",
          launch_lab_run_id: runId
        }
      };
    } else if (
      url.pathname === `/v1/customers/${customerId}`
      && method === "DELETE"
    ) {
      object = { id: customerId, object: "customer", deleted: true };
    } else if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
      object = provider.sessionObject();
    } else if (
      url.pathname === `/v1/checkout/sessions/${sessionId}/expire`
      && method === "POST"
    ) {
      provider.sessionStatus = "expired";
      object = provider.sessionObject();
    } else if (url.pathname === `/v1/checkout/sessions/${sessionId}`) {
      object = provider.sessionObject();
    } else if (
      url.pathname === `/v1/subscriptions/${subscriptionId}`
      && method === "DELETE"
    ) {
      object = subscriptionObject("canceled");
    } else if (url.pathname === `/v1/subscriptions/${subscriptionId}`) {
      object = subscriptionObject("canceled");
    }
    return new Response(JSON.stringify(object ?? { error: { code: "missing" } }), {
      status: object ? 200 : 404,
      headers: { "content-type": "application/json", "request-id": "req_hosted" }
    });
  });
  return provider;
}

function subscriptionObject(status) {
  return {
    id: subscriptionId,
    object: "subscription",
    livemode: false,
    customer: customerId,
    status,
    current_period_end: periodEnd,
    metadata: {
      dustwave_checkout_attempt_id: checkoutAttemptId()
    }
  };
}

function checkoutAttemptId() {
  return `checkout_launch_lab_hosted_${runId}`;
}
