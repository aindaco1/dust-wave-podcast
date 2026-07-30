import { describe, expect, it } from "vitest";

import {
  evaluateStripeStagingReadiness
} from "../scripts/check-stripe-staging-readiness.mjs";

describe("read-only Stripe staging readiness gate", () => {
  it("accepts the safe inactive provider posture and retains the tax blocker", () => {
    const report = evaluateStripeStagingReadiness(readinessFixture());

    expect(report.summary).toEqual({
      passCount: 14,
      failCount: 0,
      blockerCount: 1,
      safe: true,
      activationReady: false
    });
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "PASS",
        label: "Checkout kill switch"
      }),
      expect.objectContaining({
        status: "BLOCK",
        label: "Accountant-approved tax"
      })
    ]));
  });

  it("fails on provider drift or accidental activation", () => {
    const fixture = readinessFixture();
    fixture.config.checkoutEnabled = "true";
    fixture.provider.prices[0].unit_amount = 999;

    const report = evaluateStripeStagingReadiness(fixture);

    expect(report.summary.safe).toBe(false);
    expect(report.summary.failCount).toBe(2);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "FAIL",
        label: "Checkout kill switch"
      }),
      expect.objectContaining({
        status: "FAIL",
        label: "Price price_opera_monthly_usd"
      })
    ]));
  });

  it("fails when a required secret is not both declared and installed", () => {
    const fixture = readinessFixture();
    fixture.installedSecrets = fixture.installedSecrets.filter(
      (name) => name !== "STRIPE_SECRET_KEY"
    );

    const report = evaluateStripeStagingReadiness(fixture);

    expect(report.summary.safe).toBe(false);
    expect(report.results).toContainEqual({
      status: "FAIL",
      label: "STRIPE_SECRET_KEY posture",
      detail: "required or installed name missing"
    });
  });

  it("fails when the webhook subscribes to events outside the allowlist", () => {
    const fixture = readinessFixture();
    fixture.provider.webhookEndpoints[0].enabled_events.push("charge.refunded");

    const report = evaluateStripeStagingReadiness(fixture);

    expect(report.summary.safe).toBe(false);
    expect(report.results).toContainEqual({
      status: "FAIL",
      label: "Stripe webhook",
      detail: "endpoint, mode, status, or event set mismatch"
    });
  });
});

function readinessFixture() {
  const requiredSecrets = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TAX_QUOTE_HASH_SECRET",
    "TURNSTILE_SECRET_KEY"
  ];
  return {
    config: {
      stripeMode: "test",
      checkoutEnabled: "false",
      turnstileRequired: "true",
      feedOrigin: "https://dust-wave-podcast-staging.jogo.workers.dev"
    },
    requiredSecrets,
    installedSecrets: [...requiredSecrets],
    shows: [{
      id: "show_opera_en_la_selva",
      premium_enabled: 1,
      billing_mode: "test",
      stripe_product_id: "prod_dw_podcast_opera_en_la_selva"
    }],
    prices: [
      price({
        id: "price_opera_monthly_usd",
        billing_period: "month",
        amount_cents: 500,
        stripe_price_id: "price_monthly",
        stripe_lookup_key: "dw_podcast_opera_monthly_usd"
      }),
      price({
        id: "price_opera_annual_usd",
        billing_period: "year",
        amount_cents: 5_000,
        stripe_price_id: "price_annual",
        stripe_lookup_key: "dw_podcast_opera_annual_usd"
      })
    ],
    state: {
      approvedTaxVersions: 0,
      checkoutAttempts: 0,
      stripeEvents: 2,
      failedStripeEvents: 0
    },
    provider: {
      products: [{
        id: "prod_dw_podcast_opera_en_la_selva",
        active: false,
        livemode: false,
        metadata: {
          platform: "dust_wave_podcast",
          show_id: "show_opera_en_la_selva"
        }
      }],
      prices: [
        providerPrice({
          id: "price_monthly",
          amount: 500,
          interval: "month",
          lookupKey: "dw_podcast_opera_monthly_usd",
          billingPeriod: "month"
        }),
        providerPrice({
          id: "price_annual",
          amount: 5_000,
          interval: "year",
          lookupKey: "dw_podcast_opera_annual_usd",
          billingPeriod: "year"
        })
      ],
      portal: {
        active: true,
        livemode: false,
        features: {
          customer_update: { enabled: false },
          subscription_update: { enabled: false },
          subscription_pause: { enabled: false },
          subscription_cancel: {
            enabled: true,
            mode: "at_period_end",
            proration_behavior: "none"
          }
        }
      },
      webhookEndpoints: [{
        url: "https://dust-wave-podcast-staging.jogo.workers.dev/v1/webhooks/stripe",
        livemode: false,
        status: "enabled",
        enabled_events: [
          "checkout.session.completed",
          "checkout.session.expired",
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "customer.subscription.paused",
          "customer.subscription.resumed"
        ]
      }]
    }
  };
}

function price({
  id,
  billing_period,
  amount_cents,
  stripe_price_id,
  stripe_lookup_key
}) {
  return {
    id,
    show_id: "show_opera_en_la_selva",
    billing_period,
    amount_cents,
    currency: "USD",
    stripe_price_id,
    stripe_lookup_key,
    tax_behavior: "exclusive",
    provider_mode: "test",
    stripe_product_id: "prod_dw_podcast_opera_en_la_selva"
  };
}

function providerPrice({
  id,
  amount,
  interval,
  lookupKey,
  billingPeriod
}) {
  return {
    id,
    active: false,
    livemode: false,
    currency: "usd",
    unit_amount: amount,
    recurring: {
      interval,
      interval_count: 1,
      trial_period_days: null
    },
    tax_behavior: "exclusive",
    lookup_key: lookupKey,
    product: "prod_dw_podcast_opera_en_la_selva",
    metadata: {
      show_id: "show_opera_en_la_selva",
      billing_period: billingPeriod
    }
  };
}
