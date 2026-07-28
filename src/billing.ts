import {
  hmacSha256,
  normalizeEmail,
  randomToken,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";
import { verifyStripeSignature } from "@dustwave/worker-core/stripe";

import { requireAdmin } from "./admin-auth";
import { projectStripeTaxEvent } from "./billing-tax-evidence";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import { subscriptionCheckoutConfigured } from "./tax-quotes";
import {
  isTruthy,
  readBoundedText,
  RequestValidationError
} from "./validation";

type StripeEvent = {
  id?: string;
  type?: string;
  livemode?: boolean;
  created?: number;
  data?: { object?: Record<string, unknown> };
};

export async function handleStripeWebhook(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return webhookResponse({ error: "webhook_not_configured" }, 503);
  }
  let payload: string;
  try {
    payload = await readBoundedText(request, 1_000_000, "Webhook payload");
  } catch (error) {
    if (
      error instanceof RequestValidationError
      && error.code === "body_too_large"
    ) {
      return webhookResponse({ error: "payload_too_large" }, 413);
    }
    throw error;
  }
  const verification = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature") ?? "",
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!verification.valid) {
    return webhookResponse({ error: "invalid_signature" }, 400);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return webhookResponse({ error: "invalid_event" }, 400);
  }
  if (
    !event.id
    || !event.type
    || typeof event.livemode !== "boolean"
    || !Number.isSafeInteger(event.created)
    || !event.data?.object
  ) {
    return webhookResponse({ error: "invalid_event" }, 400);
  }
  const expectedLive = String(env.STRIPE_MODE) === "live";
  if (event.livemode !== expectedLive) {
    return webhookResponse({ error: "mode_mismatch" }, 400);
  }

  const object = event.data.object;
  const inserted = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO stripe_event_journal (
         event_id, event_type, livemode, provider_created_at,
         object_id, customer_id, subscription_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      event.id,
      event.type,
      event.livemode ? 1 : 0,
      event.created,
      stringOrNull(object.id),
      stringOrNull(object.customer),
      stringOrNull(object.subscription)
    )
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    const journal = await env.DB
      .prepare(
        `SELECT status
         FROM stripe_event_journal
         WHERE event_id = ?`
      )
      .bind(event.id)
      .first<{ status: string }>();
    if (journal?.status === "processed" || journal?.status === "ignored") {
      return webhookResponse({ received: true, duplicate: true });
    }
  }

  try {
    const processed = await projectStripeEvent(
      env,
      event.id,
      event.type,
      object
    );
    await env.DB
      .prepare(
        `UPDATE stripe_event_journal
         SET
           status = ?,
           processed_at = datetime('now')
         WHERE event_id = ?`
      )
      .bind(processed ? "processed" : "ignored", event.id)
      .run();
    return webhookResponse({ received: true });
  } catch (error) {
    const message = safeProjectionError(error);
    await env.DB
      .prepare(
        `UPDATE stripe_event_journal
         SET status = 'failed', last_error = ?
         WHERE event_id = ?`
      )
      .bind(message.slice(0, 500), event.id)
      .run();
    return webhookResponse({ error: "event_projection_failed" }, 500);
  }
}

export async function getBillingReadiness(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"]
  });
  if (!auth.ok) return auth.response;
  const expectedMode = String(env.STRIPE_MODE) === "live" ? "live" : "test";
  const [
    shows,
    prices,
    approvedTaxes,
    failedEvents,
    invoiceTaxEvidence,
    taxChangePreviews
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title, billing_mode, stripe_product_id
       FROM shows
       ORDER BY title`
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
         id, show_id, billing_period, amount_cents, currency,
         stripe_price_id, stripe_lookup_key, provider_mode, active
       FROM show_prices
       ORDER BY show_id, amount_cents`
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM show_tax_rate_assignments a
       JOIN tax_rate_versions t ON t.id = a.tax_rate_version_id
       JOIN shows s ON s.id = a.show_id
       WHERE
         t.status = 'approved'
         AND t.rate_parts_per_million IS NOT NULL
         AND t.provider_mode = ?
         AND t.stripe_tax_rate_id IS NOT NULL
         AND t.effective_at <= ${SQL_UTC_NOW_RFC3339}
         AND (
           t.expires_at IS NULL
           OR t.expires_at > ${SQL_UTC_NOW_RFC3339}
         )
         AND s.billing_mode = ?`
    ).bind(expectedMode, expectedMode).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM stripe_event_journal
       WHERE status = 'failed'`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN reconciliation_status = 'matched' THEN 1 ELSE 0 END)
           AS matched,
         SUM(CASE WHEN reconciliation_status != 'matched' THEN 1 ELSE 0 END)
           AS attention
       FROM subscription_invoice_tax_evidence`
    ).first<{ total: number; matched: number | null; attention: number | null }>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN preview_status = 'unchanged' THEN 1 ELSE 0 END)
           AS unchanged,
         SUM(CASE WHEN preview_status != 'unchanged' THEN 1 ELSE 0 END)
           AS attention
       FROM subscription_tax_change_previews`
    ).first<{
      total: number;
      unchanged: number | null;
      attention: number | null;
    }>()
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    provider: "stripe",
    mode: expectedMode,
    configured: {
      apiKey: Boolean(env.STRIPE_SECRET_KEY),
      webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
      listenerEmailHashing: Boolean(env.LISTENER_EMAIL_LOOKUP_PEPPER),
      checkoutRateLimitHashing: Boolean(env.TAX_QUOTE_HASH_SECRET),
      turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
      portalConfiguration: Boolean(env.STRIPE_PORTAL_CONFIGURATION_ID)
    },
    checkoutEnabled: subscriptionCheckoutConfigured(env),
    checkoutKillSwitch: isTruthy(env.SUBSCRIPTION_CHECKOUT_ENABLED),
    taxCollectionEnabled: (approvedTaxes?.count ?? 0) > 0,
    taxCalculationVersion: "@dustwave/tax-core@0.1.0",
    failedWebhookEvents: failedEvents?.count ?? 0,
    invoiceTaxEvidence: {
      total: invoiceTaxEvidence?.total ?? 0,
      matched: invoiceTaxEvidence?.matched ?? 0,
      attention: invoiceTaxEvidence?.attention ?? 0
    },
    taxChangePreviews: {
      total: taxChangePreviews?.total ?? 0,
      unchanged: taxChangePreviews?.unchanged ?? 0,
      attention: taxChangePreviews?.attention ?? 0
    },
    shows: shows.results,
    prices: prices.results
  });
}

async function projectStripeEvent(
  env: PodcastEnv,
  eventId: string,
  type: string,
  object: Record<string, unknown>
): Promise<boolean> {
  const db = env.DB;
  if (type === "checkout.session.completed") {
    const sessionId = stringOrNull(object.id);
    if (!sessionId) return false;
    const attemptId = checkoutAttemptId(object);
    const attempt = await findCheckoutAttempt(db, attemptId, sessionId);
    if (!attempt) throw new Error("checkout_attempt_not_found");
    verifyProviderCustomer(attempt.provider_customer_id, object.customer);
    await verifyCheckoutEmail(env, attempt.email_lookup_hash, object);
    const listenerId = await ensureListenerAccount(
      db,
      attempt.email_lookup_hash
    );
    const providerSubscriptionId = stringOrNull(object.subscription);
    if (providerSubscriptionId) {
      await upsertStripeSource(db, {
        listenerId,
        attempt,
        providerCustomerId: requiredString(object.customer, "customer"),
        providerSubscriptionId,
        status: ["paid", "no_payment_required"].includes(
          String(object.payment_status ?? "")
        ) ? "active" : "pending",
        currentPeriodEnd: null
      });
    }
    await db
      .prepare(
        `UPDATE subscription_checkout_attempts
         SET
           listener_id = ?,
           status = 'completed',
           failure_code = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND stripe_session_id = ?`
      )
      .bind(listenerId, attempt.id, sessionId)
      .run();
    return true;
  }
  if (type === "checkout.session.expired") {
    const sessionId = stringOrNull(object.id);
    if (!sessionId) return false;
    await db
      .prepare(
        `UPDATE subscription_checkout_attempts
         SET status = 'expired', updated_at = datetime('now')
         WHERE stripe_session_id = ? AND status = 'created'`
      )
      .bind(sessionId)
      .run();
    return true;
  }
  if ([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed"
  ].includes(type)) {
    const subscriptionId = stringOrNull(object.id);
    if (!subscriptionId) return false;
    const status = type === "customer.subscription.deleted"
      ? "canceled"
      : normalizeSubscriptionStatus(String(object.status ?? ""));
    const currentPeriodEnd = subscriptionPeriodEnd(object);
    const metadataAttemptId = metadataString(
      object,
      "dustwave_checkout_attempt_id"
    );
    const attempt = metadataAttemptId
      ? await findCheckoutAttempt(db, metadataAttemptId, null)
      : null;
    if (attempt) {
      verifyProviderCustomer(attempt.provider_customer_id, object.customer);
      const listenerId = await ensureListenerAccount(
        db,
        attempt.email_lookup_hash
      );
      await upsertStripeSource(db, {
        listenerId,
        attempt,
        providerCustomerId: requiredString(object.customer, "customer"),
        providerSubscriptionId: subscriptionId,
        status,
        currentPeriodEnd
      });
      await db
        .prepare(
          `UPDATE subscription_checkout_attempts
           SET listener_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(listenerId, attempt.id)
        .run();
      return true;
    }
    const source = await db
      .prepare(
        `SELECT listener_id, show_id
         FROM subscription_entitlement_sources
         WHERE
           provider = 'stripe'
           AND provider_subscription_id = ?`
      )
      .bind(subscriptionId)
      .first<{ listener_id: string; show_id: string }>();
    if (!source) return false;
    await db
      .prepare(
        `UPDATE subscription_entitlement_sources
         SET
           status = ?,
           current_period_end = ?,
           canceled_at = CASE
             WHEN ? = 'canceled' THEN datetime('now')
             ELSE canceled_at
           END,
           updated_at = datetime('now')
         WHERE
           provider = 'stripe'
           AND provider_subscription_id = ?`
      )
      .bind(status, currentPeriodEnd, status, subscriptionId)
      .run();
    await recomputeSubscriptionProjection(
      db,
      source.listener_id,
      source.show_id
    );
    return true;
  }
  return projectStripeTaxEvent(env, eventId, type, object);
}

type CheckoutProjectionRow = {
  id: string;
  show_id: string;
  price_id: string;
  email_lookup_hash: string;
  provider_customer_id: string | null;
};

type EntitlementStatus =
  | "pending"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired";

async function findCheckoutAttempt(
  db: D1Database,
  attemptId: string | null,
  sessionId: string | null
): Promise<CheckoutProjectionRow | null> {
  if (!attemptId && !sessionId) return null;
  return db
    .prepare(
      `SELECT
         id, show_id, price_id, email_lookup_hash, provider_customer_id
       FROM subscription_checkout_attempts
       WHERE
         (? IS NOT NULL AND id = ?)
         OR (? IS NOT NULL AND stripe_session_id = ?)
       LIMIT 1`
    )
    .bind(attemptId, attemptId, sessionId, sessionId)
    .first<CheckoutProjectionRow>();
}

async function verifyCheckoutEmail(
  env: PodcastEnv,
  expectedHash: string,
  object: Record<string, unknown>
): Promise<void> {
  if (!env.LISTENER_EMAIL_LOOKUP_PEPPER) {
    throw new Error("listener_email_hashing_not_configured");
  }
  const details = recordOrNull(object.customer_details);
  const email = normalizeEmail(
    details?.email ?? object.customer_email
  );
  if (!email) return;
  const actualHash = await hmacSha256(
    email,
    env.LISTENER_EMAIL_LOOKUP_PEPPER,
    "hex"
  );
  if (!timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("checkout_email_mismatch");
  }
}

async function ensureListenerAccount(
  db: D1Database,
  emailLookupHash: string
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(emailLookupHash)) {
    throw new Error("invalid_listener_email_hash");
  }
  const listenerId = `listener_${randomToken(16)}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO listener_accounts (
         id, email_lookup_hash, email_ciphertext
       ) VALUES (?, ?, 'not_retained:stripe:v1')`
    )
    .bind(listenerId, emailLookupHash)
    .run();
  const listener = await db
    .prepare(
      `SELECT id
       FROM listener_accounts
       WHERE email_lookup_hash = ?`
    )
    .bind(emailLookupHash)
    .first<{ id: string }>();
  if (!listener) throw new Error("listener_projection_failed");
  return listener.id;
}

async function upsertStripeSource(
  db: D1Database,
  input: {
    listenerId: string;
    attempt: CheckoutProjectionRow;
    providerCustomerId: string;
    providerSubscriptionId: string;
    status: EntitlementStatus;
    currentPeriodEnd: string | null;
  }
): Promise<void> {
  if (!/^cus_[A-Za-z0-9_]{6,128}$/.test(input.providerCustomerId)) {
    throw new Error("invalid_provider_customer");
  }
  if (!/^sub_[A-Za-z0-9_]{6,128}$/.test(input.providerSubscriptionId)) {
    throw new Error("invalid_provider_subscription");
  }
  await db
    .prepare(
      `INSERT INTO subscription_entitlement_sources (
         id, listener_id, show_id, price_id, provider,
         provider_customer_id, provider_subscription_id, status,
         current_period_end, canceled_at
       ) VALUES (
         ?, ?, ?, ?, 'stripe', ?, ?, ?, ?,
         CASE WHEN ? = 'canceled' THEN datetime('now') ELSE NULL END
       )
       ON CONFLICT (listener_id, show_id, provider)
       DO UPDATE SET
         price_id = excluded.price_id,
         provider_customer_id = excluded.provider_customer_id,
         provider_subscription_id = excluded.provider_subscription_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         canceled_at = CASE
           WHEN excluded.status = 'canceled' THEN datetime('now')
           ELSE NULL
         END,
         updated_at = datetime('now')`
    )
    .bind(
      `source_${randomToken(16)}`,
      input.listenerId,
      input.attempt.show_id,
      input.attempt.price_id,
      input.providerCustomerId,
      input.providerSubscriptionId,
      input.status,
      input.currentPeriodEnd,
      input.status
    )
    .run();
  await recomputeSubscriptionProjection(
    db,
    input.listenerId,
    input.attempt.show_id
  );
}

export async function recomputeSubscriptionProjection(
  db: D1Database,
  listenerId: string,
  showId: string
): Promise<void> {
  const sources = await db
    .prepare(
      `SELECT
         price_id, provider, provider_customer_id,
         provider_subscription_id, status, current_period_end
       FROM subscription_entitlement_sources
       WHERE listener_id = ? AND show_id = ?`
    )
    .bind(listenerId, showId)
    .all<{
      price_id: string | null;
      provider: "stripe" | "pool" | "manual";
      provider_customer_id: string | null;
      provider_subscription_id: string | null;
      status: EntitlementStatus;
      current_period_end: string | null;
    }>();
  if (sources.results.length === 0) return;
  const now = Date.now();
  const ordered = [...sources.results].sort((left, right) => {
    const leftRank = sourceRank(left, now);
    const rightRank = sourceRank(right, now);
    return leftRank - rightRank;
  });
  const selected = ordered[0];
  const active = selected.status === "active"
    && (
      selected.current_period_end === null
      || Date.parse(selected.current_period_end) > now
    );
  const aggregateStatus: EntitlementStatus = active
    ? "active"
    : selected.status === "active"
      ? "expired"
      : selected.status;
  await db
    .prepare(
      `INSERT INTO subscriptions (
         id, listener_id, show_id, price_id, provider,
         provider_customer_id, provider_subscription_id, status,
         current_period_end, canceled_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN ? = 'canceled' THEN datetime('now') ELSE NULL END
       )
       ON CONFLICT (listener_id, show_id)
       DO UPDATE SET
         price_id = excluded.price_id,
         provider = excluded.provider,
         provider_customer_id = excluded.provider_customer_id,
         provider_subscription_id = excluded.provider_subscription_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         canceled_at = CASE
           WHEN excluded.status = 'canceled' THEN datetime('now')
           ELSE NULL
         END,
         updated_at = datetime('now')`
    )
    .bind(
      `subscription_${randomToken(16)}`,
      listenerId,
      showId,
      selected.price_id,
      selected.provider,
      selected.provider_customer_id,
      selected.provider_subscription_id,
      aggregateStatus,
      selected.current_period_end,
      aggregateStatus
    )
    .run();
}

function sourceRank(
  source: {
    provider: "stripe" | "pool" | "manual";
    status: EntitlementStatus;
    current_period_end: string | null;
  },
  now: number
): number {
  const entitled = source.status === "active"
    && (
      source.current_period_end === null
      || Date.parse(source.current_period_end) > now
    );
  const statusRank: Record<EntitlementStatus, number> = {
    active: entitled ? 0 : 5,
    past_due: 2,
    paused: 3,
    pending: 4,
    canceled: 6,
    expired: 7
  };
  const providerRank = { stripe: 0, pool: 1, manual: 2 }[source.provider];
  return statusRank[source.status] * 10 + providerRank;
}

function checkoutAttemptId(object: Record<string, unknown>): string | null {
  return metadataString(object, "dustwave_checkout_attempt_id")
    || stringOrNull(object.client_reference_id);
}

function metadataString(
  object: Record<string, unknown>,
  key: string
): string | null {
  return stringOrNull(recordOrNull(object.metadata)?.[key]);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function verifyProviderCustomer(
  expected: string | null,
  actualValue: unknown
): void {
  const actual = stringOrNull(actualValue);
  if (!expected || !actual || !timingSafeEqual(expected, actual)) {
    throw new Error("provider_customer_mismatch");
  }
}

function requiredString(value: unknown, name: string): string {
  const result = stringOrNull(value);
  if (!result) throw new Error(`missing_${name}`);
  return result;
}

function subscriptionPeriodEnd(
  object: Record<string, unknown>
): string | null {
  const legacy = unixDateTime(object.current_period_end);
  if (legacy) return legacy;
  const items = recordOrNull(object.items);
  const data = Array.isArray(items?.data) ? items.data : [];
  const periods = data
    .map((item) =>
      unixDateTime(recordOrNull(item)?.current_period_end)
    )
    .filter((value): value is string => Boolean(value))
    .sort();
  return periods[0] ?? null;
}

function unixDateTime(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeSubscriptionStatus(value: string): EntitlementStatus {
  if (["active", "trialing"].includes(value)) return "active";
  if (["past_due", "unpaid", "incomplete"].includes(value)) return "past_due";
  if (value === "paused") return "paused";
  if (["canceled", "incomplete_expired"].includes(value)) return "canceled";
  return "pending";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function safeProjectionError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : "event_projection_failed";
  return /^[a-z0-9_]{1,120}$/i.test(message)
    ? message
    : "event_projection_failed";
}

function webhookResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
