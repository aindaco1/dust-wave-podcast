import { hmacSha256 } from "@dustwave/worker-core/crypto";
import launchLabFixture from "../config/launch-lab-fixture.json";

import type { PodcastEnv } from "./env";
import { recordLaunchLabObservations } from "./launch-lab-ledger";
import {
  cleanupLaunchLabStripeFixture,
  loadLaunchLabStripeSource
} from "./launch-lab-stripe-fixtures";
import { createPodcastStripeClient } from "./stripe-client";

const FIXTURE_CONFIG_ID = "subscription_monthly_v1";
const FIXTURE_PRICE_ID = "price_dust_wave_launch_lab_monthly_v1";
const FIXTURE_AMOUNT_CENTS = 100;
const FIXTURE_EMAIL = "launch-lab-checkout@example.com";
const FIXTURE_INTEGRATION_IDENTIFIER = "dustwave_podcast_launchlab";
const SESSION_TTL_SECONDS = 60 * 60;
const PROVIDER_METADATA = {
  platform: "dust_wave_podcast",
  launch_lab_fixture: "hosted_checkout_v1"
} as const;

type CheckoutPhase =
  | "new"
  | "customer_ready"
  | "attempt_ready"
  | "session_open"
  | "checkout_completed"
  | "cancellation_requested"
  | "canceled"
  | "customer_deleted"
  | "complete"
  | "aborted";

type CheckoutRow = {
  run_id: string;
  phase: CheckoutPhase;
  checkout_attempt_id: string;
  provider_customer_id: string | null;
  provider_session_id: string | null;
  provider_subscription_id: string | null;
  cleanup_requested: number;
  customer_deleted: number;
  transition_count: number;
};

type StripeObject = Record<string, unknown> & {
  id?: string;
  deleted?: boolean;
  livemode?: boolean;
  status?: string;
  mode?: string;
  payment_status?: string;
  customer?: unknown;
  subscription?: unknown;
  client_reference_id?: string;
  metadata?: Record<string, unknown>;
  url?: string | null;
  expires_at?: number;
};

export type LaunchLabHostedCheckoutResult = {
  schemaVersion: "dust-wave-launch-lab-hosted-checkout-v1";
  phase: CheckoutPhase;
  complete: boolean;
  requiresBrowser: boolean;
  cleanupRequested: boolean;
};

export async function advanceLaunchLabHostedCheckout(
  env: PodcastEnv,
  runId: string
): Promise<LaunchLabHostedCheckoutResult> {
  requireHostedCheckoutBoundary(env);
  await ensureExactRun(env.DB, runId);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO launch_lab_stripe_checkouts (
       run_id, checkout_attempt_id
     ) VALUES (?, ?)`
  ).bind(runId, checkoutAttemptId(runId)).run();
  let lifecycle = await loadCheckout(env.DB, runId);
  if (!lifecycle) throw new Error("launch_lab_hosted_checkout_missing");
  try {
    lifecycle = lifecycle.cleanup_requested === 1
      ? await advanceCleanup(env, lifecycle)
      : await advanceOnePhase(env, lifecycle);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE launch_lab_stripe_checkouts
       SET last_error_code = ?, updated_at = datetime('now')
       WHERE run_id = ?`
    ).bind(safeErrorCode(error), runId).run();
    throw error;
  }
  return present(lifecycle);
}

export async function requestLaunchLabHostedCheckoutCleanup(
  env: PodcastEnv,
  runId: string
): Promise<LaunchLabHostedCheckoutResult> {
  requireHostedCheckoutBoundary(env);
  await ensureExactRun(env.DB, runId);
  await env.DB.prepare(
    `UPDATE launch_lab_stripe_checkouts
     SET cleanup_requested = 1, updated_at = datetime('now')
     WHERE run_id = ? AND phase NOT IN ('complete', 'aborted')`
  ).bind(runId).run();
  const lifecycle = await loadCheckout(env.DB, runId);
  if (!lifecycle) throw new Error("launch_lab_hosted_checkout_missing");
  if (["complete", "aborted"].includes(lifecycle.phase)) {
    return present(lifecycle);
  }
  return advanceLaunchLabHostedCheckout(env, runId);
}

export async function getLatestLaunchLabHostedCheckoutUrl(
  env: PodcastEnv
): Promise<{ url: string; expiresAt: string | null } | null> {
  requireHostedCheckoutBoundary(env);
  const lifecycle = await env.DB.prepare(
    `SELECT run_id, phase, checkout_attempt_id, provider_customer_id,
            provider_session_id, provider_subscription_id,
            cleanup_requested, customer_deleted, transition_count
     FROM launch_lab_stripe_checkouts
     WHERE phase = 'session_open' AND cleanup_requested = 0
       AND provider_session_id IS NOT NULL
     ORDER BY started_at DESC, run_id DESC
     LIMIT 1`
  ).first<CheckoutRow>();
  if (!lifecycle?.provider_session_id) return null;
  const session = await createPodcastStripeClient(env).checkout.sessions
    .retrieve(providerId(lifecycle.provider_session_id, "cs")) as StripeObject;
  assertCheckoutSession(session, lifecycle, "open");
  return {
    url: validHostedUrl(session.url),
    expiresAt: positiveInteger(session.expires_at)
      ? new Date(Number(session.expires_at) * 1_000).toISOString()
      : null
  };
}

async function advanceOnePhase(
  env: PodcastEnv,
  lifecycle: CheckoutRow
): Promise<CheckoutRow> {
  const stripe = createPodcastStripeClient(env);

  if (lifecycle.phase === "new") {
    const customer = await stripe.customers.create({
      email: FIXTURE_EMAIL,
      metadata: {
        ...PROVIDER_METADATA,
        launch_lab_run_id: lifecycle.run_id
      }
    }, { idempotencyKey: `${lifecycle.run_id}:hosted-customer` }) as StripeObject;
    assertCustomer(customer, lifecycle.run_id);
    return transition(env.DB, lifecycle, "customer_ready", {
      provider_customer_id: providerId(customer.id, "cus")
    });
  }

  const customerId = providerId(lifecycle.provider_customer_id, "cus");
  if (lifecycle.phase === "customer_ready") {
    const priceId = await loadExactFixturePrice(env.DB);
    await ensureHostedCheckoutAttempt(env, lifecycle, customerId);
    const attempt = await loadAttempt(env.DB, lifecycle.checkout_attempt_id);
    if (!attempt || attempt.stripe_price_id !== priceId) {
      throw new Error("launch_lab_hosted_attempt_mismatch");
    }
    return transition(env.DB, lifecycle, "attempt_ready");
  }

  if (lifecycle.phase === "attempt_ready") {
    const priceId = await loadExactFixturePrice(env.DB);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      integration_identifier: FIXTURE_INTEGRATION_IDENTIFIER,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          dustwave_checkout_attempt_id: lifecycle.checkout_attempt_id,
          dustwave_show_id: launchLabFixture.show.id,
          dustwave_price_id: FIXTURE_PRICE_ID,
          ...PROVIDER_METADATA,
          launch_lab_run_id: lifecycle.run_id
        }
      },
      client_reference_id: lifecycle.checkout_attempt_id,
      metadata: {
        dustwave_checkout_attempt_id: lifecycle.checkout_attempt_id,
        dustwave_show_id: launchLabFixture.show.id,
        dustwave_price_id: FIXTURE_PRICE_ID,
        ...PROVIDER_METADATA,
        launch_lab_run_id: lifecycle.run_id
      },
      success_url: `${env.SITE_ORIGIN.replace(/\/$/, "")}/admin/podcasts/?checkout=launch-lab-success`,
      cancel_url: `${env.SITE_ORIGIN.replace(/\/$/, "")}/admin/podcasts/?checkout=launch-lab-canceled`,
      expires_at: Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS
    }, { idempotencyKey: `${lifecycle.run_id}:hosted-session` }) as StripeObject;
    assertCheckoutSession(session, lifecycle, "open", customerId);
    const sessionId = providerId(session.id, "cs");
    await env.DB.prepare(
      `UPDATE subscription_checkout_attempts
       SET stripe_session_id = ?, updated_at = datetime('now')
       WHERE id = ? AND provider_customer_id = ? AND status = 'created'`
    ).bind(sessionId, lifecycle.checkout_attempt_id, customerId).run();
    return transition(env.DB, lifecycle, "session_open", {
      provider_session_id: sessionId
    });
  }

  const sessionId = providerId(lifecycle.provider_session_id, "cs");
  if (lifecycle.phase === "session_open") {
    const session = await stripe.checkout.sessions.retrieve(sessionId) as StripeObject;
    if (session.status === "open") {
      assertCheckoutSession(session, lifecycle, "open", customerId);
      return lifecycle;
    }
    assertCheckoutSession(session, lifecycle, "complete", customerId);
    if (!["paid", "no_payment_required"].includes(String(session.payment_status))) {
      return lifecycle;
    }
    const subscriptionId = providerId(session.subscription, "sub");
    const attempt = await loadAttempt(env.DB, lifecycle.checkout_attempt_id);
    const source = await loadLaunchLabStripeSource(env.DB, subscriptionId);
    if (
      attempt?.status !== "completed"
      || attempt.stripe_session_id !== sessionId
      || !attempt.listener_id
      || source?.status !== "active"
    ) return lifecycle;
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "checkout_success",
      observedStatus: "active"
    }]);
    return transition(env.DB, lifecycle, "checkout_completed", {
      provider_subscription_id: subscriptionId
    });
  }

  const subscriptionId = providerId(
    lifecycle.provider_subscription_id,
    "sub"
  );
  if (lifecycle.phase === "checkout_completed") {
    const canceled = await stripe.subscriptions.cancel(subscriptionId);
    if (canceled.status !== "canceled") {
      throw new Error("launch_lab_hosted_subscription_not_canceled");
    }
    return transition(env.DB, lifecycle, "cancellation_requested");
  }

  if (lifecycle.phase === "cancellation_requested") {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadLaunchLabStripeSource(env.DB, subscriptionId);
    if (subscription.status !== "canceled" || source?.status !== "canceled") {
      return lifecycle;
    }
    return transition(env.DB, lifecycle, "canceled");
  }

  if (lifecycle.phase === "canceled") {
    const customer = await stripe.customers.delete(customerId) as StripeObject;
    if (customer.deleted !== true || customer.id !== customerId) {
      throw new Error("launch_lab_hosted_customer_not_deleted");
    }
    return transition(env.DB, lifecycle, "customer_deleted", {
      customer_deleted: 1
    });
  }

  if (lifecycle.phase === "customer_deleted") {
    await cleanupLaunchLabStripeFixture(env.DB, {
      attemptId: lifecycle.checkout_attempt_id,
      subscriptionId
    });
    return transition(env.DB, lifecycle, "complete", {
      completed_at: new Date().toISOString()
    });
  }

  return lifecycle;
}

async function advanceCleanup(
  env: PodcastEnv,
  lifecycle: CheckoutRow
): Promise<CheckoutRow> {
  if (["complete", "aborted"].includes(lifecycle.phase)) return lifecycle;
  const stripe = createPodcastStripeClient(env);
  let subscriptionId = lifecycle.provider_subscription_id;
  if (lifecycle.provider_session_id) {
    const sessionId = providerId(lifecycle.provider_session_id, "cs");
    const session = await stripe.checkout.sessions.retrieve(sessionId) as StripeObject;
    if (session.status === "open") {
      const expired = await stripe.checkout.sessions.expire(sessionId) as StripeObject;
      if (expired.status !== "expired") {
        throw new Error("launch_lab_hosted_session_not_expired");
      }
      return lifecycle;
    }
    const observedSubscriptionId = nestedId(session.subscription, "sub");
    if (!subscriptionId && observedSubscriptionId) {
      return persistSubscriptionId(env.DB, lifecycle, observedSubscriptionId);
    }
  }
  const customerId = nestedId(lifecycle.provider_customer_id, "cus");
  if (customerId && lifecycle.customer_deleted !== 1) {
    const customer = await stripe.customers.delete(customerId) as StripeObject;
    if (customer.deleted !== true || customer.id !== customerId) {
      throw new Error("launch_lab_hosted_customer_not_deleted");
    }
    return persistCustomerDeleted(env.DB, lifecycle);
  }
  await cleanupLaunchLabStripeFixture(env.DB, {
    attemptId: lifecycle.checkout_attempt_id,
    subscriptionId
  });
  return transition(env.DB, lifecycle, "aborted", {
    completed_at: new Date().toISOString()
  });
}

async function ensureHostedCheckoutAttempt(
  env: PodcastEnv,
  lifecycle: CheckoutRow,
  customerId: string
): Promise<void> {
  if (!env.LISTENER_EMAIL_LOOKUP_PEPPER || !env.TAX_QUOTE_HASH_SECRET) {
    throw new Error("launch_lab_hosted_hashing_not_configured");
  }
  const emailHash = await hmacSha256(
    FIXTURE_EMAIL,
    env.LISTENER_EMAIL_LOOKUP_PEPPER,
    "hex"
  );
  const destinationHash = await hmacSha256(
    `launch-lab-hosted:no-tax:${lifecycle.run_id}`,
    env.TAX_QUOTE_HASH_SECRET,
    "hex"
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscription_checkout_attempts (
       id, show_id, price_id, status, idempotency_key,
       email_lookup_hash, destination_hash, provider_customer_id,
       provider_mode, jurisdiction_code, tax_rate_parts_per_million,
       tax_behavior, subtotal_cents, tax_cents, total_cents,
       tax_provider_name, tax_source_reference,
       stripe_integration_identifier, expires_at
     ) VALUES (
       ?, ?, ?, 'created', ?, ?, ?, ?, 'test', 'TEST-NO-TAX', 0,
       'exclusive', ?, 0, ?, 'launch_lab', 'hosted_checkout_v1', ?,
       datetime('now', '+1 hour')
     )`
  ).bind(
    lifecycle.checkout_attempt_id,
    launchLabFixture.show.id,
    FIXTURE_PRICE_ID,
    `${lifecycle.run_id}:hosted-attempt`,
    emailHash,
    destinationHash,
    customerId,
    FIXTURE_AMOUNT_CENTS,
    FIXTURE_AMOUNT_CENTS,
    FIXTURE_INTEGRATION_IDENTIFIER
  ).run();
  const attempt = await loadAttempt(env.DB, lifecycle.checkout_attempt_id);
  if (
    !attempt
    || attempt.status !== "created"
    || attempt.provider_customer_id !== customerId
    || attempt.provider_mode !== "test"
    || attempt.subtotal_cents !== FIXTURE_AMOUNT_CENTS
    || attempt.tax_cents !== 0
    || attempt.total_cents !== FIXTURE_AMOUNT_CENTS
  ) throw new Error("launch_lab_hosted_attempt_mismatch");
}

type AttemptRow = {
  status: string;
  provider_customer_id: string | null;
  provider_mode: string | null;
  stripe_session_id: string | null;
  listener_id: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  stripe_price_id: string;
};

async function loadAttempt(
  db: D1Database,
  attemptId: string
): Promise<AttemptRow | null> {
  return db.prepare(
    `SELECT a.status, a.provider_customer_id, a.provider_mode,
            a.stripe_session_id, a.listener_id, a.subtotal_cents,
            a.tax_cents, a.total_cents, p.stripe_price_id
     FROM subscription_checkout_attempts a
     JOIN show_prices p ON p.id = a.price_id
     WHERE a.id = ? AND a.show_id = ? AND a.price_id = ?`
  ).bind(
    attemptId,
    launchLabFixture.show.id,
    FIXTURE_PRICE_ID
  ).first<AttemptRow>();
}

async function loadExactFixturePrice(db: D1Database): Promise<string> {
  const row = await db.prepare(
    `SELECT c.provider_price_id, p.stripe_price_id, p.amount_cents,
            p.currency, p.provider_mode, p.active
     FROM launch_lab_stripe_fixture_config c
     JOIN show_prices p ON p.id = ? AND p.show_id = ?
     WHERE c.id = ?`
  ).bind(
    FIXTURE_PRICE_ID,
    launchLabFixture.show.id,
    FIXTURE_CONFIG_ID
  ).first<Record<string, unknown>>();
  const priceId = providerId(row?.provider_price_id, "price");
  if (
    row?.stripe_price_id !== priceId
    || row.amount_cents !== FIXTURE_AMOUNT_CENTS
    || row.currency !== "USD"
    || row.provider_mode !== "test"
    || row.active !== 0
  ) throw new Error("launch_lab_hosted_price_mismatch");
  return priceId;
}

async function ensureExactRun(db: D1Database, runId: string): Promise<void> {
  const run = await db.prepare(
    `SELECT run.id
     FROM launch_lab_runs run
     JOIN shows show_record ON show_record.id = run.show_id
     WHERE run.id = ? AND show_record.id = ? AND show_record.test_fixture = 1`
  ).bind(runId, launchLabFixture.show.id).first<{ id: string }>();
  if (!run) throw new Error("launch_lab_hosted_run_not_found");
}

async function loadCheckout(
  db: D1Database,
  runId: string
): Promise<CheckoutRow | null> {
  return db.prepare(
    `SELECT run_id, phase, checkout_attempt_id, provider_customer_id,
            provider_session_id, provider_subscription_id,
            cleanup_requested, customer_deleted, transition_count
     FROM launch_lab_stripe_checkouts WHERE run_id = ?`
  ).bind(runId).first<CheckoutRow>();
}

async function transition(
  db: D1Database,
  lifecycle: CheckoutRow,
  phase: CheckoutPhase,
  values: Partial<CheckoutRow> & { completed_at?: string } = {}
): Promise<CheckoutRow> {
  const allowed = new Set([
    "provider_customer_id",
    "provider_session_id",
    "provider_subscription_id",
    "customer_deleted",
    "completed_at"
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  const assignments = entries.map(([key]) => `${key} = ?`);
  const result = await db.prepare(
    `UPDATE launch_lab_stripe_checkouts
     SET phase = ?, ${assignments.join(", ")}${assignments.length ? "," : ""}
         transition_count = transition_count + 1,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE run_id = ? AND phase = ? AND transition_count = ?
       AND transition_count < 30`
  ).bind(
    phase,
    ...entries.map(([, value]) => value),
    lifecycle.run_id,
    lifecycle.phase,
    lifecycle.transition_count
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error("launch_lab_hosted_transition_conflict");
  }
  const next = await loadCheckout(db, lifecycle.run_id);
  if (!next || next.phase !== phase) {
    throw new Error("launch_lab_hosted_transition_failed");
  }
  return next;
}

async function persistSubscriptionId(
  db: D1Database,
  lifecycle: CheckoutRow,
  subscriptionId: string
): Promise<CheckoutRow> {
  await db.prepare(
    `UPDATE launch_lab_stripe_checkouts
     SET provider_subscription_id = ?, updated_at = datetime('now')
     WHERE run_id = ? AND provider_subscription_id IS NULL`
  ).bind(subscriptionId, lifecycle.run_id).run();
  const next = await loadCheckout(db, lifecycle.run_id);
  if (next?.provider_subscription_id !== subscriptionId) {
    throw new Error("launch_lab_hosted_subscription_persist_failed");
  }
  return next;
}

async function persistCustomerDeleted(
  db: D1Database,
  lifecycle: CheckoutRow
): Promise<CheckoutRow> {
  await db.prepare(
    `UPDATE launch_lab_stripe_checkouts
     SET customer_deleted = 1, updated_at = datetime('now')
     WHERE run_id = ? AND customer_deleted = 0`
  ).bind(lifecycle.run_id).run();
  const next = await loadCheckout(db, lifecycle.run_id);
  if (next?.customer_deleted !== 1) {
    throw new Error("launch_lab_hosted_customer_delete_persist_failed");
  }
  return next;
}

function assertCustomer(customer: StripeObject, runId: string): void {
  if (
    customer.livemode !== false
    || customer.metadata?.platform !== PROVIDER_METADATA.platform
    || customer.metadata?.launch_lab_fixture
      !== PROVIDER_METADATA.launch_lab_fixture
    || customer.metadata?.launch_lab_run_id !== runId
  ) throw new Error("launch_lab_hosted_customer_mismatch");
}

function assertCheckoutSession(
  session: StripeObject,
  lifecycle: CheckoutRow,
  status: "open" | "complete",
  customerId = providerId(lifecycle.provider_customer_id, "cus")
): void {
  if (
    session.livemode !== false
    || session.mode !== "subscription"
    || session.status !== status
    || nestedId(session.customer, "cus") !== customerId
    || session.client_reference_id !== lifecycle.checkout_attempt_id
    || session.metadata?.dustwave_checkout_attempt_id
      !== lifecycle.checkout_attempt_id
    || session.metadata?.dustwave_show_id !== launchLabFixture.show.id
    || session.metadata?.launch_lab_fixture
      !== PROVIDER_METADATA.launch_lab_fixture
    || session.metadata?.launch_lab_run_id !== lifecycle.run_id
  ) throw new Error("launch_lab_hosted_session_mismatch");
}

function requireHostedCheckoutBoundary(env: PodcastEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || String(env.STRIPE_MODE) !== "test"
    || !env.STRIPE_SECRET_KEY
  ) throw new Error("launch_lab_hosted_checkout_not_available");
}

function providerId(value: unknown, prefix: string): string {
  const text = String(value ?? "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{6,128}$`).test(text)) {
    throw new Error(`launch_lab_hosted_invalid_${prefix}_id`);
  }
  return text;
}

function nestedId(value: unknown, prefix: string): string | null {
  if (typeof value === "string") {
    try {
      return providerId(value, prefix);
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return nestedId((value as Record<string, unknown>).id, prefix);
  }
  return null;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function checkoutAttemptId(runId: string): string {
  return `checkout_launch_lab_hosted_${runId}`.slice(0, 150);
}

function validHostedUrl(value: unknown): string {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") {
    throw new Error("launch_lab_hosted_url_mismatch");
  }
  return url.toString();
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown_error";
  return value.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 80);
}

function present(lifecycle: CheckoutRow): LaunchLabHostedCheckoutResult {
  return {
    schemaVersion: "dust-wave-launch-lab-hosted-checkout-v1",
    phase: lifecycle.phase,
    complete: ["complete", "aborted"].includes(lifecycle.phase),
    requiresBrowser: lifecycle.phase === "session_open"
      && lifecycle.cleanup_requested === 0,
    cleanupRequested: lifecycle.cleanup_requested === 1
  };
}
