import { verifyStripeSignature } from "@dustwave/worker-core/stripe";

import { requireAdmin } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";

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
  const payload = await request.text();
  if (payload.length > 1_000_000) {
    return webhookResponse({ error: "payload_too_large" }, 413);
  }
  const verification = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature") ?? "",
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!verification.valid) {
    return webhookResponse({ error: "invalid_signature" }, 400);
  }
  const event = JSON.parse(payload) as StripeEvent;
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
    return webhookResponse({ received: true, duplicate: true });
  }

  try {
    const processed = await projectStripeEvent(env.DB, event.type, object);
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
    const message = error instanceof Error ? error.message : "event_projection_failed";
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
  const [shows, prices, approvedTaxes, failedEvents] = await Promise.all([
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
         AND t.effective_at <= datetime('now')
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
         AND s.billing_mode = ?`
    ).bind(expectedMode, expectedMode).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM stripe_event_journal
       WHERE status = 'failed'`
    ).first<{ count: number }>()
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    provider: "stripe",
    mode: expectedMode,
    configured: {
      apiKey: Boolean(env.STRIPE_SECRET_KEY),
      webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET)
    },
    checkoutEnabled: false,
    taxCollectionEnabled: (approvedTaxes?.count ?? 0) > 0,
    taxCalculationVersion: "@dustwave/tax-core@0.1.0",
    failedWebhookEvents: failedEvents?.count ?? 0,
    shows: shows.results,
    prices: prices.results
  });
}

async function projectStripeEvent(
  db: D1Database,
  type: string,
  object: Record<string, unknown>
): Promise<boolean> {
  if (type === "checkout.session.completed") {
    const sessionId = stringOrNull(object.id);
    if (!sessionId) return false;
    await db
      .prepare(
        `UPDATE subscription_checkout_attempts
         SET status = 'completed', updated_at = datetime('now')
         WHERE stripe_session_id = ?`
      )
      .bind(sessionId)
      .run();
    return true;
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const subscriptionId = stringOrNull(object.id);
    if (!subscriptionId) return false;
    const status = normalizeSubscriptionStatus(String(object.status ?? ""));
    const currentPeriodEnd = Number(object.current_period_end);
    await db
      .prepare(
        `UPDATE subscriptions
         SET
           status = ?,
           current_period_end = ?,
           canceled_at = CASE WHEN ? = 'canceled' THEN datetime('now') ELSE canceled_at END,
           updated_at = datetime('now')
         WHERE provider = 'stripe' AND provider_subscription_id = ?`
      )
      .bind(
        status,
        Number.isFinite(currentPeriodEnd)
          ? new Date(currentPeriodEnd * 1000).toISOString()
          : null,
        status,
        subscriptionId
      )
      .run();
    return true;
  }
  return false;
}

function normalizeSubscriptionStatus(value: string): string {
  if (["active", "trialing"].includes(value)) return "active";
  if (["past_due", "unpaid", "incomplete"].includes(value)) return "past_due";
  if (value === "paused") return "paused";
  if (["canceled", "incomplete_expired"].includes(value)) return "canceled";
  return "pending";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
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
