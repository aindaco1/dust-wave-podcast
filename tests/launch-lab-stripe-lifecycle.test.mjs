import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleStripeWebhook } from "../src/billing";
import {
  ensureLaunchLabRun,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";
import { advanceLaunchLabStripeLifecycle } from
  "../src/launch-lab-stripe-lifecycle";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const runId = "launch_stripe_lifecycle_0001";
const sourceCommit = "a".repeat(40);
const webhookSecret = "whsec_launch_lab_provider_lifecycle";
const customerId = "cus_launch_lab_provider";
const subscriptionId = "sub_launch_lab_provider";
const clockId = "clock_launch_lab_provider";
const productId = "prod_launch_lab_provider";
const priceId = "price_launch_lab_provider";
const paymentIntentId = "pi_launch_lab_recovery";
const refundId = "re_launch_lab_refund";
const periodOne = 1_790_870_400;
const periodTwo = 1_793_548_800;
const periodThree = 1_796_227_200;

describe("Launch Lab Stripe test-clock lifecycle", () => {
  let fixture;

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture?.sqlite.close();
  });

  it("waits for signed projections, records five outcomes, and cleans up", async () => {
    fixture = await lifecycleFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    expect((await advance()).phase).toBe("product_ready");
    expect((await advance()).phase).toBe("price_ready");
    expect((await advance()).phase).toBe("clock_ready");
    expect((await advance()).phase).toBe("customer_ready");
    expect((await advance()).phase).toBe("subscription_created");

    expect((await advance()).phase).toBe("subscription_created");
    expect(provider.paths.filter((path) => path === "/v1/subscriptions"))
      .toHaveLength(1);
    await sendSubscriptionEvent("evt_launch_created", "active", periodOne);
    expect((await advance()).phase).toBe("initial_active");

    expect((await advance()).phase).toBe("renewal_advancing");
    expect((await advance()).phase).toBe("renewal_advancing");
    provider.clockStatus = "ready";
    provider.periodEnd = periodTwo;
    await sendSubscriptionEvent("evt_launch_renewed", "active", periodTwo);
    expect((await advance()).phase).toBe("renewed");

    expect((await advance()).phase).toBe("failure_payment_method_ready");
    expect((await advance()).phase).toBe("failure_payment_method_set");
    expect((await advance()).phase).toBe("failure_advancing");
    provider.clockStatus = "ready";
    provider.subscriptionStatus = "past_due";
    provider.periodEnd = periodThree;
    provider.latestInvoice = "in_launch_lab_failed";
    await sendSubscriptionEvent(
      "evt_launch_failed",
      "past_due",
      periodThree
    );
    expect((await advance()).phase).toBe("failed_payment");

    expect((await advance()).phase)
      .toBe("recovery_payment_method_ready");
    expect((await advance()).phase)
      .toBe("recovery_payment_method_set");
    expect((await advance()).phase).toBe("recovery_invoice_ready");
    expect((await advance()).phase).toBe("recovery_payment_requested");
    expect((await advance()).phase).toBe("recovery_payment_requested");
    provider.subscriptionStatus = "active";
    await sendSubscriptionEvent(
      "evt_launch_recovered",
      "active",
      periodThree
    );
    expect((await advance()).phase).toBe("recovered");

    expect((await advance()).phase).toBe("recovered");
    expect((await advance()).phase).toBe("recovered");
    provider.refundStatus = "succeeded";
    expect((await advance()).phase).toBe("cancellation_requested");
    expect((await advance()).phase).toBe("cancellation_requested");
    expect((await advance()).phase).toBe("cancellation_requested");
    await sendSubscriptionEvent(
      "evt_launch_canceled",
      "canceled",
      periodThree,
      "customer.subscription.deleted"
    );
    expect((await advance()).phase).toBe("canceled");
    expect((await advance()).phase).toBe("clock_deleted");
    expect(await advance()).toMatchObject({
      phase: "complete",
      complete: true,
      pendingProviderEvidence: false
    });

    expect(fixture.sqlite.prepare(
      `SELECT scenario, state, observed_status
       FROM launch_lab_provider_scenarios
       WHERE run_id = ? AND provider = 'stripe'
         AND scenario IN (
           'renewal', 'payment_failure', 'payment_recovery', 'refund',
           'cancellation'
         )
       ORDER BY scenario`
    ).all(runId)).toEqual([
      { scenario: "cancellation", state: "passed", observed_status: "canceled" },
      { scenario: "payment_failure", state: "passed", observed_status: "past_due" },
      { scenario: "payment_recovery", state: "passed", observed_status: "active" },
      { scenario: "refund", state: "passed", observed_status: "refunded" },
      { scenario: "renewal", state: "passed", observed_status: "active" }
    ]);
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
    expect(provider.paths).toContain(
      `/v1/test_helpers/test_clocks/${clockId}`
    );
    expect(provider.paths.filter((path) => path === "/v1/refunds"))
      .toHaveLength(1);
    expect(provider.bodies.join("&")).not.toMatch(/email|address|card%5B/);
  });

  it("fails closed before provider I/O outside staging test mode", async () => {
    fixture = await lifecycleFixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(advanceLaunchLabStripeLifecycle({
      ...fixture.env,
      ENVIRONMENT: "production"
    }, runId)).rejects.toThrow("not_available");
    await expect(advanceLaunchLabStripeLifecycle({
      ...fixture.env,
      STRIPE_MODE: "live"
    }, runId)).rejects.toThrow("not_available");
    expect(fetch).not.toHaveBeenCalled();
  });

  async function advance() {
    return advanceLaunchLabStripeLifecycle(fixture.env, runId);
  }

  async function sendSubscriptionEvent(
    eventId,
    status,
    periodEnd,
    type = "customer.subscription.updated"
  ) {
    const attempt = fixture.sqlite.prepare(
      `SELECT id FROM subscription_checkout_attempts LIMIT 1`
    ).get();
    expect(attempt?.id).toMatch(/^checkout_launch_lab_/);
    const event = {
      id: eventId,
      type,
      livemode: false,
      created: 1_787_990_400 + providerEventOffset(eventId),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status,
          current_period_end: periodEnd,
          metadata: { dustwave_checkout_attempt_id: attempt.id }
        }
      }
    };
    const payload = JSON.stringify(event);
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

async function lifecycleFixture() {
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
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_launch_lab_lifecycle",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      LISTENER_EMAIL_LOOKUP_PEPPER: "launch_lab_listener_pepper"
    }
  };
}

function providerFixture() {
  const provider = {
    paths: [],
    bodies: [],
    clockStatus: "ready",
    subscriptionStatus: "active",
    periodEnd: periodOne,
    latestInvoice: null,
    refundStatus: "pending"
  };
  provider.fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    provider.paths.push(url.pathname);
    provider.bodies.push(String(init.body ?? ""));
    const method = init.method ?? "GET";
    let object;
    if (url.pathname === "/v1/products" && method === "POST") {
      object = productObject();
    } else if (url.pathname === `/v1/products/${productId}`) {
      object = productObject();
    } else if (url.pathname === "/v1/prices" && method === "POST") {
      object = priceObject();
    } else if (url.pathname === `/v1/prices/${priceId}`) {
      object = priceObject();
    } else if (
      url.pathname === "/v1/test_helpers/test_clocks"
      && method === "POST"
    ) {
      object = clockObject(provider.clockStatus);
    } else if (
      url.pathname === `/v1/test_helpers/test_clocks/${clockId}/advance`
    ) {
      provider.clockStatus = "advancing";
      object = clockObject("advancing");
    } else if (
      url.pathname === `/v1/test_helpers/test_clocks/${clockId}`
      && method === "DELETE"
    ) {
      object = { id: clockId, object: "test_helpers.test_clock", deleted: true };
    } else if (url.pathname === `/v1/test_helpers/test_clocks/${clockId}`) {
      object = clockObject(provider.clockStatus);
    } else if (url.pathname === "/v1/customers" && method === "POST") {
      object = {
        id: customerId,
        object: "customer",
        livemode: false,
        test_clock: clockId,
        metadata: {
          platform: "dust_wave_podcast",
          launch_lab_fixture: "subscription_monthly_v1",
          launch_lab_run_id: runId
        }
      };
    } else if (url.pathname === "/v1/subscriptions") {
      object = subscriptionObject(provider);
    } else if (
      url.pathname === `/v1/subscriptions/${subscriptionId}`
      && method === "DELETE"
    ) {
      provider.subscriptionStatus = "canceled";
      object = subscriptionObject(provider);
    } else if (url.pathname === `/v1/subscriptions/${subscriptionId}`) {
      object = subscriptionObject(provider);
    } else if (url.pathname.endsWith("/attach")) {
      object = {
        id: url.pathname.includes("chargeCustomerFail")
          ? "pm_launch_lab_failure"
          : "pm_launch_lab_recovery",
        object: "payment_method"
      };
    } else if (url.pathname === "/v1/invoices/in_launch_lab_failed") {
      object = {
        id: "in_launch_lab_failed",
        object: "invoice",
        livemode: false,
        status: "open",
        subscription: subscriptionId
      };
    } else if (url.pathname === "/v1/invoices/in_launch_lab_failed/pay") {
      object = {
        id: "in_launch_lab_failed",
        object: "invoice",
        livemode: false,
        status: "paid",
        subscription: subscriptionId
      };
    } else if (url.pathname === "/v1/invoice_payments") {
      object = {
        object: "list",
        url: "/v1/invoice_payments",
        has_more: false,
        data: [{
          id: "inpay_launch_lab_recovery",
          object: "invoice_payment",
          amount_paid: 100,
          currency: "usd",
          invoice: "in_launch_lab_failed",
          livemode: false,
          payment: { type: "payment_intent", payment_intent: paymentIntentId },
          status: "paid"
        }]
      };
    } else if (url.pathname === "/v1/refunds" && method === "POST") {
      object = refundObject(provider);
    } else if (url.pathname === `/v1/refunds/${refundId}`) {
      object = refundObject(provider);
    }
    return new Response(JSON.stringify(object ?? { error: { code: "missing" } }), {
      status: object ? 200 : 404,
      headers: { "content-type": "application/json", "request-id": "req_lab" }
    });
  });
  return provider;
}

function productObject() {
  return {
    id: productId,
    object: "product",
    livemode: false,
    active: true,
    metadata: {
      platform: "dust_wave_podcast",
      launch_lab_fixture: "subscription_monthly_v1"
    }
  };
}

function priceObject() {
  return {
    id: priceId,
    object: "price",
    livemode: false,
    active: true,
    product: productId,
    currency: "usd",
    unit_amount: 100,
    tax_behavior: "exclusive",
    lookup_key: "dust_wave_launch_lab_monthly_v1",
    recurring: { interval: "month", interval_count: 1 },
    metadata: {
      platform: "dust_wave_podcast",
      launch_lab_fixture: "subscription_monthly_v1"
    }
  };
}

function clockObject(status) {
  return {
    id: clockId,
    object: "test_helpers.test_clock",
    livemode: false,
    status
  };
}

function subscriptionObject(provider) {
  return {
    id: subscriptionId,
    object: "subscription",
    livemode: false,
    customer: customerId,
    status: provider.subscriptionStatus,
    current_period_end: provider.periodEnd,
    latest_invoice: provider.latestInvoice,
    metadata: {
      platform: "dust_wave_podcast",
      launch_lab_fixture: "subscription_monthly_v1"
    }
  };
}

function refundObject(provider) {
  return {
    id: refundId,
    object: "refund",
    amount: 100,
    currency: "usd",
    metadata: {
      platform: "dust_wave_podcast",
      launch_lab_fixture: "subscription_monthly_v1",
      launch_lab_run_id: runId
    },
    payment_intent: paymentIntentId,
    reason: "requested_by_customer",
    status: provider.refundStatus
  };
}

function providerEventOffset(eventId) {
  return {
    evt_launch_created: 10,
    evt_launch_renewed: 20,
    evt_launch_failed: 30,
    evt_launch_recovered: 40,
    evt_launch_canceled: 50
  }[eventId];
}
