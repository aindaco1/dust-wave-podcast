import type { PodcastEnv } from "./env";
import {
  createPodcastStripeClient,
  validStripeHostedUrl,
  validStripeId
} from "./stripe-client";

const FIXTURE_METADATA = {
  platform: "dust_wave_podcast",
  launch_lab_fixture: "billing_portal_v1"
} as const;

type PortalPhase =
  | "new"
  | "customer_ready"
  | "portal_verified"
  | "customer_deleted"
  | "complete"
  | "aborted";

type PortalRow = {
  run_id: string;
  phase: PortalPhase;
  provider_customer_id: string | null;
  portal_verified: number;
  customer_deleted: number;
  transition_count: number;
};

type StripeObject = Record<string, unknown> & {
  id?: string;
  object?: string;
  deleted?: boolean;
  livemode?: boolean;
  customer?: unknown;
  configuration?: unknown;
  return_url?: unknown;
  metadata?: Record<string, unknown>;
  url?: unknown;
};

export type LaunchLabStripePortalResult = {
  schemaVersion: "dust-wave-launch-lab-stripe-portal-v1";
  phase: PortalPhase;
  complete: boolean;
  portalVerified: boolean;
  customerDeleted: boolean;
};

export async function advanceLaunchLabStripePortal(
  env: PodcastEnv,
  runId: string
): Promise<LaunchLabStripePortalResult> {
  requirePortalBoundary(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO launch_lab_stripe_portal_rehearsals (run_id)
     VALUES (?)`
  ).bind(runId).run();
  let lifecycle = await loadPortal(env.DB, runId);
  if (!lifecycle) throw new Error("launch_lab_stripe_portal_missing");
  try {
    lifecycle = await advanceOnePhase(env, lifecycle);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE launch_lab_stripe_portal_rehearsals
       SET last_error_code = ?, updated_at = datetime('now')
       WHERE run_id = ?`
    ).bind(safeErrorCode(error), runId).run();
    throw error;
  }
  return present(lifecycle);
}

export async function cleanupLaunchLabStripePortal(
  env: PodcastEnv,
  runId: string
): Promise<LaunchLabStripePortalResult> {
  requirePortalBoundary(env);
  let lifecycle = await loadPortal(env.DB, runId);
  if (!lifecycle) {
    return {
      schemaVersion: "dust-wave-launch-lab-stripe-portal-v1",
      phase: "aborted",
      complete: true,
      portalVerified: false,
      customerDeleted: false
    };
  }
  if (["complete", "aborted"].includes(lifecycle.phase)) {
    return present(lifecycle);
  }
  let customerId = lifecycle.provider_customer_id
    ? validStripeId(lifecycle.provider_customer_id, "cus")
    : "";
  if (!customerId && lifecycle.phase === "new") {
    const customer = await createPodcastStripeClient(env).customers.create({
      metadata: {
        ...FIXTURE_METADATA,
        launch_lab_run_id: lifecycle.run_id
      }
    }, {
      idempotencyKey: `${lifecycle.run_id}:portal-customer`
    }) as StripeObject;
    assertCustomer(customer, lifecycle.run_id);
    customerId = validStripeId(customer.id, "cus");
  }
  if (customerId && lifecycle.customer_deleted !== 1) {
    const customer = await createPodcastStripeClient(env).customers.delete(
      customerId
    ) as StripeObject;
    assertDeletedCustomer(customer, customerId);
    lifecycle = await transition(env.DB, lifecycle, "aborted", {
      provider_customer_id: customerId,
      customer_deleted: 1,
      completed_at: new Date().toISOString()
    });
  } else {
    lifecycle = await transition(env.DB, lifecycle, "aborted", {
      completed_at: new Date().toISOString()
    });
  }
  return present(lifecycle);
}

async function advanceOnePhase(
  env: PodcastEnv,
  lifecycle: PortalRow
): Promise<PortalRow> {
  if (["complete", "aborted"].includes(lifecycle.phase)) return lifecycle;
  const stripe = createPodcastStripeClient(env);
  if (lifecycle.phase === "new") {
    const customer = await stripe.customers.create({
      metadata: {
        ...FIXTURE_METADATA,
        launch_lab_run_id: lifecycle.run_id
      }
    }, {
      idempotencyKey: `${lifecycle.run_id}:portal-customer`
    }) as StripeObject;
    assertCustomer(customer, lifecycle.run_id);
    return transition(env.DB, lifecycle, "customer_ready", {
      provider_customer_id: validStripeId(customer.id, "cus")
    });
  }

  const customerId = validStripeId(
    lifecycle.provider_customer_id,
    "cus"
  );
  if (lifecycle.phase === "customer_ready") {
    const customer = await stripe.customers.retrieve(customerId) as StripeObject;
    assertCustomer(customer, lifecycle.run_id);
    const configurationId = validStripeId(
      env.STRIPE_PORTAL_CONFIGURATION_ID,
      "bpc"
    );
    const returnUrl = `${env.SITE_ORIGIN.replace(/\/$/, "")}/podcasts/account/`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configurationId,
      return_url: returnUrl
    }, {
      idempotencyKey: `${lifecycle.run_id}:portal-session`
    }) as StripeObject;
    assertPortalSession(session, {
      customerId,
      configurationId,
      returnUrl
    });
    return transition(env.DB, lifecycle, "portal_verified", {
      portal_verified: 1
    });
  }

  if (lifecycle.phase === "portal_verified") {
    const customer = await stripe.customers.delete(customerId) as StripeObject;
    assertDeletedCustomer(customer, customerId);
    return transition(env.DB, lifecycle, "customer_deleted", {
      customer_deleted: 1
    });
  }

  if (lifecycle.phase === "customer_deleted") {
    return transition(env.DB, lifecycle, "complete", {
      completed_at: new Date().toISOString()
    });
  }
  return lifecycle;
}

function assertCustomer(customer: StripeObject, runId: string): void {
  if (
    customer.object !== "customer"
    || customer.deleted === true
    || customer.livemode !== false
    || customer.metadata?.platform !== FIXTURE_METADATA.platform
    || customer.metadata?.launch_lab_fixture
      !== FIXTURE_METADATA.launch_lab_fixture
    || customer.metadata?.launch_lab_run_id !== runId
  ) {
    throw new Error("launch_lab_stripe_portal_customer_mismatch");
  }
  validStripeId(customer.id, "cus");
}

function assertPortalSession(
  session: StripeObject,
  expected: {
    customerId: string;
    configurationId: string;
    returnUrl: string;
  }
): void {
  if (
    session.object !== "billing_portal.session"
    || session.livemode !== false
    || session.customer !== expected.customerId
    || session.configuration !== expected.configurationId
    || session.return_url !== expected.returnUrl
  ) {
    throw new Error("launch_lab_stripe_portal_session_mismatch");
  }
  validStripeHostedUrl(session.url, "billing.stripe.com");
}

function assertDeletedCustomer(customer: StripeObject, customerId: string): void {
  if (customer.id !== customerId || customer.deleted !== true) {
    throw new Error("launch_lab_stripe_portal_customer_not_deleted");
  }
}

async function loadPortal(
  db: D1Database,
  runId: string
): Promise<PortalRow | null> {
  return db.prepare(
    `SELECT run_id, phase, provider_customer_id, portal_verified,
            customer_deleted, transition_count
     FROM launch_lab_stripe_portal_rehearsals
     WHERE run_id = ?`
  ).bind(runId).first<PortalRow>();
}

async function transition(
  db: D1Database,
  lifecycle: PortalRow,
  phase: PortalPhase,
  fields: Record<string, unknown> = {}
): Promise<PortalRow> {
  const allowed = new Set([
    "provider_customer_id",
    "portal_verified",
    "customer_deleted",
    "completed_at"
  ]);
  const entries = Object.entries(fields);
  if (entries.some(([field]) => !allowed.has(field))) {
    throw new Error("launch_lab_stripe_portal_transition_invalid");
  }
  const assignments = entries.map(([field]) => `${field} = ?`);
  const result = await db.prepare(
    `UPDATE launch_lab_stripe_portal_rehearsals
     SET phase = ?, ${assignments.length ? `${assignments.join(", ")}, ` : ""}
         transition_count = transition_count + 1,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE run_id = ? AND phase = ? AND transition_count = ?`
  ).bind(
    phase,
    ...entries.map(([, value]) => value),
    lifecycle.run_id,
    lifecycle.phase,
    lifecycle.transition_count
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("launch_lab_stripe_portal_transition_conflict");
  }
  const updated = await loadPortal(db, lifecycle.run_id);
  if (!updated || updated.phase !== phase) {
    throw new Error("launch_lab_stripe_portal_transition_failed");
  }
  return updated;
}

function present(lifecycle: PortalRow): LaunchLabStripePortalResult {
  return {
    schemaVersion: "dust-wave-launch-lab-stripe-portal-v1",
    phase: lifecycle.phase,
    complete: ["complete", "aborted"].includes(lifecycle.phase),
    portalVerified: lifecycle.portal_verified === 1,
    customerDeleted: lifecycle.customer_deleted === 1
  };
}

function requirePortalBoundary(env: PodcastEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.STRIPE_MODE !== "test"
    || !env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
    || !env.STRIPE_PORTAL_CONFIGURATION_ID
    || !/^https:\/\/[A-Za-z0-9.-]+$/.test(String(env.SITE_ORIGIN ?? ""))
  ) {
    throw new Error("launch_lab_stripe_portal_not_available");
  }
}

function safeErrorCode(error: unknown): string {
  const message = String(error instanceof Error ? error.message : "");
  return /^launch_lab_[a-z0-9_]{1,68}$/.test(message)
    ? message
    : "stripe_api_error";
}
