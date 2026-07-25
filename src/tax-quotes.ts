import {
  calculateManualTax,
  normalizeTaxDestination,
  type TaxDestination
} from "@dustwave/tax-core";
import { hmacSha256 } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { trustedSiteOrigin } from "./passwordless-security";
import {
  readJsonObject,
  RequestValidationError,
  isTruthy,
  validIdentifier
} from "./validation";

const QUOTE_WINDOW_SECONDS = 60;
const QUOTE_LIMIT_PER_WINDOW = 60;

type PriceRow = {
  id: string;
  show_id: string;
  billing_period: "month" | "year";
  amount_cents: number;
  currency: string;
  tax_behavior: "exclusive" | "inclusive";
  stripe_price_id: string | null;
  provider_mode: "test" | "live";
  billing_mode: "disabled" | "test" | "live";
  premium_enabled: number;
};

type TaxRateRow = {
  id: string;
  jurisdiction_code: string;
  rate_parts_per_million: number;
  inclusive: number;
  provider_name: string;
  source_reference: string;
  stripe_tax_rate_id: string;
};

export type ResolvedSubscriptionTaxQuote = {
  price: PriceRow;
  taxRate: TaxRateRow;
  destination: TaxDestination;
  calculated: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    taxBehavior: "exclusive" | "inclusive";
  };
};

export type SubscriptionTaxResolution =
  | { ok: true; quote: ResolvedSubscriptionTaxQuote }
  | {
      ok: false;
      error:
        | "subscription_price_not_found"
        | "subscription_price_not_ready"
        | "tax_rate_not_approved"
        | "tax_configuration_mismatch"
        | "tax_configuration_invalid";
      status: 404 | 409;
    };

export async function quoteSubscriptionTax(
  request: Request,
  env: PodcastEnv,
  showSlug: string
): Promise<Response> {
  if (!env.TAX_QUOTE_HASH_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "tax_quote_not_configured" },
      { status: 503 }
    );
  }
  if (!trustedSiteOrigin(request, env.SITE_ORIGIN)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "origin_not_allowed" },
      { status: 403 }
    );
  }
  const identityHash = await hmacSha256(
    `podcast-tax-quote:${
      request.headers.get("cf-connecting-ip") ?? "unknown"
    }`,
    env.TAX_QUOTE_HASH_SECRET,
    "hex"
  );
  if (!await consumeQuoteRateLimit(env.DB, identityHash)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  const body = await readJsonObject(request, 16_384);
  const priceId = validIdentifier(body.priceId, "priceId");
  const normalized = normalizeTaxDestination(body.destination);
  if (!normalized.valid) {
    throw new RequestValidationError(normalized.error);
  }
  validateDestinationForQuote(normalized.destination);
  const resolution = await resolveSubscriptionTaxQuote(
    env,
    showSlug,
    priceId,
    normalized.destination
  );
  if (!resolution.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: resolution.error },
      { status: resolution.status }
    );
  }
  const { price, taxRate, calculated } = resolution.quote;
  return privateJson(request, env.ALLOWED_ORIGINS, {
    quote: {
      calculationVersion: "dustwave-manual-tax-v1",
      showSlug,
      priceId: price.id,
      billingPeriod: price.billing_period,
      currency: "USD",
      subtotalCents: calculated.subtotalCents,
      taxCents: calculated.taxCents,
      totalCents: calculated.totalCents,
      taxBehavior: calculated.taxBehavior,
      jurisdictionCode: taxRate.jurisdiction_code.toUpperCase(),
      taxRateVersionId: taxRate.id,
      providerName: taxRate.provider_name,
      destination: {
        country: normalized.destination.country,
        state: normalized.destination.state
      },
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    },
    checkoutEnabled: subscriptionCheckoutConfigured(env)
  });
}

export async function resolveSubscriptionTaxQuote(
  env: PodcastEnv,
  showSlug: string,
  priceId: string,
  destination: TaxDestination
): Promise<SubscriptionTaxResolution> {
  const price = await env.DB
    .prepare(
      `SELECT
         p.id, p.show_id, p.billing_period, p.amount_cents, p.currency,
         p.tax_behavior, p.stripe_price_id, p.provider_mode,
         s.billing_mode, s.premium_enabled
       FROM show_prices p
       JOIN shows s ON s.id = p.show_id
       WHERE
         s.slug = ?
         AND s.status != 'archived'
         AND p.id = ?
         AND p.active = 1`
    )
    .bind(showSlug, priceId)
    .first<PriceRow>();
  if (!price) {
    return {
      ok: false,
      error: "subscription_price_not_found",
      status: 404
    };
  }
  const expectedMode = String(env.STRIPE_MODE) === "live" ? "live" : "test";
  if (
    price.premium_enabled !== 1
    || price.billing_mode !== expectedMode
    || price.provider_mode !== expectedMode
    || price.currency.toUpperCase() !== "USD"
    || !price.stripe_price_id
  ) {
    return {
      ok: false,
      error: "subscription_price_not_ready",
      status: 409
    };
  }

  const candidates = taxJurisdictionCandidates(destination);
  const taxRate = await env.DB
    .prepare(
      `SELECT
         t.id, t.jurisdiction_code, t.rate_parts_per_million, t.inclusive,
         t.provider_name, t.source_reference, t.stripe_tax_rate_id
       FROM show_tax_rate_assignments a
       JOIN tax_rate_versions t ON t.id = a.tax_rate_version_id
       WHERE
         a.show_id = ?
         AND UPPER(t.jurisdiction_code) IN (${
           candidates.map(() => "?").join(", ")
         })
         AND t.status = 'approved'
         AND t.provider_mode = ?
         AND t.stripe_tax_rate_id IS NOT NULL
         AND t.effective_at <= datetime('now')
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
       ORDER BY
         length(t.jurisdiction_code) DESC,
         t.effective_at DESC,
         t.id DESC
       LIMIT 1`
    )
    .bind(price.show_id, ...candidates, expectedMode)
    .first<TaxRateRow>();
  if (!taxRate) {
    return {
      ok: false,
      error: "tax_rate_not_approved",
      status: 409
    };
  }
  const inclusive = price.tax_behavior === "inclusive";
  if (taxRate.inclusive !== (inclusive ? 1 : 0)) {
    return {
      ok: false,
      error: "tax_configuration_mismatch",
      status: 409
    };
  }
  let calculated;
  try {
    calculated = calculateManualTax({
      subtotalCents: price.amount_cents,
      ratePartsPerMillion: taxRate.rate_parts_per_million,
      taxBehavior: price.tax_behavior
    });
  } catch {
    return {
      ok: false,
      error: "tax_configuration_invalid",
      status: 409
    };
  }
  return {
    ok: true,
    quote: {
      price,
      taxRate,
      destination,
      calculated
    }
  };
}

export function subscriptionCheckoutConfigured(env: PodcastEnv): boolean {
  if (!isTruthy(env.SUBSCRIPTION_CHECKOUT_ENABLED)) return false;
  if (
    !env.STRIPE_SECRET_KEY
    || !env.STRIPE_WEBHOOK_SECRET
    || !env.LISTENER_EMAIL_LOOKUP_PEPPER
    || !env.TAX_QUOTE_HASH_SECRET
  ) {
    return false;
  }
  if (
    isTruthy(env.CHECKOUT_TURNSTILE_REQUIRED)
    && !env.TURNSTILE_SECRET_KEY
  ) {
    return false;
  }
  return true;
}

export function taxJurisdictionCandidates(
  destination: TaxDestination
): string[] {
  const country = destination.country.toUpperCase();
  const state = destination.state.toUpperCase();
  const postalCode = destination.postalCode
    .toUpperCase()
    .replace(/\s+/g, "")
    .split("-")[0];
  return [
    state && postalCode ? `${country}-${state}-${postalCode}` : "",
    state ? `${country}-${state}` : "",
    country
  ].filter((value, index, values) =>
    Boolean(value) && values.indexOf(value) === index
  );
}

export async function pruneTaxQuoteRateLimits(
  db: D1Database
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM subscription_tax_quote_rate_limits
       WHERE expires_at <= datetime('now')`
    )
    .run();
}

function validateDestinationForQuote(destination: TaxDestination): void {
  if (
    destination.country === "US"
    && !/^[A-Z]{2}$/.test(destination.state)
  ) {
    throw new RequestValidationError(
      "Billing state is required for a US tax quote"
    );
  }
}

async function consumeQuoteRateLimit(
  db: D1Database,
  identityHash: string
): Promise<boolean> {
  const currentSeconds = Math.floor(Date.now() / 1_000);
  const windowStartedAt =
    Math.floor(currentSeconds / QUOTE_WINDOW_SECONDS) * QUOTE_WINDOW_SECONDS;
  const expiresAt = windowStartedAt + QUOTE_WINDOW_SECONDS * 2;
  const bucket = await db
    .prepare(
      `INSERT INTO subscription_tax_quote_rate_limits (
         identity_hash, window_started_at, attempt_count, expires_at
       ) VALUES (?, ?, 1, datetime(?, 'unixepoch'))
       ON CONFLICT (identity_hash, window_started_at)
       DO UPDATE SET attempt_count = attempt_count + 1
       WHERE attempt_count <= ${QUOTE_LIMIT_PER_WINDOW}
       RETURNING attempt_count`
    )
    .bind(identityHash, windowStartedAt, expiresAt)
    .first<{ attempt_count: number }>();
  return Boolean(
    bucket
    && Number.isInteger(bucket.attempt_count)
    && bucket.attempt_count <= QUOTE_LIMIT_PER_WINDOW
  );
}
