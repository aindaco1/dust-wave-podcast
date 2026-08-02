import launchLabFixture from "../config/launch-lab-fixture.json";

import type { PodcastEnv } from "./env";
import { recordLaunchLabObservations } from "./launch-lab-ledger";
import { createPodcastStripeClient } from "./stripe-client";

const FIXTURE_CONFIG_ID = "subscription_monthly_v1";
const FIXTURE_PRICE_ID = "price_dust_wave_launch_lab_monthly_v1";
const FIXTURE_LOOKUP_KEY = "dust_wave_launch_lab_monthly_v1";
const FIXTURE_AMOUNT_CENTS = 100;
const PROVIDER_METADATA = {
  platform: "dust_wave_podcast",
  launch_lab_fixture: FIXTURE_CONFIG_ID
} as const;

type LifecyclePhase =
  | "new"
  | "product_ready"
  | "price_ready"
  | "clock_ready"
  | "customer_ready"
  | "subscription_created"
  | "initial_active"
  | "renewal_advancing"
  | "renewed"
  | "failure_payment_method_ready"
  | "failure_payment_method_set"
  | "failure_advancing"
  | "failed_payment"
  | "recovery_payment_method_ready"
  | "recovery_payment_method_set"
  | "recovery_invoice_ready"
  | "recovery_payment_requested"
  | "recovered"
  | "cancellation_requested"
  | "canceled"
  | "clock_deleted"
  | "complete";

type LifecycleRow = {
  run_id: string;
  phase: LifecyclePhase;
  checkout_attempt_id: string;
  provider_clock_id: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  provider_failure_payment_method_id: string | null;
  provider_recovery_payment_method_id: string | null;
  provider_recovery_invoice_id: string | null;
  initial_period_end: number | null;
  renewal_period_end: number | null;
  transition_count: number;
};

type FixtureConfigRow = {
  provider_product_id: string | null;
  provider_price_id: string | null;
};

type SourceRow = {
  listener_id: string;
  status: string;
  current_period_end: string | null;
};

type StripeObject = Record<string, unknown> & {
  id?: string;
  livemode?: boolean;
  active?: boolean;
  status?: string;
  customer?: string;
  product?: string;
  currency?: string;
  unit_amount?: number;
  lookup_key?: string;
  tax_behavior?: string;
  test_clock?: string;
  latest_invoice?: unknown;
  metadata?: Record<string, unknown>;
  recurring?: Record<string, unknown>;
  invoice_settings?: Record<string, unknown>;
  items?: Record<string, unknown>;
};

export type LaunchLabStripeLifecycleResult = {
  schemaVersion: "dust-wave-launch-lab-stripe-lifecycle-v1";
  phase: LifecyclePhase;
  complete: boolean;
  pendingProviderEvidence: boolean;
};

export async function advanceLaunchLabStripeLifecycle(
  env: PodcastEnv,
  runId: string
): Promise<LaunchLabStripeLifecycleResult> {
  if (
    env.ENVIRONMENT !== "staging"
    || String(env.STRIPE_MODE) !== "test"
    || !env.STRIPE_SECRET_KEY
  ) {
    throw new Error("launch_lab_stripe_lifecycle_not_available");
  }
  await ensureExactRun(env.DB, runId);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO launch_lab_stripe_lifecycles (
       run_id, checkout_attempt_id
     ) VALUES (?, ?)`
  ).bind(runId, checkoutAttemptId(runId)).run();
  let lifecycle = await loadLifecycle(env.DB, runId);
  if (!lifecycle) throw new Error("launch_lab_stripe_lifecycle_missing");

  try {
    lifecycle = await advanceOnePhase(env, lifecycle);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE launch_lab_stripe_lifecycles
       SET last_error_code = ?, updated_at = datetime('now')
       WHERE run_id = ?`
    ).bind(safeErrorCode(error), runId).run();
    throw error;
  }
  return presentLifecycle(lifecycle);
}

async function advanceOnePhase(
  env: PodcastEnv,
  lifecycle: LifecycleRow
): Promise<LifecycleRow> {
  const stripe = createPodcastStripeClient(env);
  const config = await loadFixtureConfig(env.DB);

  if (lifecycle.phase === "new") {
    let product: StripeObject;
    if (config.provider_product_id) {
      product = await stripe.products.retrieve(
        providerId(config.provider_product_id, "prod")
      );
    } else {
      product = await stripe.products.create({
        name: "Dust Wave Launch Lab Subscription",
        active: true,
        metadata: PROVIDER_METADATA
      }, { idempotencyKey: "podcast-launch-lab-product-v1" });
      await env.DB.prepare(
        `UPDATE launch_lab_stripe_fixture_config
         SET provider_product_id = ?, updated_at = datetime('now')
         WHERE id = ? AND provider_product_id IS NULL`
      ).bind(providerId(product.id, "prod"), FIXTURE_CONFIG_ID).run();
    }
    assertFixtureProduct(product);
    return transition(env.DB, lifecycle, "product_ready");
  }

  const productId = providerId(config.provider_product_id, "prod");
  if (lifecycle.phase === "product_ready") {
    let price: StripeObject;
    if (config.provider_price_id) {
      price = await stripe.prices.retrieve(
        providerId(config.provider_price_id, "price")
      );
    } else {
      price = await stripe.prices.create({
        product: productId,
        active: true,
        currency: "usd",
        unit_amount: FIXTURE_AMOUNT_CENTS,
        tax_behavior: "exclusive",
        lookup_key: FIXTURE_LOOKUP_KEY,
        recurring: { interval: "month", interval_count: 1 },
        metadata: PROVIDER_METADATA
      }, { idempotencyKey: "podcast-launch-lab-price-v1" });
      await env.DB.prepare(
        `UPDATE launch_lab_stripe_fixture_config
         SET provider_price_id = ?, updated_at = datetime('now')
         WHERE id = ? AND provider_price_id IS NULL`
      ).bind(providerId(price.id, "price"), FIXTURE_CONFIG_ID).run();
    }
    assertFixturePrice(price, productId);
    await ensureLocalFixturePrice(
      env.DB,
      providerId(price.id, "price")
    );
    return transition(env.DB, lifecycle, "price_ready");
  }

  const priceId = providerId(config.provider_price_id, "price");
  if (lifecycle.phase === "price_ready") {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1_000),
      name: `Dust Wave Launch Lab ${lifecycle.run_id.slice(-12)}`
    }, { idempotencyKey: `${lifecycle.run_id}:clock` });
    assertTestClock(clock, "ready");
    return transition(env.DB, lifecycle, "clock_ready", {
      provider_clock_id: providerId(clock.id, "clock")
    });
  }

  const clockId = providerId(lifecycle.provider_clock_id, "clock");
  if (lifecycle.phase === "clock_ready") {
    const customer = await stripe.customers.create({
      test_clock: clockId,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
      metadata: {
        ...PROVIDER_METADATA,
        launch_lab_run_id: lifecycle.run_id
      }
    }, { idempotencyKey: `${lifecycle.run_id}:customer` });
    assertTestCustomer(customer, clockId);
    return transition(env.DB, lifecycle, "customer_ready", {
      provider_customer_id: providerId(customer.id, "cus")
    });
  }

  const customerId = providerId(lifecycle.provider_customer_id, "cus");
  if (lifecycle.phase === "customer_ready") {
    await ensureCheckoutAttempt(env.DB, lifecycle, customerId);
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "error_if_incomplete",
      metadata: {
        dustwave_checkout_attempt_id: lifecycle.checkout_attempt_id,
        dustwave_show_id: launchLabFixture.show.id,
        dustwave_price_id: FIXTURE_PRICE_ID,
        ...PROVIDER_METADATA
      }
    }, { idempotencyKey: `${lifecycle.run_id}:subscription` });
    assertTestSubscription(subscription, customerId);
    return transition(env.DB, lifecycle, "subscription_created", {
      provider_subscription_id: providerId(subscription.id, "sub"),
      initial_period_end: subscriptionPeriodEnd(subscription)
    });
  }

  const subscriptionId = providerId(
    lifecycle.provider_subscription_id,
    "sub"
  );
  if (lifecycle.phase === "subscription_created") {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadSource(env.DB, subscriptionId);
    if (
      subscription.status !== "active"
      || source?.status !== "active"
      || sourcePeriodEnd(source) !== subscriptionPeriodEnd(subscription)
    ) return lifecycle;
    return transition(env.DB, lifecycle, "initial_active", {
      initial_period_end: subscriptionPeriodEnd(subscription)
    });
  }

  if (lifecycle.phase === "initial_active") {
    const periodEnd = requiredPeriodEnd(lifecycle.initial_period_end);
    const clock = await stripe.testHelpers.testClocks.advance(clockId, {
      frozen_time: periodEnd + 3_600
    }, { idempotencyKey: `${lifecycle.run_id}:renewal-advance` });
    assertTestClock(clock, "advancing");
    return transition(env.DB, lifecycle, "renewal_advancing");
  }

  if (lifecycle.phase === "renewal_advancing") {
    if (!await testClockReady(stripe, clockId)) return lifecycle;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadSource(env.DB, subscriptionId);
    const renewedPeriodEnd = subscriptionPeriodEnd(subscription);
    if (
      subscription.status !== "active"
      || source?.status !== "active"
      || sourcePeriodEnd(source) !== renewedPeriodEnd
      || renewedPeriodEnd <= requiredPeriodEnd(lifecycle.initial_period_end)
    ) return lifecycle;
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "renewal",
      observedStatus: "active"
    }]);
    return transition(env.DB, lifecycle, "renewed", {
      renewal_period_end: renewedPeriodEnd
    });
  }

  if (lifecycle.phase === "renewed") {
    const paymentMethod = await stripe.paymentMethods.attach(
      "pm_card_chargeCustomerFail",
      { customer: customerId },
      { idempotencyKey: `${lifecycle.run_id}:failure-payment-method` }
    );
    return transition(
      env.DB,
      lifecycle,
      "failure_payment_method_ready",
      {
        provider_failure_payment_method_id: providerId(
          paymentMethod.id,
          "pm"
        )
      }
    );
  }

  if (lifecycle.phase === "failure_payment_method_ready") {
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: providerId(
        lifecycle.provider_failure_payment_method_id,
        "pm"
      )
    }, { idempotencyKey: `${lifecycle.run_id}:set-failure-method` });
    return transition(
      env.DB,
      lifecycle,
      "failure_payment_method_set"
    );
  }

  if (lifecycle.phase === "failure_payment_method_set") {
    const periodEnd = requiredPeriodEnd(lifecycle.renewal_period_end);
    const clock = await stripe.testHelpers.testClocks.advance(clockId, {
      frozen_time: periodEnd + 3_600
    }, { idempotencyKey: `${lifecycle.run_id}:failure-advance` });
    assertTestClock(clock, "advancing");
    return transition(env.DB, lifecycle, "failure_advancing");
  }

  if (lifecycle.phase === "failure_advancing") {
    if (!await testClockReady(stripe, clockId)) return lifecycle;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadSource(env.DB, subscriptionId);
    const invoiceId = nestedId(subscription.latest_invoice, "in");
    if (
      subscription.status !== "past_due"
      || source?.status !== "past_due"
      || !invoiceId
    ) return lifecycle;
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "payment_failure",
      observedStatus: "past_due"
    }]);
    return transition(env.DB, lifecycle, "failed_payment", {
      provider_recovery_invoice_id: invoiceId
    });
  }

  if (lifecycle.phase === "failed_payment") {
    const paymentMethod = await stripe.paymentMethods.attach(
      "pm_card_visa",
      { customer: customerId },
      { idempotencyKey: `${lifecycle.run_id}:recovery-payment-method` }
    );
    return transition(
      env.DB,
      lifecycle,
      "recovery_payment_method_ready",
      {
        provider_recovery_payment_method_id: providerId(
          paymentMethod.id,
          "pm"
        )
      }
    );
  }

  if (lifecycle.phase === "recovery_payment_method_ready") {
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: providerId(
        lifecycle.provider_recovery_payment_method_id,
        "pm"
      )
    }, { idempotencyKey: `${lifecycle.run_id}:set-recovery-method` });
    return transition(
      env.DB,
      lifecycle,
      "recovery_payment_method_set"
    );
  }

  if (lifecycle.phase === "recovery_payment_method_set") {
    const invoiceId = providerId(
      lifecycle.provider_recovery_invoice_id,
      "in"
    );
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status !== "open") return lifecycle;
    return transition(env.DB, lifecycle, "recovery_invoice_ready");
  }

  if (lifecycle.phase === "recovery_invoice_ready") {
    await stripe.invoices.pay(
      providerId(lifecycle.provider_recovery_invoice_id, "in"),
      {
        payment_method: providerId(
          lifecycle.provider_recovery_payment_method_id,
          "pm"
        )
      },
      { idempotencyKey: `${lifecycle.run_id}:recovery-payment` }
    );
    return transition(
      env.DB,
      lifecycle,
      "recovery_payment_requested"
    );
  }

  if (lifecycle.phase === "recovery_payment_requested") {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadSource(env.DB, subscriptionId);
    if (subscription.status !== "active" || source?.status !== "active") {
      return lifecycle;
    }
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "payment_recovery",
      observedStatus: "active"
    }]);
    return transition(env.DB, lifecycle, "recovered");
  }

  if (lifecycle.phase === "recovered") {
    const subscription = await stripe.subscriptions.cancel(subscriptionId);
    if (subscription.status !== "canceled") {
      throw new Error("launch_lab_subscription_not_canceled");
    }
    return transition(env.DB, lifecycle, "cancellation_requested");
  }

  if (lifecycle.phase === "cancellation_requested") {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const source = await loadSource(env.DB, subscriptionId);
    if (subscription.status !== "canceled" || source?.status !== "canceled") {
      return lifecycle;
    }
    await recordLaunchLabObservations(env.DB, lifecycle.run_id, [{
      provider: "stripe",
      scenario: "cancellation",
      observedStatus: "canceled"
    }]);
    return transition(env.DB, lifecycle, "canceled");
  }

  if (lifecycle.phase === "canceled") {
    const clock = await stripe.testHelpers.testClocks.delete(clockId);
    if (clock.deleted !== true) {
      throw new Error("launch_lab_test_clock_not_deleted");
    }
    return transition(env.DB, lifecycle, "clock_deleted");
  }

  if (lifecycle.phase === "clock_deleted") {
    await cleanupLocalLifecycle(env.DB, lifecycle);
    return transition(env.DB, lifecycle, "complete", {
      completed_at: new Date().toISOString()
    });
  }

  return lifecycle;
}

async function ensureExactRun(db: D1Database, runId: string): Promise<void> {
  const run = await db.prepare(
    `SELECT run.id
     FROM launch_lab_runs run
     JOIN shows show_record ON show_record.id = run.show_id
     WHERE run.id = ? AND show_record.id = ? AND show_record.test_fixture = 1`
  ).bind(runId, launchLabFixture.show.id).first<{ id: string }>();
  if (!run) throw new Error("launch_lab_stripe_run_not_found");
}

async function ensureLocalFixturePrice(
  db: D1Database,
  providerPriceId: string
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO show_prices (
       id, show_id, billing_period, amount_cents, currency,
       stripe_price_id, stripe_lookup_key, tax_behavior, provider_mode, active
     ) VALUES (?, ?, 'month', ?, 'USD', ?, ?, 'exclusive', 'test', 0)`
  ).bind(
    FIXTURE_PRICE_ID,
    launchLabFixture.show.id,
    FIXTURE_AMOUNT_CENTS,
    providerPriceId,
    FIXTURE_LOOKUP_KEY
  ).run();
  const row = await db.prepare(
    `SELECT id, amount_cents, currency, stripe_price_id, stripe_lookup_key,
            tax_behavior, provider_mode, active
     FROM show_prices
     WHERE show_id = ? AND billing_period = 'month'`
  ).bind(launchLabFixture.show.id).first<Record<string, unknown>>();
  if (
    row?.id !== FIXTURE_PRICE_ID
    || row.amount_cents !== FIXTURE_AMOUNT_CENTS
    || row.currency !== "USD"
    || row.stripe_price_id !== providerPriceId
    || row.stripe_lookup_key !== FIXTURE_LOOKUP_KEY
    || row.tax_behavior !== "exclusive"
    || row.provider_mode !== "test"
    || row.active !== 0
  ) throw new Error("launch_lab_local_price_mismatch");
}

async function ensureCheckoutAttempt(
  db: D1Database,
  lifecycle: LifecycleRow,
  customerId: string
): Promise<void> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`launch-lab-stripe:${lifecycle.run_id}`)
  );
  const lookupHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await db.prepare(
    `INSERT OR IGNORE INTO subscription_checkout_attempts (
       id, show_id, price_id, status, idempotency_key, email_lookup_hash,
       provider_customer_id, provider_mode
     ) VALUES (?, ?, ?, 'created', ?, ?, ?, 'test')`
  ).bind(
    lifecycle.checkout_attempt_id,
    launchLabFixture.show.id,
    FIXTURE_PRICE_ID,
    `${lifecycle.run_id}:checkout-attempt`,
    lookupHash,
    customerId
  ).run();
  const attempt = await db.prepare(
    `SELECT show_id, price_id, status, email_lookup_hash,
            provider_customer_id, provider_mode
     FROM subscription_checkout_attempts
     WHERE id = ?`
  ).bind(lifecycle.checkout_attempt_id).first<Record<string, unknown>>();
  if (
    attempt?.show_id !== launchLabFixture.show.id
    || attempt.price_id !== FIXTURE_PRICE_ID
    || attempt.status !== "created"
    || attempt.email_lookup_hash !== lookupHash
    || attempt.provider_customer_id !== customerId
    || attempt.provider_mode !== "test"
  ) throw new Error("launch_lab_checkout_attempt_mismatch");
}

async function cleanupLocalLifecycle(
  db: D1Database,
  lifecycle: LifecycleRow
): Promise<void> {
  const source = await loadSource(
    db,
    providerId(lifecycle.provider_subscription_id, "sub")
  );
  if (source) {
    await db.batch([
      db.prepare(
        `DELETE FROM subscriptions WHERE listener_id = ? AND show_id = ?`
      ).bind(source.listener_id, launchLabFixture.show.id),
      db.prepare(
        `DELETE FROM subscription_entitlement_sources
         WHERE listener_id = ? AND show_id = ? AND provider = 'stripe'
           AND provider_subscription_id = ?`
      ).bind(
        source.listener_id,
        launchLabFixture.show.id,
        lifecycle.provider_subscription_id
      ),
      db.prepare(
        `DELETE FROM subscription_checkout_attempts WHERE id = ?`
      ).bind(lifecycle.checkout_attempt_id),
      db.prepare(
        `DELETE FROM listener_accounts
         WHERE id = ? AND email_ciphertext = 'not_retained:stripe:v1'
           AND NOT EXISTS (
             SELECT 1 FROM subscription_entitlement_sources WHERE listener_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM subscriptions WHERE listener_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM subscription_checkout_attempts WHERE listener_id = ?
           )`
      ).bind(
        source.listener_id,
        source.listener_id,
        source.listener_id,
        source.listener_id
      )
    ]);
  } else {
    await db.prepare(
      `DELETE FROM subscription_checkout_attempts WHERE id = ?`
    ).bind(lifecycle.checkout_attempt_id).run();
  }
}

async function loadLifecycle(
  db: D1Database,
  runId: string
): Promise<LifecycleRow | null> {
  return db.prepare(
    `SELECT run_id, phase, checkout_attempt_id, provider_clock_id,
            provider_customer_id, provider_subscription_id,
            provider_failure_payment_method_id,
            provider_recovery_payment_method_id,
            provider_recovery_invoice_id, initial_period_end,
            renewal_period_end, transition_count
     FROM launch_lab_stripe_lifecycles
     WHERE run_id = ?`
  ).bind(runId).first<LifecycleRow>();
}

async function loadFixtureConfig(
  db: D1Database
): Promise<FixtureConfigRow> {
  const config = await db.prepare(
    `SELECT provider_product_id, provider_price_id
     FROM launch_lab_stripe_fixture_config WHERE id = ?`
  ).bind(FIXTURE_CONFIG_ID).first<FixtureConfigRow>();
  if (!config) throw new Error("launch_lab_stripe_fixture_config_missing");
  return config;
}

async function loadSource(
  db: D1Database,
  subscriptionId: string
): Promise<SourceRow | null> {
  return db.prepare(
    `SELECT listener_id, status, current_period_end
     FROM subscription_entitlement_sources
     WHERE provider = 'stripe' AND provider_subscription_id = ?`
  ).bind(subscriptionId).first<SourceRow>();
}

async function transition(
  db: D1Database,
  lifecycle: LifecycleRow,
  phase: LifecyclePhase,
  values: Partial<LifecycleRow> & { completed_at?: string } = {}
): Promise<LifecycleRow> {
  const allowed = new Set([
    "provider_clock_id",
    "provider_customer_id",
    "provider_subscription_id",
    "provider_failure_payment_method_id",
    "provider_recovery_payment_method_id",
    "provider_recovery_invoice_id",
    "initial_period_end",
    "renewal_period_end",
    "completed_at"
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  const assignments = entries.map(([key]) => `${key} = ?`);
  const result = await db.prepare(
    `UPDATE launch_lab_stripe_lifecycles
     SET phase = ?, ${assignments.join(", ")}${assignments.length ? "," : ""}
         transition_count = transition_count + 1,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE run_id = ? AND phase = ? AND transition_count < 40`
  ).bind(
    phase,
    ...entries.map(([, value]) => value),
    lifecycle.run_id,
    lifecycle.phase
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error("launch_lab_stripe_transition_conflict");
  }
  const next = await loadLifecycle(db, lifecycle.run_id);
  if (!next || next.phase !== phase) {
    throw new Error("launch_lab_stripe_transition_failed");
  }
  return next;
}

async function testClockReady(
  stripe: ReturnType<typeof createPodcastStripeClient>,
  clockId: string
): Promise<boolean> {
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  assertTestClock(clock, String(clock.status));
  return clock.status === "ready";
}

function assertFixtureProduct(product: StripeObject): void {
  if (
    product.livemode !== false
    || product.active !== true
    || product.metadata?.platform !== PROVIDER_METADATA.platform
    || product.metadata?.launch_lab_fixture
      !== PROVIDER_METADATA.launch_lab_fixture
  ) throw new Error("launch_lab_stripe_product_mismatch");
}

function assertFixturePrice(price: StripeObject, productId: string): void {
  if (
    price.livemode !== false
    || price.active !== true
    || price.product !== productId
    || price.currency !== "usd"
    || price.unit_amount !== FIXTURE_AMOUNT_CENTS
    || price.tax_behavior !== "exclusive"
    || price.lookup_key !== FIXTURE_LOOKUP_KEY
    || price.recurring?.interval !== "month"
    || price.recurring?.interval_count !== 1
    || price.metadata?.platform !== PROVIDER_METADATA.platform
    || price.metadata?.launch_lab_fixture
      !== PROVIDER_METADATA.launch_lab_fixture
  ) throw new Error("launch_lab_stripe_price_mismatch");
}

function assertTestClock(clock: StripeObject, status: string): void {
  if (
    clock.livemode !== false
    || !["ready", "advancing"].includes(status)
    || clock.status !== status
  ) throw new Error("launch_lab_test_clock_mismatch");
}

function assertTestCustomer(customer: StripeObject, clockId: string): void {
  if (
    customer.livemode !== false
    || nestedId(customer.test_clock, "clock") !== clockId
    || customer.metadata?.platform !== PROVIDER_METADATA.platform
  ) throw new Error("launch_lab_test_customer_mismatch");
}

function assertTestSubscription(
  subscription: StripeObject,
  customerId: string
): void {
  if (
    subscription.livemode !== false
    || subscription.customer !== customerId
    || subscription.status !== "active"
    || subscription.metadata?.launch_lab_fixture
      !== PROVIDER_METADATA.launch_lab_fixture
    || !subscriptionPeriodEnd(subscription)
  ) throw new Error("launch_lab_test_subscription_mismatch");
}

function subscriptionPeriodEnd(subscription: StripeObject): number {
  const legacy = positiveInteger(subscription.current_period_end);
  if (legacy) return legacy;
  const data = Array.isArray(subscription.items?.data)
    ? subscription.items.data
    : [];
  const periods = data.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = positiveInteger(
      (item as Record<string, unknown>).current_period_end
    );
    return value ? [value] : [];
  }).sort((left, right) => left - right);
  if (!periods[0]) throw new Error("launch_lab_subscription_period_missing");
  return periods[0];
}

function sourcePeriodEnd(source: SourceRow): number {
  const milliseconds = Date.parse(source.current_period_end ?? "");
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.floor(milliseconds / 1_000);
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
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

function providerId(value: unknown, prefix: string): string {
  const text = String(value ?? "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{6,128}$`).test(text)) {
    throw new Error(`launch_lab_invalid_${prefix}_id`);
  }
  return text;
}

function requiredPeriodEnd(value: number | null): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("launch_lab_subscription_period_missing");
  }
  return Number(value);
}

function checkoutAttemptId(runId: string): string {
  return `checkout_launch_lab_${runId}`.slice(0, 150);
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown_error";
  return value.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 80);
}

function presentLifecycle(
  lifecycle: LifecycleRow
): LaunchLabStripeLifecycleResult {
  return {
    schemaVersion: "dust-wave-launch-lab-stripe-lifecycle-v1",
    phase: lifecycle.phase,
    complete: lifecycle.phase === "complete",
    pendingProviderEvidence: [
      "subscription_created",
      "renewal_advancing",
      "failure_advancing",
      "recovery_payment_requested",
      "cancellation_requested"
    ].includes(lifecycle.phase)
  };
}
