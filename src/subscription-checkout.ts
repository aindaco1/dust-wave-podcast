import { normalizeTaxDestination } from "@dustwave/tax-core";
import {
  hmacSha256,
  normalizeEmail,
  randomToken
} from "@dustwave/worker-core/crypto";
import {
  StripeApiError
} from "@dustwave/worker-core/stripe";
import { verifyTurnstile } from "@dustwave/worker-core/turnstile";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { requireListener } from "./listener-auth";
import {
  isValidEmailAddress,
  normalizeLoginLanguage,
  trustedSiteOrigin
} from "./passwordless-security";
import {
  resolveSubscriptionTaxQuote,
  subscriptionCheckoutConfigured
} from "./tax-quotes";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  createPodcastStripeClient,
  logStripeBoundaryError,
  stripeErrorStatus,
  validStripeHostedUrl,
  validStripeId
} from "./stripe-client";
import {
  readJsonObject,
  readOptionalJsonObject,
  RequestValidationError,
  validIdentifier
} from "./validation";
import { consumeSubscriptionRateLimit } from "./subscription-rate-limits";

const CHECKOUT_CLIENT_LIMIT = {
  action: "checkout_client",
  windowSeconds: 15 * 60,
  maximum: 12
} as const;
const CHECKOUT_EMAIL_LIMIT = {
  action: "checkout_email",
  windowSeconds: 60 * 60,
  maximum: 5
} as const;
const PORTAL_LIMIT = {
  action: "portal_session",
  windowSeconds: 60,
  maximum: 10
} as const;
const CHECKOUT_TTL_SECONDS = 60 * 60;

type CheckoutAttemptRow = {
  id: string;
  show_id: string;
  price_id: string;
  email_lookup_hash: string;
  destination_hash: string;
  provider_customer_id: string | null;
  stripe_session_id: string | null;
  tax_rate_version_id: string;
  jurisdiction_code: string;
  stripe_integration_identifier: string | null;
  status: "created" | "completed" | "expired" | "failed";
  expires_at: string | null;
  idempotency_key: string;
};

type StripeCheckoutSession = Record<string, unknown> & {
  id?: string;
  url?: string | null;
  status?: string;
  expires_at?: number;
};

export async function createSubscriptionCheckout(
  request: Request,
  env: PodcastEnv,
  showSlug: string
): Promise<Response> {
  if (!subscriptionCheckoutConfigured(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "checkout_not_available" },
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
  const clientHash = await hmacSha256(
    `podcast-checkout-client:${
      request.headers.get("cf-connecting-ip") ?? "unknown"
    }`,
    env.TAX_QUOTE_HASH_SECRET || "",
    "hex"
  );
  if (!await consumeSubscriptionRateLimit(
    env.DB,
    CHECKOUT_CLIENT_LIMIT,
    clientHash
  )) {
    return rateLimitedResponse(request, env, CHECKOUT_CLIENT_LIMIT.windowSeconds);
  }

  const body = await readJsonObject(request, 16_384);
  const language = normalizeLoginLanguage(body.language);
  const email = normalizeEmail(body.email);
  if (!isValidEmailAddress(email)) {
    throw new RequestValidationError("email is invalid");
  }
  const priceId = validIdentifier(body.priceId, "priceId");
  const normalized = normalizeTaxDestination(body.destination);
  if (!normalized.valid) {
    throw new RequestValidationError(normalized.error);
  }
  if (
    normalized.destination.country === "US"
    && !/^[A-Z]{2}$/.test(normalized.destination.state)
  ) {
    throw new RequestValidationError(
      "Billing state is required for a US checkout"
    );
  }
  const emailHash = await hmacSha256(
    email,
    env.LISTENER_EMAIL_LOOKUP_PEPPER || "",
    "hex"
  );
  if (!await consumeSubscriptionRateLimit(
    env.DB,
    CHECKOUT_EMAIL_LIMIT,
    emailHash
  )) {
    return rateLimitedResponse(request, env, CHECKOUT_EMAIL_LIMIT.windowSeconds);
  }

  const taxResolution = await resolveSubscriptionTaxQuote(
    env,
    showSlug,
    priceId,
    normalized.destination
  );
  if (!taxResolution.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: taxResolution.error },
      { status: taxResolution.status }
    );
  }
  const challenge = await verifyTurnstile(
    request,
    env,
    String(body.turnstileToken ?? request.headers.get("x-turnstile-token") ?? ""),
    {
      action: "podcast_subscription_checkout",
      requiredEnvName: "CHECKOUT_TURNSTILE_REQUIRED"
    }
  );
  if (!challenge.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: challenge.code },
      { status: challenge.status }
    );
  }
  const destinationHash = await hmacSha256(
    JSON.stringify({
      country: normalized.destination.country,
      state: normalized.destination.state,
      postalCode: normalized.destination.postalCode,
      city: normalized.destination.city,
      line1: normalized.destination.line1,
      line2: normalized.destination.line2,
      language
    }),
    env.TAX_QUOTE_HASH_SECRET || "",
    "hex"
  );
  const { price, taxRate, calculated } = taxResolution.quote;
  const activeSubscription = await env.DB
    .prepare(
      `SELECT s.id
       FROM listener_accounts l
       JOIN subscriptions s ON s.listener_id = l.id
       WHERE
         l.email_lookup_hash = ?
         AND s.show_id = ?
         AND s.status = 'active'
         AND (
           s.current_period_end IS NULL
           OR s.current_period_end > ${SQL_UTC_NOW_RFC3339}
         )
       LIMIT 1`
    )
    .bind(emailHash, price.show_id)
    .first<{ id: string }>();
  if (activeSubscription) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "subscription_already_active" },
      { status: 409 }
    );
  }

  await env.DB
    .prepare(
      `UPDATE subscription_checkout_attempts
       SET status = 'expired', updated_at = datetime('now')
       WHERE
         show_id = ?
         AND email_lookup_hash = ?
         AND status = 'created'
         AND expires_at <= datetime('now')`
    )
    .bind(price.show_id, emailHash)
    .run();
  let attempt = await findActiveAttempt(env.DB, price.show_id, emailHash);
  if (attempt && (
    attempt.price_id !== price.id
    || attempt.destination_hash !== destinationHash
    || attempt.tax_rate_version_id !== taxRate.id
  )) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "checkout_already_started",
        expiresAt: attempt.expires_at
      },
      { status: 409 }
    );
  }
  if (!attempt) {
    const attemptId = `checkout_${randomToken(18)}`;
    const idempotencyKey = `podcast-checkout-${attemptId}`;
    try {
      await env.DB
        .prepare(
          `INSERT INTO subscription_checkout_attempts (
             id, show_id, price_id, email_lookup_hash, destination_hash,
             provider_mode, tax_rate_version_id, jurisdiction_code,
             tax_rate_parts_per_million, tax_behavior, subtotal_cents,
             tax_cents, total_cents, tax_provider_name,
             tax_source_reference, stripe_integration_identifier,
             idempotency_key, expires_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             datetime('now', '+1 hour')
           )`
        )
        .bind(
          attemptId,
          price.show_id,
          price.id,
          emailHash,
          destinationHash,
          expectedStripeMode(env),
          taxRate.id,
          taxRate.jurisdiction_code.toUpperCase(),
          taxRate.rate_parts_per_million,
          price.tax_behavior,
          calculated.subtotalCents,
          calculated.taxCents,
          calculated.totalCents,
          taxRate.provider_name,
          taxRate.source_reference,
          `dustwave_podcast_${randomLowercaseLetters(8)}`,
          idempotencyKey
        )
        .run();
    } catch {
      // The partial unique index resolves concurrent starts to one attempt.
    }
    attempt = await findActiveAttempt(env.DB, price.show_id, emailHash);
    if (!attempt) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "checkout_state_unavailable" },
        { status: 503 }
      );
    }
  }

  const integrationIdentifier = attempt.stripe_integration_identifier;
  if (
    !attempt.stripe_session_id
    && !validStripeIntegrationIdentifier(integrationIdentifier)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "checkout_state_unavailable" },
      { status: 503 }
    );
  }

  const stripe = createPodcastStripeClient(env);
  let customerId = attempt.provider_customer_id;
  try {
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email,
          address: {
            country: normalized.destination.country,
            state: normalized.destination.state || undefined,
            postal_code: normalized.destination.postalCode,
            city: normalized.destination.city || undefined,
            line1: normalized.destination.line1 || undefined,
            line2: normalized.destination.line2 || undefined
          },
          metadata: {
            dustwave_checkout_attempt_id: attempt.id,
            dustwave_show_id: attempt.show_id
          }
        },
        { idempotencyKey: `${attempt.idempotency_key}-customer` }
      );
      customerId = validStripeId(customer.id, "cus");
      await env.DB
        .prepare(
          `UPDATE subscription_checkout_attempts
           SET provider_customer_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(customerId, attempt.id)
        .run();
    }

    let session: StripeCheckoutSession;
    const reusedSession = Boolean(attempt.stripe_session_id);
    if (attempt.stripe_session_id) {
      session = await stripe.checkout.sessions.retrieve(
        attempt.stripe_session_id
      ) as StripeCheckoutSession;
    } else {
      session = await stripe.checkout.sessions.create(
        {
          customer: customerId,
          mode: "subscription",
          integration_identifier: integrationIdentifier,
          line_items: [{
            price: price.stripe_price_id,
            quantity: 1
          }],
          subscription_data: {
            default_tax_rates: [taxRate.stripe_tax_rate_id],
            metadata: {
              dustwave_checkout_attempt_id: attempt.id,
              dustwave_show_id: attempt.show_id,
              dustwave_price_id: price.id,
              dustwave_tax_rate_version_id: taxRate.id
            }
          },
          client_reference_id: attempt.id,
          metadata: {
            dustwave_checkout_attempt_id: attempt.id,
            dustwave_show_id: attempt.show_id,
            dustwave_price_id: price.id
          },
          success_url: `${
            env.SITE_ORIGIN.replace(/\/$/, "")
          }${language === "es" ? "/es" : ""}/podcasts/account/?checkout=success`,
          cancel_url: `${
            env.SITE_ORIGIN.replace(/\/$/, "")
          }${language === "es" ? "/es" : ""}/podcasts/${showSlug}/?checkout=canceled`,
          locale: language,
          expires_at: Math.floor(Date.now() / 1_000) + CHECKOUT_TTL_SECONDS
        },
        { idempotencyKey: `${attempt.idempotency_key}-session` }
      ) as StripeCheckoutSession;
      const sessionId = validStripeId(session.id, "cs");
      await env.DB
        .prepare(
          `UPDATE subscription_checkout_attempts
           SET stripe_session_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(sessionId, attempt.id)
        .run();
    }
    const checkoutUrl = validStripeHostedUrl(
      session.url,
      "checkout.stripe.com"
    );
    if (session.status && session.status !== "open") {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "checkout_session_not_open" },
        { status: 409 }
      );
    }
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        checkout: {
          url: checkoutUrl,
          expiresAt: Number.isSafeInteger(session.expires_at)
            ? new Date(Number(session.expires_at) * 1_000).toISOString()
            : attempt.expires_at,
          priceId: price.id,
          billingPeriod: price.billing_period,
          currency: "USD",
          subtotalCents: calculated.subtotalCents,
          taxCents: calculated.taxCents,
          totalCents: calculated.totalCents,
          jurisdictionCode: taxRate.jurisdiction_code.toUpperCase()
        }
      },
      { status: reusedSession ? 200 : 201 }
    );
  } catch (error) {
    await recordCheckoutFailure(env.DB, attempt.id, error);
    logStripeBoundaryError("checkout_session_failed", error);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "checkout_provider_unavailable" },
      { status: stripeErrorStatus(error) }
    );
  }
}

export async function createListenerBillingPortal(
  request: Request,
  env: PodcastEnv,
  showSlug: string
): Promise<Response> {
  const auth = await requireListener(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  if (
    !env.STRIPE_SECRET_KEY
    || !env.STRIPE_PORTAL_CONFIGURATION_ID
    || !env.TAX_QUOTE_HASH_SECRET
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "billing_portal_not_configured" },
      { status: 503 }
    );
  }
  const body = await readOptionalJsonObject(request, 1_024);
  const language = normalizeLoginLanguage(body.language);
  if (!await consumeSubscriptionRateLimit(
    env.DB,
    PORTAL_LIMIT,
    await hmacSha256(
      `podcast-portal:${auth.authorization.sessionTokenHash}:${showSlug}`,
      env.TAX_QUOTE_HASH_SECRET,
      "hex"
    )
  )) {
    return rateLimitedResponse(request, env, PORTAL_LIMIT.windowSeconds);
  }
  const source = await env.DB
    .prepare(
      `SELECT es.provider_customer_id
       FROM subscription_entitlement_sources es
       JOIN shows sh ON sh.id = es.show_id
       WHERE
         es.listener_id = ?
         AND sh.slug = ?
         AND sh.test_fixture = 0
         AND es.provider = 'stripe'
         AND es.provider_customer_id IS NOT NULL
       ORDER BY
         CASE es.status
           WHEN 'active' THEN 0
           WHEN 'past_due' THEN 1
           ELSE 2
         END,
         es.updated_at DESC
       LIMIT 1`
    )
    .bind(auth.authorization.identity.id, showSlug)
    .first<{ provider_customer_id: string }>();
  if (!source) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "stripe_subscription_not_found" },
      { status: 404 }
    );
  }

  try {
    const minute = Math.floor(Date.now() / 60_000);
    const portal = await createPodcastStripeClient(env).billingPortal.sessions.create(
      {
        customer: validStripeId(source.provider_customer_id, "cus"),
        configuration: validStripeId(
          env.STRIPE_PORTAL_CONFIGURATION_ID,
          "bpc"
        ),
        return_url: `${
          env.SITE_ORIGIN.replace(/\/$/, "")
        }${language === "es" ? "/es" : ""}/podcasts/account/`
      },
      {
        idempotencyKey: `podcast-portal-${
          auth.authorization.identity.id
        }-${showSlug}-${language}-${minute}`
      }
    );
    return privateJson(request, env.ALLOWED_ORIGINS, {
      portal: {
        url: validStripeHostedUrl(portal.url, "billing.stripe.com")
      }
    });
  } catch (error) {
    logStripeBoundaryError("billing_portal_failed", error);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "billing_portal_unavailable" },
      { status: stripeErrorStatus(error) }
    );
  }
}

export async function pruneSubscriptionBillingRateLimits(
  db: D1Database
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM subscription_billing_rate_limits
       WHERE expires_at <= datetime('now')`
    )
    .run();
}

async function findActiveAttempt(
  db: D1Database,
  showId: string,
  emailHash: string
): Promise<CheckoutAttemptRow | null> {
  return db
    .prepare(
      `SELECT
         id, show_id, price_id, email_lookup_hash, destination_hash,
         provider_customer_id, stripe_session_id, tax_rate_version_id,
         jurisdiction_code, stripe_integration_identifier, status,
         expires_at, idempotency_key
       FROM subscription_checkout_attempts
       WHERE
         show_id = ?
         AND email_lookup_hash = ?
         AND status = 'created'
         AND expires_at > datetime('now')
       LIMIT 1`
    )
    .bind(showId, emailHash)
    .first<CheckoutAttemptRow>();
}

function randomLowercaseLetters(length: number): string {
  if (!Number.isSafeInteger(length) || length < 1 || length > 32) {
    throw new RangeError("Random label length is out of range");
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) =>
    String.fromCharCode(97 + (byte % 26))
  ).join("");
}

function validStripeIntegrationIdentifier(
  value: string | null
): value is string {
  return /^dustwave_podcast_[a-z]{8}$/.test(value ?? "");
}

async function recordCheckoutFailure(
  db: D1Database,
  attemptId: string,
  error: unknown
): Promise<void> {
  // An unknown local/provider-response failure might follow a successful
  // remote mutation. Keep the attempt reusable with the same idempotency key.
  const retryable = !(error instanceof StripeApiError) || error.retryable;
  await db
    .prepare(
      `UPDATE subscription_checkout_attempts
       SET
         status = CASE WHEN ? = 1 THEN status ELSE 'failed' END,
         failure_code = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      retryable ? 1 : 0,
      safeStripeFailureCode(error),
      attemptId
    )
    .run();
}

function safeStripeFailureCode(error: unknown): string {
  if (!(error instanceof StripeApiError)) return "invalid_provider_response";
  return String(
    error.code || error.type || "stripe_api_error"
  ).replace(/[^a-z0-9_]/gi, "_").slice(0, 80);
}

function expectedStripeMode(env: PodcastEnv): "test" | "live" {
  return String(env.STRIPE_MODE) === "live" ? "live" : "test";
}

function rateLimitedResponse(
  request: Request,
  env: PodcastEnv,
  retryAfter: number
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rate_limited" },
    {
      status: 429,
      headers: { "retry-after": String(retryAfter) }
    }
  );
}
