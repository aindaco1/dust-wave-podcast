import { describe, expect, it } from "vitest";

import { adminCsvCell } from "../src/admin-csv";
import { projectStripeTaxEvent } from "../src/billing-tax-evidence";
import type { PodcastEnv } from "../src/env";

describe("subscription tax reconciliation", () => {
  it("records content-minimized matching invoice evidence", async () => {
    const fixture = billingTaxFixture();
    const projected = await projectStripeTaxEvent(
      fixture.env,
      "evt_invoice_paid_fixture",
      "invoice.paid",
      {
        id: "in_invoice_fixture",
        customer: "cus_checkout_fixture",
        subscription: "sub_checkout_fixture",
        status: "paid",
        billing_reason: "subscription_cycle",
        currency: "usd",
        subtotal: 500,
        total: 539,
        amount_paid: 539,
        period_start: 1_785_024_000,
        period_end: 1_787_702_400,
        total_tax_amounts: [{
          amount: 39,
          tax_rate: {
            id: "txr_nm_fixture"
          }
        }],
        customer_address: {
          line1: "1 Private Address",
          postal_code: "87120"
        }
      }
    );

    expect(projected).toBe(true);
    const insert = fixture.statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO subscription_invoice_tax_evidence")
    );
    expect(insert).toBeDefined();
    expect(insert?.values.at(-1)).toBe("matched");
    expect(insert?.values).toContain(
      JSON.stringify(["txr_nm_fixture"])
    );
    expect(JSON.stringify(fixture.statements)).not.toContain(
      "1 Private Address"
    );
  });

  it("records a hashed rate-change preview without retaining an address", async () => {
    const fixture = billingTaxFixture();
    const projected = await projectStripeTaxEvent(
      fixture.env,
      "evt_customer_updated_fixture",
      "customer.updated",
      {
        id: "cus_checkout_fixture",
        address: {
          country: "US",
          state: "NM",
          postal_code: "87121",
          city: "Albuquerque",
          line1: "2 New Private Address"
        }
      }
    );

    expect(projected).toBe(true);
    const insert = fixture.statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO subscription_tax_change_previews")
    );
    expect(insert).toBeDefined();
    expect(insert?.values.at(-1)).toBe("rate_changed");
    expect(insert?.values[6]).toMatch(/^[a-f0-9]{64}$/);
    expect(insert?.values).toContain("tax_nm_87121_v2");
    expect(JSON.stringify(fixture.statements)).not.toContain(
      "2 New Private Address"
    );
    expect(JSON.stringify(fixture.statements)).not.toContain("Albuquerque");
  });

  it("ignores a non-subscription invoice without writing evidence", async () => {
    const fixture = billingTaxFixture();
    const projected = await projectStripeTaxEvent(
      fixture.env,
      "evt_manual_invoice_fixture",
      "invoice.finalized",
      {
        id: "in_manual_fixture",
        customer: "cus_checkout_fixture",
        status: "open",
        currency: "usd"
      }
    );

    expect(projected).toBe(false);
    expect(fixture.statements).toEqual([]);
  });

  it("fails retryably when a Dust Wave invoice arrives before its source projection", async () => {
    const fixture = billingTaxFixture({ subscriptionContext: null });
    await expect(projectStripeTaxEvent(
      fixture.env,
      "evt_out_of_order_fixture",
      "invoice.created",
      {
        id: "in_out_of_order_fixture",
        customer: "cus_checkout_fixture",
        parent: {
          subscription_details: {
            subscription: "sub_checkout_fixture",
            metadata: {
              dustwave_show_id: "show_opera"
            }
          }
        },
        status: "draft",
        currency: "usd"
      }
    )).rejects.toThrow("subscription_tax_context_not_found");
  });

  it("neutralizes spreadsheet formulas in accountant CSV cells", () => {
    expect(adminCsvCell("=HYPERLINK(\"bad\")")).toBe(
      "\"'=HYPERLINK(\"\"bad\"\")\""
    );
    expect(adminCsvCell("Dust Wave")).toBe("\"Dust Wave\"");
  });
});

function billingTaxFixture({
  subscriptionContext = {
    listener_id: "listener_fixture",
    show_id: "show_opera",
    show_slug: "opera-en-la-selva",
    price_id: "price_opera_monthly",
    provider_customer_id: "cus_checkout_fixture",
    provider_subscription_id: "sub_checkout_fixture",
    destination_hash: "a".repeat(64),
    tax_rate_version_id: "tax_nm_87120_v1",
    jurisdiction_code: "US-NM-87120",
    tax_rate_parts_per_million: 78_750,
    tax_behavior: "exclusive",
    subtotal_cents: 500,
    tax_cents: 39,
    total_cents: 539,
    stripe_tax_rate_id: "txr_nm_fixture"
  }
}: {
  subscriptionContext?: Record<string, unknown> | null;
} = {}) {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          statements.push({ query, values });
          return statement;
        },
        async first() {
          if (query.includes("FROM subscription_entitlement_sources source")) {
            return subscriptionContext;
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
            return {
              id: "tax_nm_87121_v2",
              jurisdiction_code: "US-NM-87121",
              rate_parts_per_million: 79_000,
              inclusive: 0,
              provider_name: "manual_accountant",
              source_reference: "accountant-fixture-v2",
              stripe_tax_rate_id: "txr_nm_fixture_v2"
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM subscription_entitlement_sources source")) {
            return {
              results: [{
                listener_id: "listener_fixture",
                show_id: "show_opera",
                show_slug: "opera-en-la-selva",
                price_id: "price_opera_monthly",
                provider_customer_id: "cus_checkout_fixture",
                provider_subscription_id: "sub_checkout_fixture",
                destination_hash: "a".repeat(64),
                tax_rate_version_id: "tax_nm_87120_v1",
                jurisdiction_code: "US-NM-87120",
                tax_rate_parts_per_million: 78_750
              }]
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return {
    statements,
    env: {
      DB: db,
      STRIPE_MODE: "test",
      TAX_QUOTE_HASH_SECRET: "tax_preview_fixture"
    } as unknown as PodcastEnv
  };
}
