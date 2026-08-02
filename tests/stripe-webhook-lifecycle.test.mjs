import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { handleStripeWebhook } from "../src/billing";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";
const webhookSecret = "whsec_launch_lab_lifecycle_fixture";
const emailPepper = "launch_lab_listener_email_fixture";
const listenerEmail = "listener@example.com";
const showId = "show_stripe_lifecycle";
const priceId = "price_stripe_lifecycle_monthly";
const attemptId = "checkout_stripe_lifecycle";
const sessionId = "cs_test_stripe_lifecycle";
const customerId = "cus_stripe_lifecycle";
const subscriptionId = "sub_stripe_lifecycle";
const baseCreatedAt = 1_785_024_000;

describe("Stripe webhook lifecycle contract", () => {
  let fixture;

  afterEach(() => fixture?.sqlite.close());

  it("keeps the newest subscription event and preserves an overlapping Pool grant", async () => {
    fixture = await lifecycleFixture();

    expect(await sendEvent(fixture, checkoutEvent())).toEqual({
      received: true
    });
    expect(sourceState(fixture.sqlite, "stripe")).toMatchObject({
      status: "active",
      provider_event_id: "evt_checkout_success",
      provider_event_created_at: baseCreatedAt
    });
    expect(aggregateState(fixture.sqlite)).toMatchObject({
      provider: "stripe",
      status: "active"
    });

    expect(await sendEvent(fixture, checkoutEvent())).toEqual({
      received: true,
      duplicate: true
    });
    expect(journalCount(fixture.sqlite, "evt_checkout_success")).toBe(1);

    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_monthly_renewal",
      created: baseCreatedAt + 100,
      status: "active",
      periodEnd: baseCreatedAt + 2_678_400
    }))).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe")).toMatchObject({
      status: "active",
      provider_event_id: "evt_monthly_renewal",
      provider_event_created_at: baseCreatedAt + 100,
      current_period_end: new Date(
        (baseCreatedAt + 2_678_400) * 1_000
      ).toISOString()
    });

    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_payment_failed",
      created: baseCreatedAt + 200,
      status: "past_due",
      periodEnd: baseCreatedAt + 2_678_400
    }))).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe").status).toBe("past_due");

    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_payment_recovered",
      created: baseCreatedAt + 300,
      status: "active",
      periodEnd: baseCreatedAt + 2_678_400
    }))).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe").status).toBe("active");

    addPoolSource(fixture.sqlite);
    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_subscription_canceled",
      created: baseCreatedAt + 400,
      status: "canceled",
      type: "customer.subscription.deleted",
      periodEnd: baseCreatedAt + 2_678_400
    }))).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe")).toMatchObject({
      status: "canceled",
      provider_event_id: "evt_subscription_canceled",
      provider_event_created_at: baseCreatedAt + 400
    });
    expect(aggregateState(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "active"
    });

    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_late_active",
      created: baseCreatedAt + 250,
      status: "active",
      periodEnd: baseCreatedAt + 2_678_400,
      includeMetadata: false
    }))).toEqual({ received: true });
    expect(await sendEvent(fixture, subscriptionEvent({
      id: "evt_same_second_active",
      created: baseCreatedAt + 400,
      status: "active",
      periodEnd: baseCreatedAt + 2_678_400
    }))).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe")).toMatchObject({
      status: "canceled",
      provider_event_id: "evt_subscription_canceled",
      provider_event_created_at: baseCreatedAt + 400
    });
    expect(aggregateState(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "active"
    });

    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM stripe_event_journal WHERE status != 'processed'"
    ).get()).toEqual({ count: 0 });
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(fixture.sqlite.prepare(
      "SELECT email_ciphertext FROM listener_accounts"
    ).get()).toEqual({ email_ciphertext: "not_retained:stripe:v1" });
  });

  it("keeps subscription status authoritative when a refund event has no approved policy", async () => {
    fixture = await lifecycleFixture();
    await sendEvent(fixture, checkoutEvent());

    expect(await sendEvent(fixture, {
      id: "evt_refund_unconfigured",
      type: "charge.refunded",
      livemode: false,
      created: baseCreatedAt + 50,
      data: {
        object: {
          id: "ch_refund_fixture",
          customer: customerId,
          invoice: "in_refund_fixture",
          refunded: true,
          amount_refunded: 539
        }
      }
    })).toEqual({ received: true });
    expect(sourceState(fixture.sqlite, "stripe").status).toBe("active");
    expect(fixture.sqlite.prepare(
      "SELECT status FROM stripe_event_journal WHERE event_id = ?"
    ).get("evt_refund_unconfigured")).toEqual({ status: "ignored" });
  });
});

async function lifecycleFixture() {
  const sqlite = migratedSqlite();
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, premium_enabled, billing_mode
     ) VALUES (?, ?, ?, ?, ?, 1, 'test')`
  ).run(
    showId,
    "stripe-lifecycle",
    "Stripe lifecycle",
    "https://staging.example/podcasts/stripe-lifecycle/",
    "stripe-lifecycle"
  );
  sqlite.prepare(
    `INSERT INTO show_prices (
       id, show_id, billing_period, amount_cents, currency,
       stripe_price_id, stripe_lookup_key, provider_mode
     ) VALUES (?, ?, 'month', 500, 'USD', ?, ?, 'test')`
  ).run(priceId, showId, "price_stripe_lifecycle", "stripe_lifecycle_monthly");
  const emailLookupHash = createHmac("sha256", emailPepper)
    .update(listenerEmail)
    .digest("hex");
  sqlite.prepare(
    `INSERT INTO subscription_checkout_attempts (
       id, show_id, price_id, stripe_session_id, status, idempotency_key,
       email_lookup_hash, provider_customer_id, provider_mode
     ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, 'test')`
  ).run(
    attemptId,
    showId,
    priceId,
    sessionId,
    "stripe-lifecycle-idempotency",
    emailLookupHash,
    customerId
  );
  return {
    sqlite,
    env: {
      DB: sqliteD1(sqlite),
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_MODE: "test",
      LISTENER_EMAIL_LOOKUP_PEPPER: emailPepper
    }
  };
}

function checkoutEvent() {
  return {
    id: "evt_checkout_success",
    type: "checkout.session.completed",
    livemode: false,
    created: baseCreatedAt,
    data: {
      object: {
        id: sessionId,
        customer: customerId,
        subscription: subscriptionId,
        payment_status: "paid",
        customer_details: { email: listenerEmail },
        metadata: { dustwave_checkout_attempt_id: attemptId }
      }
    }
  };
}

function subscriptionEvent({
  id,
  created,
  status,
  periodEnd,
  type = "customer.subscription.updated",
  includeMetadata = true
}) {
  return {
    id,
    type,
    livemode: false,
    created,
    data: {
      object: {
        id: subscriptionId,
        customer: customerId,
        status,
        current_period_end: periodEnd,
        ...(includeMetadata
          ? { metadata: { dustwave_checkout_attempt_id: attemptId } }
          : {})
      }
    }
  };
}

async function sendEvent(fixture, event) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const response = await handleStripeWebhook(
    new Request("https://staging.example/v1/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`
      },
      body: payload
    }),
    fixture.env
  );
  expect(response.status).toBe(200);
  return response.json();
}

function addPoolSource(sqlite) {
  const listener = sqlite.prepare(
    "SELECT id FROM listener_accounts LIMIT 1"
  ).get();
  sqlite.prepare(
    `INSERT INTO subscription_entitlement_sources (
       id, listener_id, show_id, price_id, provider,
       provider_subscription_id, status, current_period_end
     ) VALUES (?, ?, ?, ?, 'pool', ?, 'active', ?)`
  ).run(
    "source_pool_overlap",
    listener.id,
    showId,
    priceId,
    "pool_grant_lifecycle",
    "2032-01-01T00:00:00.000Z"
  );
}

function sourceState(sqlite, provider) {
  return sqlite.prepare(
    `SELECT
       status, current_period_end, provider_event_id,
       provider_event_created_at
     FROM subscription_entitlement_sources
     WHERE provider = ?`
  ).get(provider);
}

function aggregateState(sqlite) {
  return sqlite.prepare(
    "SELECT provider, status FROM subscriptions WHERE show_id = ?"
  ).get(showId);
}

function journalCount(sqlite, eventId) {
  return sqlite.prepare(
    "SELECT COUNT(*) AS count FROM stripe_event_journal WHERE event_id = ?"
  ).get(eventId).count;
}
