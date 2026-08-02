import type { PodcastEnv } from "./env";
import {
  launchLabExpectedStatus,
  refreshLaunchLabRunStatus
} from "./launch-lab-ledger";
import {
  getLaunchLabResendDeliveryStatus,
  sendLaunchLabResendScenario,
  type LaunchLabResendScenario
} from "./resend";

const SCENARIOS = [
  "delivered",
  "bounced",
  "complained",
  "suppressed"
] as const satisfies readonly LaunchLabResendScenario[];
const LIST_QUERY = [
  "SELECT id, scenario, expected_status, state, observed_status,",
  "  provider_id, failure_code, attempt_count",
  "FROM launch_lab_provider_scenarios",
  "WHERE run_id = ? AND provider = 'resend'",
  "ORDER BY scenario"
].join("\n");
const INSERT_QUERY = [
  "INSERT OR IGNORE INTO launch_lab_provider_scenarios (",
  "  id, run_id, provider, scenario, expected_status",
  ") VALUES (?, ?, 'resend', ?, ?)"
].join("\n");
const ACCEPT_QUERY = [
  "UPDATE launch_lab_provider_scenarios",
  "SET",
  "  state = CASE WHEN state IN ('pending', 'failed') THEN ? ELSE state END,",
  "  observed_status = CASE",
  "    WHEN state IN ('pending', 'failed') THEN ? ELSE observed_status",
  "  END,",
  "  provider_id = COALESCE(provider_id, ?),",
  "  failure_code = CASE",
  "    WHEN state IN ('pending', 'failed') THEN ? ELSE failure_code",
  "  END,",
  "  attempt_count = attempt_count + CASE",
  "    WHEN state IN ('pending', 'failed') THEN 1 ELSE 0",
  "  END,",
  "  completed_at = CASE",
  "    WHEN state IN ('pending', 'failed') AND ? = 'failed'",
  "      THEN datetime('now')",
  "    WHEN state IN ('pending', 'failed') THEN NULL",
  "    ELSE completed_at",
  "  END,",
  "  updated_at = datetime('now')",
  "WHERE id = ?"
].join("\n");
const WEBHOOK_QUERY = [
  "UPDATE launch_lab_provider_scenarios",
  "SET",
  "  state = CASE",
  "    WHEN state = 'passed' THEN state",
  "    WHEN ? = expected_status THEN 'passed'",
  "    WHEN state = 'failed' THEN state",
  "    WHEN ? IN ('suppressed', 'failed') THEN 'failed'",
  "    ELSE 'running'",
  "  END,",
  "  observed_status = CASE",
  "    WHEN state = 'passed' THEN observed_status",
  "    WHEN ? = expected_status THEN ?",
  "    WHEN state = 'failed' THEN observed_status",
  "    ELSE ?",
  "  END,",
  "  provider_id = COALESCE(provider_id, NULLIF(?, '')),",
  "  completed_at = CASE",
  "    WHEN ? = expected_status OR ? IN ('suppressed', 'failed')",
  "      THEN datetime('now')",
  "    ELSE completed_at",
  "  END,",
  "  updated_at = datetime('now')",
  "WHERE id = ?",
  "  AND (provider_id IS NULL OR provider_id = ?)",
  "RETURNING id, run_id"
].join("\n");
const WEBHOOK_JOURNAL_QUERY = [
  "SELECT CASE",
  "  WHEN MAX(CASE WHEN event_type IN (",
  "    'email.suppressed', 'email.complained'",
  "  ) THEN 1 ELSE 0 END) = 1 THEN 'suppressed'",
  "  WHEN MAX(CASE WHEN event_type = 'email.failed'",
  "    THEN 1 ELSE 0 END) = 1 THEN 'failed'",
  "  WHEN MAX(CASE WHEN event_type = 'email.delivered'",
  "    THEN 1 ELSE 0 END) = 1 THEN 'delivered'",
  "  WHEN MAX(CASE WHEN event_type = 'email.sent'",
  "    THEN 1 ELSE 0 END) = 1 THEN 'accepted'",
  "  ELSE NULL",
  "END AS observed_status",
  "FROM podcast_resend_webhook_events",
  "WHERE provider_id = ?"
].join("\n");

type ScenarioRow = {
  id: string;
  scenario: LaunchLabResendScenario;
  expected_status: string;
  state: string;
  observed_status: string | null;
  provider_id: string | null;
  failure_code: string | null;
  attempt_count: number;
};

export async function runLaunchLabResendMatrix(
  env: PodcastEnv,
  runId: string
): Promise<Record<string, unknown>> {
  const initial = await loadRows(env.DB, runId);
  const existing = new Set(initial.map(({ scenario }) => scenario));
  for (const scenario of SCENARIOS) {
    if (existing.has(scenario)) continue;
    await env.DB.prepare(INSERT_QUERY).bind(
      scenarioId(runId, scenario),
      runId,
      scenario,
      expectedStatus(scenario)
    ).run();
  }
  const beforeSend = await loadRows(env.DB, runId);
  await Promise.all(beforeSend.map(async (row) => {
    const retryable = row.state === "failed"
      && ["provider_timeout", "provider_unavailable"]
        .includes(String(row.failure_code));
    if (
      (row.state !== "pending" && !retryable)
      || row.provider_id
      || Number(row.attempt_count) >= 3
    ) return;
    const delivery = await sendLaunchLabResendScenario(env, {
      scenario: row.scenario,
      scenarioId: row.id
    });
    const state = delivery.sent ? "running" : "failed";
    const observedStatus = delivery.sent ? "accepted" : "failed";
    await env.DB.prepare(ACCEPT_QUERY).bind(
      state,
      observedStatus,
      delivery.providerId ?? null,
      delivery.failureCode ?? null,
      state,
      row.id
    ).run();
  }));
  const afterSend = await loadRows(env.DB, runId);
  await Promise.all(afterSend.map(async (row) => {
    const recoverableMismatch = row.state === "failed"
      && !row.failure_code;
    if (
      (row.state !== "running" && !recoverableMismatch)
      || !row.provider_id
    ) return;
    const status = await recordedLaunchLabResendDeliveryStatus(
      env.DB,
      row.provider_id
    ) ?? await getLaunchLabResendDeliveryStatus(env, row.provider_id);
    if (!status) return;
    await recordLaunchLabResendWebhook(env.DB, {
      providerId: row.provider_id,
      scenarioId: row.id,
      status
    });
  }));
  await refreshLaunchLabRunStatus(env.DB, runId);
  return presentMatrix(await loadRows(env.DB, runId), runId);
}

async function recordedLaunchLabResendDeliveryStatus(
  db: D1Database,
  providerId: string
): Promise<"accepted" | "delivered" | "suppressed" | "failed" | null> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(providerId)) return null;
  const row = await db.prepare(WEBHOOK_JOURNAL_QUERY)
    .bind(providerId)
    .first<{ observed_status: string | null }>();
  switch (row?.observed_status) {
    case "accepted":
    case "delivered":
    case "suppressed":
    case "failed":
      return row.observed_status;
    default:
      return null;
  }
}

function expectedStatus(scenario: LaunchLabResendScenario): string {
  const expected = launchLabExpectedStatus("resend", scenario);
  if (!expected) throw new Error("Launch Lab Resend scenario is not configured.");
  return expected;
}

export async function recordLaunchLabResendWebhook(
  db: D1Database,
  {
    providerId,
    scenarioId: suppliedScenarioId,
    status
  }: {
    providerId: string;
    scenarioId: string;
    status: "accepted" | "delivered" | "suppressed" | "failed";
  }
): Promise<boolean> {
  if (
    !/^lab_[A-Za-z0-9_-]{16,64}_resend_(delivered|bounced|complained|suppressed)$/
      .test(suppliedScenarioId)
    || !/^[A-Za-z0-9_-]{0,160}$/.test(providerId)
  ) {
    return false;
  }
  const updated = await db.prepare(WEBHOOK_QUERY).bind(
    status,
    status,
    status,
    status,
    status,
    providerId,
    status,
    status,
    suppliedScenarioId,
    providerId
  ).first<{ id: string; run_id: string }>();
  if (updated?.id !== suppliedScenarioId) return false;
  await refreshLaunchLabRunStatus(db, updated.run_id);
  return true;
}

function scenarioId(
  runId: string,
  scenario: LaunchLabResendScenario
): string {
  return "lab_" + runId + "_resend_" + scenario;
}

async function loadRows(
  db: D1Database,
  runId: string
): Promise<ScenarioRow[]> {
  const rows = await db.prepare(LIST_QUERY).bind(runId).all<ScenarioRow>();
  return rows.results;
}

function presentMatrix(
  rows: ScenarioRow[],
  runId: string
): Record<string, unknown> {
  const byScenario = new Map(rows.map((row) => [row.scenario, row]));
  const scenarios = SCENARIOS.map((scenario) => {
    const row = byScenario.get(scenario);
    const status = row?.observed_status ?? "missing";
    return {
      scenario,
      status,
      state: row?.state ?? "missing",
      passed: row?.state === "passed"
    };
  });
  return {
    schemaVersion: "dust-wave-launch-lab-resend-v1",
    runId,
    scenarios,
    passed: scenarios.every(({ passed }) => passed),
    launchGateEligible: false,
    recipientIdentityRetained: false
  };
}
