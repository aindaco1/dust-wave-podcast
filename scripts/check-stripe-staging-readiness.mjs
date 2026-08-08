#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadWorkerConfig,
  runJson,
  wrangler
} from "./staging-gate-runtime.mjs";
const requiredWebhookEvents = [
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed"
];

export const stripeStagingInventorySql = `SELECT
  id, premium_enabled, billing_mode, stripe_product_id
FROM shows
WHERE premium_enabled = 1
  AND test_fixture = 0
ORDER BY id;
SELECT
  p.id, p.show_id, p.billing_period, p.amount_cents, p.currency,
  p.stripe_price_id, p.stripe_lookup_key, p.tax_behavior,
  p.provider_mode, s.stripe_product_id
FROM show_prices p
JOIN shows s ON s.id = p.show_id
WHERE p.active = 1
  AND s.test_fixture = 0
ORDER BY p.show_id, p.billing_period;
SELECT COUNT(DISTINCT t.id) AS approved_tax_versions
FROM show_tax_rate_assignments a
JOIN tax_rate_versions t ON t.id = a.tax_rate_version_id
JOIN shows s ON s.id = a.show_id
WHERE t.status = 'approved'
  AND t.rate_parts_per_million IS NOT NULL
  AND t.provider_mode = 'test'
  AND t.stripe_tax_rate_id IS NOT NULL
  AND t.effective_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND (
    t.expires_at IS NULL
    OR t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  AND s.billing_mode = 'test'
  AND s.premium_enabled = 1
  AND s.test_fixture = 0;
SELECT COUNT(*) AS checkout_attempts
FROM subscription_checkout_attempts;
SELECT
  COUNT(*) AS stripe_events,
  COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)
    AS failed_stripe_events
FROM stripe_event_journal;`;

export function evaluateStripeStagingReadiness(snapshot) {
  const results = [];
  const add = (status, label, detail) => {
    results.push({ status, label, detail });
  };
  const installedSecrets = new Set(snapshot.installedSecrets ?? []);
  const requiredSecrets = new Set(snapshot.requiredSecrets ?? []);

  if (snapshot.config?.stripeMode === "test") {
    add("PASS", "Stripe mode", "staging is test-only");
  } else {
    add("FAIL", "Stripe mode", "staging must use test mode");
  }
  if (snapshot.config?.checkoutEnabled === "false") {
    add("PASS", "Checkout kill switch", "disabled");
  } else {
    add("FAIL", "Checkout kill switch", "must remain disabled for preflight");
  }
  if (snapshot.config?.turnstileRequired === "true") {
    add("PASS", "Checkout Turnstile", "required");
  } else {
    add("FAIL", "Checkout Turnstile", "must fail closed");
  }

  for (const secret of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TAX_QUOTE_HASH_SECRET",
    "TURNSTILE_SECRET_KEY"
  ]) {
    if (requiredSecrets.has(secret) && installedSecrets.has(secret)) {
      add("PASS", `${secret} posture`, "required and installed");
    } else {
      add("FAIL", `${secret} posture`, "required or installed name missing");
    }
  }

  const providerProducts = new Map(
    (snapshot.provider?.products ?? []).map((product) => [product.id, product])
  );
  const providerPrices = new Map(
    (snapshot.provider?.prices ?? []).map((price) => [price.id, price])
  );
  if ((snapshot.shows ?? []).length < 1) {
    add("FAIL", "Subscription shows", "no configured show");
  }
  for (const show of snapshot.shows ?? []) {
    const product = providerProducts.get(show.stripe_product_id);
    if (!product) {
      add("FAIL", `Product ${show.id}`, "provider object missing");
      continue;
    }
    const productMatches = product.livemode === false
      && product.active === false
      && product.metadata?.show_id === show.id
      && product.metadata?.platform === "dust_wave_podcast"
      && show.billing_mode === "test"
      && Number(show.premium_enabled) === 1;
    add(
      productMatches ? "PASS" : "FAIL",
      `Product ${show.id}`,
      productMatches
        ? "exact test metadata; safely inactive"
        : "mode, metadata, or inactive posture mismatch"
    );
  }

  if ((snapshot.prices ?? []).length < 2) {
    add("FAIL", "Subscription Prices", "monthly and annual Prices required");
  }
  for (const price of snapshot.prices ?? []) {
    const provider = providerPrices.get(price.stripe_price_id);
    const expectedInterval = price.billing_period === "year"
      ? "year"
      : "month";
    const matches = provider
      && provider.livemode === false
      && provider.active === false
      && provider.currency === String(price.currency).toLowerCase()
      && provider.unit_amount === Number(price.amount_cents)
      && provider.recurring?.interval === expectedInterval
      && provider.recurring?.interval_count === 1
      && provider.recurring?.trial_period_days === null
      && provider.tax_behavior === price.tax_behavior
      && provider.lookup_key === price.stripe_lookup_key
      && provider.product === price.stripe_product_id
      && provider.metadata?.show_id === price.show_id
      && provider.metadata?.billing_period === price.billing_period
      && price.provider_mode === "test";
    add(
      matches ? "PASS" : "FAIL",
      `Price ${price.id}`,
      matches
        ? `${price.amount_cents} ${price.currency}; safely inactive`
        : "amount, interval, tax, metadata, mode, or inactive posture mismatch"
    );
  }

  const portal = snapshot.provider?.portal;
  const portalSafe = portal
    && portal.livemode === false
    && portal.active === true
    && portal.features?.customer_update?.enabled === false
    && portal.features?.subscription_update?.enabled === false
    && portal.features?.subscription_pause?.enabled === false
    && portal.features?.subscription_cancel?.enabled === true
    && portal.features?.subscription_cancel?.mode === "at_period_end"
    && portal.features?.subscription_cancel?.proration_behavior === "none";
  add(
    portalSafe ? "PASS" : "FAIL",
    "Customer Portal",
    portalSafe
      ? "test-only; address/plan/pause disabled"
      : "configuration permits an unsafe billing mutation"
  );

  const expectedWebhookUrl = `${
    String(snapshot.config?.feedOrigin ?? "").replace(/\/$/, "")
  }/v1/webhooks/stripe`;
  const webhook = (snapshot.provider?.webhookEndpoints ?? []).find(
    (entry) => entry.url === expectedWebhookUrl && entry.livemode === false
  );
  const enabledEvents = new Set(webhook?.enabled_events ?? []);
  const webhookReady = webhook?.status === "enabled"
    && enabledEvents.size === requiredWebhookEvents.length
    && requiredWebhookEvents.every((event) => enabledEvents.has(event));
  add(
    webhookReady ? "PASS" : "FAIL",
    "Stripe webhook",
    webhookReady
      ? "exact staging URL and required event set"
      : "endpoint, mode, status, or event set mismatch"
  );

  const failedEvents = Number(snapshot.state?.failedStripeEvents ?? 0);
  const eventCount = Number(snapshot.state?.stripeEvents ?? 0);
  add(
    failedEvents === 0 && eventCount > 0 ? "PASS" : "FAIL",
    "Webhook journal",
    failedEvents === 0 && eventCount > 0
      ? `${eventCount} processed/provider events; zero failed`
      : "requires provider evidence and zero failed events"
  );

  const checkoutAttempts = Number(snapshot.state?.checkoutAttempts ?? 0);
  add(
    checkoutAttempts === 0 ? "PASS" : "FAIL",
    "Checkout mutation posture",
    checkoutAttempts === 0
      ? "no staging attempts"
      : "unexpected Checkout attempts exist"
  );

  const approvedTaxVersions = Number(
    snapshot.state?.approvedTaxVersions ?? 0
  );
  add(
    approvedTaxVersions > 0 ? "PASS" : "BLOCK",
    "Accountant-approved tax",
    approvedTaxVersions > 0
      ? `${approvedTaxVersions} approved version(s)`
      : "no approved tax version; activation remains blocked"
  );

  const failCount = results.filter(({ status }) => status === "FAIL").length;
  const blockerCount = results.filter(({ status }) => status === "BLOCK")
    .length;
  return {
    schemaVersion: 1,
    results,
    summary: {
      passCount: results.filter(({ status }) => status === "PASS").length,
      failCount,
      blockerCount,
      safe: failCount === 0,
      activationReady: failCount === 0 && blockerCount === 0
    }
  };
}

export function loadStripeStagingSnapshot() {
  const config = loadWorkerConfig();
  const staging = config.env?.staging;
  if (!staging || staging.vars?.ENVIRONMENT !== "staging") {
    throw new Error("Exact staging configuration is required.");
  }
  const database = staging.d1_databases?.find(({ binding }) => binding === "DB");
  if (!database?.database_name) {
    throw new Error("Staging D1 binding is missing.");
  }

  const d1 = runProviderJson(wrangler, [
    "d1",
    "execute",
    database.database_name,
    "--env",
    "staging",
    "--remote",
    "--json",
    "--command",
    stripeStagingInventorySql
  ]);
  const queryResults = d1.map(({ results }) => results ?? []);
  const shows = queryResults[0] ?? [];
  const prices = queryResults[1] ?? [];
  const installedSecrets = runProviderJson(wrangler, [
    "secret",
    "list",
    "--env",
    "staging"
  ]).map(({ name }) => name);

  const products = shows.map((show) =>
    runStripeJson([
      "products",
      "retrieve",
      requiredIdentifier(show.stripe_product_id, "Stripe Product")
    ])
  );
  const providerPrices = prices.map((price) =>
    runStripeJson([
      "prices",
      "retrieve",
      requiredIdentifier(price.stripe_price_id, "Stripe Price")
    ])
  );
  const portalConfigurationId = requiredIdentifier(
    staging.vars.STRIPE_PORTAL_CONFIGURATION_ID,
    "Stripe Portal configuration"
  );
  const portal = runStripeJson([
    "billing_portal",
    "configurations",
    "retrieve",
    portalConfigurationId
  ]);
  const webhookEndpoints = runStripeJson([
    "webhook_endpoints",
    "list",
    "--limit",
    "100"
  ]).data ?? [];

  return {
    config: {
      stripeMode: staging.vars.STRIPE_MODE,
      checkoutEnabled: staging.vars.SUBSCRIPTION_CHECKOUT_ENABLED,
      turnstileRequired: staging.vars.CHECKOUT_TURNSTILE_REQUIRED,
      feedOrigin: staging.vars.FEED_ORIGIN,
      portalConfigurationId
    },
    requiredSecrets: staging.secrets?.required ?? [],
    installedSecrets,
    shows,
    prices,
    state: {
      approvedTaxVersions: queryResults[2]?.[0]?.approved_tax_versions ?? 0,
      checkoutAttempts: queryResults[3]?.[0]?.checkout_attempts ?? 0,
      stripeEvents: queryResults[4]?.[0]?.stripe_events ?? 0,
      failedStripeEvents:
        queryResults[4]?.[0]?.failed_stripe_events ?? 0
    },
    provider: {
      products,
      prices: providerPrices,
      portal,
      webhookEndpoints
    }
  };
}

function runStripeJson(args) {
  const operation = args.slice(0, 2).every((value) =>
    /^[a-z_]+$/u.test(String(value))
  )
    ? args.slice(0, 2).join(" ")
    : "provider";
  return runJson("stripe", buildStripeCliArgs(args), {
    failureLabel: `read-only Stripe ${operation} command`,
    classifyFailure: classifyStripeCliFailure
  });
}

export function buildStripeCliArgs(args, apiKey = process.env.STRIPE_API_KEY) {
  const key = String(apiKey ?? "").trim();
  if (!/^rk_test_[A-Za-z0-9_]{16,200}$/u.test(key)) {
    throw new Error("A restricted Stripe test API key is required.");
  }
  return [...args, "--api-key", key, "--color", "off"];
}

export function classifyStripeCliFailure(output) {
  const text = String(output ?? "").toLowerCase();
  if (/resource_missing|no such (?:product|price|billing portal)/u.test(text)) {
    return "resource missing";
  }
  if (
    /permission_missing|does not have access|not authorized|permission denied/u
      .test(text)
  ) {
    return "permission denied";
  }
  if (/invalid api key|authentication|authenticate/u.test(text)) {
    return "authentication rejected";
  }
  return "provider rejected request";
}

function runProviderJson(command, args) {
  return runJson(command, args, {
    failureLabel: "read-only provider command"
  });
}

function requiredIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_]{8,160}$/.test(text)) {
    throw new Error(`${label} identifier is invalid.`);
  }
  return text;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(
      "Usage: npm run gate:stripe:staging -- [--require-ready] [--json]\n\n"
      + "Runs read-only Cloudflare D1/secret-name and Stripe test-mode checks. "
      + "It never prints or retrieves secret values and never mutates a "
      + "provider object. BLOCK is expected until accountant tax approval.\n"
    );
    return;
  }
  const report = evaluateStripeStagingReadiness(
    loadStripeStagingSnapshot()
  );
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const result of report.results) {
      process.stdout.write(
        `${result.status.padEnd(5)} ${result.label} - ${result.detail}\n`
      );
    }
    process.stdout.write(
      `\nSummary: ${report.summary.passCount} pass, `
      + `${report.summary.blockerCount} block, `
      + `${report.summary.failCount} fail\n`
    );
  }
  if (
    report.summary.failCount > 0
    || (args.has("--require-ready") && report.summary.blockerCount > 0)
  ) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  await main();
}
