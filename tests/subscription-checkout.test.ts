import { afterEach, describe, expect, it, vi } from "vitest";

import { createSubscriptionCheckout } from "../src/subscription-checkout";
import type { PodcastEnv } from "../src/env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscription checkout", () => {
  it("fails before D1 or Stripe when the explicit checkout gate is off", async () => {
    let touchedDatabase = false;
    const response = await createSubscriptionCheckout(
      checkoutRequest(),
      {
        DB: {
          prepare() {
            touchedDatabase = true;
            throw new Error("unexpected D1 access");
          }
        },
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        SUBSCRIPTION_CHECKOUT_ENABLED: "false"
      } as unknown as PodcastEnv,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "checkout_not_available"
    });
    expect(touchedDatabase).toBe(false);
  });

  it("uses the approved fixed manual rate and keeps raw identity/address out of D1", async () => {
    const fixture = checkoutFixture();
    const stripeRequests: Array<{
      url: string;
      form: URLSearchParams;
      headers: Headers;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const form = new URLSearchParams(String(init?.body ?? ""));
      stripeRequests.push({ url, form, headers });
      if (url.endsWith("/customers")) {
        return stripeResponse({
          id: "cus_checkout_fixture",
          object: "customer"
        });
      }
      if (url.endsWith("/checkout/sessions")) {
        return stripeResponse({
          id: "cs_test_checkout_fixture",
          object: "checkout.session",
          status: "open",
          url: "https://checkout.stripe.com/c/pay/test_fixture",
          expires_at: Math.floor(Date.now() / 1_000) + 3600
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }));

    const response = await createSubscriptionCheckout(
      checkoutRequest(),
      fixture.env,
      "opera-en-la-selva"
    );
    const payload = await response.json() as {
      checkout: Record<string, unknown>;
    };

    expect(response.status).toBe(201);
    expect(payload.checkout).toMatchObject({
      priceId: "price_opera_monthly",
      subtotalCents: 500,
      taxCents: 39,
      totalCents: 539,
      jurisdictionCode: "US-NM-87120"
    });
    expect(stripeRequests).toHaveLength(2);
    expect(stripeRequests[0].form.get("email")).toBe("listener@example.com");
    expect(stripeRequests[0].form.get("address[postal_code]")).toBe("87120");
    expect(stripeRequests[1].form.get(
      "subscription_data[default_tax_rates][0]"
    )).toBe("txr_nm_fixture");
    expect(stripeRequests[1].form.get(
      "integration_identifier"
    )).toMatch(/^dustwave_podcast_[a-z]{8}$/);
    expect(stripeRequests[1].form.has("payment_method_types[0]")).toBe(false);
    expect(stripeRequests[1].form.has("automatic_tax[enabled]")).toBe(false);
    expect(stripeRequests[1].form.has(
      "line_items[0][dynamic_tax_rates][0]"
    )).toBe(false);
    expect(stripeRequests.every(({ headers }) =>
      headers.get("stripe-version") === "2026-06-24.dahlia"
    )).toBe(true);

    const d1Evidence = JSON.stringify(fixture.bindings);
    expect(d1Evidence).not.toContain("listener@example.com");
    expect(d1Evidence).not.toContain("1 Private Address");
    expect(fixture.bindings.flat()).not.toContain("87120");
    expect(d1Evidence).toContain("US-NM-87120");
  });

  it("does not call Stripe when no accountant-approved rate is assigned", async () => {
    const fixture = checkoutFixture({ taxRate: null });
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    const response = await createSubscriptionCheckout(
      checkoutRequest(),
      fixture.env,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "tax_rate_not_approved"
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed before Stripe when a reusable attempt lacks its integration identifier", async () => {
    const fixture = checkoutFixture({ dropIntegrationIdentifier: true });
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    const response = await createSubscriptionCheckout(
      checkoutRequest(),
      fixture.env,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "checkout_state_unavailable"
    });
    expect(provider).not.toHaveBeenCalled();
  });
});

function checkoutRequest(): Request {
  return new Request(
    "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/checkout",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dustwave.xyz",
        "cf-connecting-ip": "192.0.2.42"
      },
      body: JSON.stringify({
        email: "Listener@Example.com",
        priceId: "price_opera_monthly",
        destination: {
          country: "US",
          state: "NM",
          postalCode: "87120",
          city: "Albuquerque",
          line1: "1 Private Address"
        }
      })
    }
  );
}

function checkoutFixture({
  taxRate = {
    id: "tax_nm_87120_v1",
    jurisdiction_code: "US-NM-87120",
    rate_parts_per_million: 78_750,
    inclusive: 0,
    provider_name: "manual_accountant",
    source_reference: "accountant-fixture-v1",
    stripe_tax_rate_id: "txr_nm_fixture"
  },
  dropIntegrationIdentifier = false
}: {
  taxRate?: {
    id: string;
    jurisdiction_code: string;
    rate_parts_per_million: number;
    inclusive: number;
    provider_name: string;
    source_reference: string;
    stripe_tax_rate_id: string;
  } | null;
  dropIntegrationIdentifier?: boolean;
} = {}) {
  const bindings: unknown[][] = [];
  let attempt: Record<string, unknown> | null = null;
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          bindings.push(bound);
          return statement;
        },
        async first() {
          if (query.includes("RETURNING attempt_count")) {
            return { attempt_count: 1 };
          }
          if (query.includes("FROM show_prices")) {
            return {
              id: "price_opera_monthly",
              show_id: "show_opera",
              billing_period: "month",
              amount_cents: 500,
              currency: "USD",
              tax_behavior: "exclusive",
              stripe_price_id: "price_stripe_monthly",
              provider_mode: "test",
              billing_mode: "test",
              premium_enabled: 1
            };
          }
          if (query.includes("FROM show_tax_rate_assignments")) {
            return taxRate;
          }
          if (query.includes("FROM listener_accounts")) return null;
          if (
            query.includes("FROM subscription_checkout_attempts")
            && query.includes("status = 'created'")
          ) {
            return attempt;
          }
          return null;
        },
        async run() {
          if (query.includes("INSERT INTO subscription_checkout_attempts")) {
            attempt = {
              id: values[0],
              show_id: values[1],
              price_id: values[2],
              email_lookup_hash: values[3],
              destination_hash: values[4],
              provider_customer_id: null,
              stripe_session_id: null,
              tax_rate_version_id: values[6],
              jurisdiction_code: values[7],
              stripe_integration_identifier: dropIntegrationIdentifier
                ? null
                : values[15],
              status: "created",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              idempotency_key: values[16]
            };
          }
          if (
            query.includes("SET provider_customer_id")
            && attempt
          ) {
            attempt.provider_customer_id = values[0];
          }
          if (query.includes("SET stripe_session_id") && attempt) {
            attempt.stripe_session_id = values[0];
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return {
    bindings,
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      LISTENER_EMAIL_LOOKUP_PEPPER: "listener_email_fixture",
      TAX_QUOTE_HASH_SECRET: "tax_quote_fixture",
      SUBSCRIPTION_CHECKOUT_ENABLED: "true",
      CHECKOUT_TURNSTILE_REQUIRED: "false"
    } as unknown as PodcastEnv
  };
}

function stripeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "request-id": "req_fixture"
    }
  });
}
