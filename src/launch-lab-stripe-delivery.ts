import type { PodcastEnv } from "./env";
import { recordLaunchLabObservations } from "./launch-lab-ledger";
import { createPodcastStripeClient } from "./stripe-client";

const FIXTURE_SHOW_ID = "show_dust_wave_launch_lab";
const EVENT_CANDIDATE_LIMIT = 12;

type LifecycleRow = {
  run_id: string;
  phase: string;
  checkout_attempt_id: string;
  provider_subscription_id: string;
};

type SourceRow = {
  status: string;
  provider_event_id: string | null;
  provider_event_created_at: number | null;
};

type JournalRow = {
  event_id: string;
  event_type: string;
  provider_created_at: number;
};

type StripeEvent = Record<string, unknown> & {
  id?: string;
  type?: string;
  livemode?: boolean;
  created?: number;
  data?: { object?: Record<string, unknown> };
};

export async function reconcileLaunchLabStripeDeliveryOrder(
  env: PodcastEnv,
  runId: string
): Promise<boolean> {
  requireDeliveryBoundary(env);
  const lifecycle = await env.DB.prepare(
    `SELECT run_id, phase, checkout_attempt_id, provider_subscription_id
     FROM launch_lab_stripe_lifecycles
     WHERE run_id = ?`
  ).bind(runId).first<LifecycleRow>();
  if (
    !lifecycle
    || lifecycle.phase !== "recovered"
    || !validSubscriptionId(lifecycle.provider_subscription_id)
  ) {
    throw new Error("launch_lab_stripe_delivery_not_ready");
  }
  const states = await loadDeliveryScenarioStates(env.DB, runId);
  if (states.duplicate_webhook === "passed"
    && states.out_of_order_webhook === "passed") {
    return true;
  }
  const source = await env.DB.prepare(
    `SELECT status, provider_event_id, provider_event_created_at
     FROM subscription_entitlement_sources
     WHERE show_id = ? AND provider = 'stripe'
       AND provider_subscription_id = ?`
  ).bind(
    FIXTURE_SHOW_ID,
    lifecycle.provider_subscription_id
  ).first<SourceRow>();
  if (
    source?.status !== "active"
    || !validEventId(source.provider_event_id)
    || !positiveInteger(source.provider_event_created_at)
  ) {
    throw new Error("launch_lab_stripe_delivery_source_not_active");
  }
  const journal = await env.DB.prepare(
    `SELECT event_id, event_type, provider_created_at
     FROM stripe_event_journal
     WHERE subscription_id = ?
       AND event_type = 'customer.subscription.updated'
       AND status = 'processed'
     ORDER BY provider_created_at DESC, event_id DESC
     LIMIT ?`
  ).bind(
    lifecycle.provider_subscription_id,
    EVENT_CANDIDATE_LIMIT
  ).all<JournalRow>();
  const current = journal.results.find((row) =>
    row.event_id === source.provider_event_id
    && row.provider_created_at === source.provider_event_created_at
  );
  if (!current) throw new Error("launch_lab_stripe_current_event_missing");

  const stripe = createPodcastStripeClient(env);
  const currentEvent = await stripe.events.retrieve(current.event_id) as StripeEvent;
  assertFixtureEvent(currentEvent, lifecycle, "active", current);
  let olderPastDue: { row: JournalRow; event: StripeEvent } | null = null;
  for (const row of journal.results) {
    if (row.provider_created_at >= current.provider_created_at) continue;
    const event = await stripe.events.retrieve(row.event_id) as StripeEvent;
    if (fixtureEventStatus(event, lifecycle, row) === "past_due") {
      olderPastDue = { row, event };
      break;
    }
  }
  if (!olderPastDue) {
    throw new Error("launch_lab_stripe_past_due_event_missing");
  }

  if (states.duplicate_webhook !== "passed") {
    await retryExactEvent(
      stripe,
      currentEvent,
      current.event_id,
      String(env.STRIPE_WEBHOOK_ENDPOINT_ID),
      `${runId}:duplicate-webhook`
    );
  }
  if (states.out_of_order_webhook !== "passed") {
    await retryExactEvent(
      stripe,
      olderPastDue.event,
      olderPastDue.row.event_id,
      String(env.STRIPE_WEBHOOK_ENDPOINT_ID),
      `${runId}:out-of-order-webhook`
    );
  }
  return false;
}

export async function observeLaunchLabStripeReplay(
  env: PodcastEnv,
  event: StripeEvent
): Promise<void> {
  if (env.ENVIRONMENT !== "staging" || env.STRIPE_MODE !== "test") return;
  if (
    event.type !== "customer.subscription.updated"
    || event.livemode !== false
    || !validEventId(event.id)
    || !positiveInteger(event.created)
  ) return;
  const object = event.data?.object;
  const metadata = recordOrNull(object?.metadata);
  const attemptId = String(metadata?.dustwave_checkout_attempt_id ?? "");
  const subscriptionId = String(object?.id ?? "");
  if (
    !/^checkout_launch_lab_[A-Za-z0-9_-]{16,128}$/.test(attemptId)
    || !validSubscriptionId(subscriptionId)
  ) return;
  const lifecycle = await env.DB.prepare(
    `SELECT run_id, phase, checkout_attempt_id, provider_subscription_id
     FROM launch_lab_stripe_lifecycles
     WHERE checkout_attempt_id = ? AND provider_subscription_id = ?
       AND phase IN (
         'recovered', 'cancellation_requested', 'canceled', 'clock_deleted'
       )`
  ).bind(attemptId, subscriptionId).first<LifecycleRow>();
  if (!lifecycle) return;
  const source = await env.DB.prepare(
    `SELECT status, provider_event_id, provider_event_created_at
     FROM subscription_entitlement_sources
     WHERE show_id = ? AND provider = 'stripe'
       AND provider_subscription_id = ?`
  ).bind(FIXTURE_SHOW_ID, subscriptionId).first<SourceRow>();
  if (
    source?.status !== "active"
    || !positiveInteger(source.provider_event_created_at)
  ) return;
  const status = String(object?.status ?? "");
  if (
    status === "active"
    && event.id === source.provider_event_id
    && event.created === source.provider_event_created_at
  ) {
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "duplicate_webhook",
      observedStatus: "idempotent"
    }]);
    return;
  }
  if (
    status === "past_due"
    && Number(event.created) < Number(source.provider_event_created_at)
  ) {
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "out_of_order_webhook",
      observedStatus: "reconciled"
    }]);
  }
}

async function loadDeliveryScenarioStates(
  db: D1Database,
  runId: string
): Promise<Record<string, string>> {
  const rows = await db.prepare(
    `SELECT scenario, state
     FROM launch_lab_provider_scenarios
     WHERE run_id = ? AND provider = 'stripe'
       AND scenario IN ('duplicate_webhook', 'out_of_order_webhook')`
  ).bind(runId).all<{ scenario: string; state: string }>();
  return Object.fromEntries(rows.results.map((row) => [row.scenario, row.state]));
}

async function retryExactEvent(
  stripe: ReturnType<typeof createPodcastStripeClient>,
  expected: StripeEvent,
  eventId: string,
  endpointId: string,
  idempotencyKey: string
): Promise<void> {
  const retried = await stripe.events.retry(eventId, {
    webhook_endpoint: endpointId
  }, { idempotencyKey }) as StripeEvent;
  if (
    retried.id !== expected.id
    || retried.type !== expected.type
    || retried.livemode !== false
  ) {
    throw new Error("launch_lab_stripe_retry_mismatch");
  }
}

function assertFixtureEvent(
  event: StripeEvent,
  lifecycle: LifecycleRow,
  expectedStatus: string,
  journal: JournalRow
): void {
  if (fixtureEventStatus(event, lifecycle, journal) !== expectedStatus) {
    throw new Error("launch_lab_stripe_event_mismatch");
  }
}

function fixtureEventStatus(
  event: StripeEvent,
  lifecycle: LifecycleRow,
  journal: JournalRow
): string {
  const object = event.data?.object;
  const metadata = recordOrNull(object?.metadata);
  if (
    event.id !== journal.event_id
    || event.type !== journal.event_type
    || event.type !== "customer.subscription.updated"
    || event.livemode !== false
    || event.created !== journal.provider_created_at
    || object?.id !== lifecycle.provider_subscription_id
    || metadata?.dustwave_checkout_attempt_id !== lifecycle.checkout_attempt_id
  ) {
    throw new Error("launch_lab_stripe_event_mismatch");
  }
  return String(object?.status ?? "");
}

function requireDeliveryBoundary(env: PodcastEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.STRIPE_MODE !== "test"
    || !/^we_[A-Za-z0-9_]{6,128}$/.test(
      String(env.STRIPE_WEBHOOK_ENDPOINT_ID ?? "")
    )
  ) {
    throw new Error("launch_lab_stripe_delivery_not_available");
  }
}

function validSubscriptionId(value: unknown): value is string {
  return /^sub_[A-Za-z0-9_]{6,128}$/.test(String(value ?? ""));
}

function validEventId(value: unknown): value is string {
  return /^evt_[A-Za-z0-9_]{6,128}$/.test(String(value ?? ""));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
