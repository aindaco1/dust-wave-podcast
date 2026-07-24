import { describe, expect, it } from "vitest";

import {
  quoteSubscriptionTax,
  taxJurisdictionCandidates
} from "../src/tax-quotes";
import type { PodcastEnv } from "../src/env";

describe("subscription tax quotes", () => {
  it("uses the most specific approved manual-rate version without retaining an address", async () => {
    const fixture = taxFixture();
    const response = await quoteSubscriptionTax(
      taxRequest(),
      fixture.env,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      quote: {
        calculationVersion: "dustwave-manual-tax-v1",
        priceId: "price_opera_monthly",
        billingPeriod: "month",
        currency: "USD",
        subtotalCents: 500,
        taxCents: 39,
        totalCents: 539,
        jurisdictionCode: "US-NM-87120",
        taxRateVersionId: "tax_nm_87120_v1",
        destination: { country: "US", state: "NM" }
      },
      checkoutEnabled: false
    });
    expect(fixture.queries.some((query) =>
      query.includes("INSERT INTO subscription_tax_quote_rate_limits")
    )).toBe(true);
    expect(fixture.queries.some((query) =>
      query.includes("INSERT") && query.includes("postal")
    )).toBe(false);
  });

  it("fails closed when no assigned approved Stripe rate exists", async () => {
    const fixture = taxFixture({ taxRate: null });
    const response = await quoteSubscriptionTax(
      taxRequest(),
      fixture.env,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "tax_rate_not_approved"
    });
  });

  it("rate-limits by a pseudonymous client bucket before reading quote input", async () => {
    const fixture = taxFixture({ attemptCount: 61 });
    const response = await quoteSubscriptionTax(
      taxRequest(),
      fixture.env,
      "opera-en-la-selva"
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fixture.queries.some((query) =>
      query.includes("FROM show_prices")
    )).toBe(false);
  });

  it("orders exact postal, state, and country jurisdiction candidates", () => {
    expect(taxJurisdictionCandidates({
      country: "US",
      state: "NM",
      postalCode: "87120-1234",
      city: "",
      line1: "",
      line2: ""
    })).toEqual(["US-NM-87120", "US-NM", "US"]);
  });
});

function taxRequest(): Request {
  return new Request(
    "https://feeds.dustwave.xyz/v1/shows/opera-en-la-selva/tax/quote",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dustwave.xyz",
        "cf-connecting-ip": "192.0.2.20"
      },
      body: JSON.stringify({
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

function taxFixture({
  attemptCount = 1,
  taxRate = {
    id: "tax_nm_87120_v1",
    jurisdiction_code: "US-NM-87120",
    rate_parts_per_million: 78_750,
    inclusive: 0,
    provider_name: "manual_accountant"
  }
}: {
  attemptCount?: number;
  taxRate?: {
    id: string;
    jurisdiction_code: string;
    rate_parts_per_million: number;
    inclusive: number;
    provider_name: string;
  } | null;
} = {}) {
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("RETURNING attempt_count")) {
            return { attempt_count: attemptCount };
          }
          if (query.includes("FROM show_prices")) {
            return {
              id: "price_opera_monthly",
              show_id: "show_opera_en_la_selva",
              billing_period: "month",
              amount_cents: 500,
              currency: "USD",
              tax_behavior: "exclusive",
              provider_mode: "test",
              billing_mode: "test",
              premium_enabled: 1
            };
          }
          if (query.includes("FROM show_tax_rate_assignments")) {
            return taxRate;
          }
          return null;
        },
        async run() {
          return { success: true };
        }
      };
    }
  } as unknown as D1Database;
  return {
    queries,
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      STRIPE_MODE: "test",
      TAX_QUOTE_HASH_SECRET: "tax_quote_fixture"
    } as unknown as PodcastEnv
  };
}
