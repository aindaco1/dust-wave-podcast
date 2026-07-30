import { describe, expect, it } from "vitest";

import { handleStripeWebhook } from "../src/billing";
import type { PodcastEnv } from "../src/env";

describe("Stripe webhook boundary", () => {
  it("rejects an oversized declared payload before touching D1", async () => {
    const response = await handleStripeWebhook(
      new Request("https://feeds.dustwave.xyz/v1/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-length": "1000001",
          "stripe-signature": "invalid"
        },
        body: "{}"
      }),
      {
        STRIPE_WEBHOOK_SECRET: "whsec_fixture"
      } as PodcastEnv
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("rejects an unsigned provider payload before touching D1", async () => {
    const response = await handleStripeWebhook(
      new Request("https://feeds.dustwave.xyz/v1/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify({ id: "evt_fixture" })
      }),
      {
        STRIPE_WEBHOOK_SECRET: "whsec_fixture"
      } as PodcastEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
  });

  it("projects a paid Checkout into a source plus aggregate without binding raw email", async () => {
    const fixture = webhookFixture();
    const event = {
      id: "evt_checkout_fixture",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1_000),
      data: {
        object: {
          id: "cs_test_checkout_fixture",
          customer: "cus_checkout_fixture",
          subscription: "sub_checkout_fixture",
          payment_status: "paid",
          customer_details: {
            email: "listener@example.com"
          },
          metadata: {
            dustwave_checkout_attempt_id: "checkout_fixture"
          }
        }
      }
    };
    const response = await handleStripeWebhook(
      await signedWebhookRequest(event, "whsec_fixture"),
      fixture.env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(fixture.queries.some((query) =>
      query.includes("INSERT INTO subscription_entitlement_sources")
    )).toBe(true);
    expect(fixture.queries.some((query) =>
      query.includes("INSERT INTO subscriptions")
    )).toBe(true);
    expect(JSON.stringify(fixture.bindings)).not.toContain(
      "listener@example.com"
    );
  });

  it("retries a previously failed journal entry instead of dropping it as a duplicate", async () => {
    const fixture = webhookFixture({
      insertedChanges: 0,
      journalStatus: "failed"
    });
    const event = {
      id: "evt_expired_fixture",
      type: "checkout.session.expired",
      livemode: false,
      created: Math.floor(Date.now() / 1_000),
      data: {
        object: {
          id: "cs_test_expired_fixture"
        }
      }
    };
    const response = await handleStripeWebhook(
      await signedWebhookRequest(event, "whsec_fixture"),
      fixture.env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(fixture.queries.some((query) =>
      query.includes("status = 'expired'")
    )).toBe(true);
  });
});

async function signedWebhookRequest(
  event: Record<string, unknown>,
  secret: string
): Promise<Request> {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacHex(
    secret,
    `${timestamp}.${payload}`
  );
  return new Request("https://feeds.dustwave.xyz/v1/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`
    },
    body: payload
  });
}

function webhookFixture({
  insertedChanges = 1,
  journalStatus = "received"
}: {
  insertedChanges?: number;
  journalStatus?: string;
} = {}) {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const emailHashPromise = hmacHex(
    "listener_email_fixture",
    "listener@example.com"
  );
  const db = {
    prepare(query: string) {
      queries.push(query);
      const statement = {
        bind(...values: unknown[]) {
          bindings.push(values);
          return statement;
        },
        async first() {
          if (query.includes("SELECT status") && query.includes(
            "stripe_event_journal"
          )) {
            return { status: journalStatus };
          }
          if (query.includes("FROM subscription_checkout_attempts")) {
            return {
              id: "checkout_fixture",
              show_id: "show_opera",
              price_id: "price_opera_monthly",
              email_lookup_hash: await emailHashPromise,
              provider_customer_id: "cus_checkout_fixture"
            };
          }
          if (query.includes("FROM listener_accounts")) {
            return { id: "listener_fixture" };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM subscription_entitlement_sources")) {
            return {
              results: [{
                price_id: "price_opera_monthly",
                provider: "stripe",
                provider_customer_id: "cus_checkout_fixture",
                provider_subscription_id: "sub_checkout_fixture",
                status: "active",
                current_period_end: null
              }]
            };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("INSERT OR IGNORE INTO stripe_event_journal")) {
            return { success: true, meta: { changes: insertedChanges } };
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return {
    queries,
    bindings,
    env: {
      DB: db,
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_MODE: "test",
      LISTENER_EMAIL_LOOKUP_PEPPER: "listener_email_fixture"
    } as unknown as PodcastEnv
  };
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
