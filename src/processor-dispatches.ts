import registry from "../config/processor-dispatch-registry.json";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { readSignedJsonBody } from "./signed-callback";
import {
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const PROCESSOR_TIMESTAMP_HEADER = "x-podcast-processor-timestamp";
const PROCESSOR_SIGNATURE_HEADER = "x-podcast-processor-signature";
const DISPATCH_MODE = "github_actions_pull";
const MAXIMUM_CLAIM_COUNT = 4;
const MAXIMUM_ATTEMPTS = 5;

const PROCESSOR_TYPES = new Set(Object.keys(registry.processors));

type ProcessorDispatchRow = {
  id: string;
  processor_type: string;
  target_id: string;
  processor_manifest_sha256: string;
  status: string;
  attempt_count: number;
  lease_id: string | null;
  github_run_id: string | null;
};

export type ProcessorDispatchClaim = {
  id: string;
  processorType: string;
  targetId: string;
  processorManifestSha256: string;
  leaseId: string;
  attempt: number;
};

export type ProcessorDispatchLedgerSummary = {
  total: number;
  queued: number;
  leased: number;
  dispatched: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
};

export function processorDispatchConfigured(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && env.PROCESSOR_DISPATCH_MODE === DISPATCH_MODE
    && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET);
}

export async function syncProcessorDispatches(
  env: PodcastEnv
): Promise<void> {
  if (!processorDispatchConfigured(env)) return;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO processor_dispatches (
         id, processor_type, target_id, processor_manifest_sha256,
         source_requested_at
       )
       SELECT
         'processor_dispatch_' || source.processor_type || '_' || source.target_id,
         source.processor_type,
         source.target_id,
         source.processor_manifest_sha256,
         source.source_requested_at
       FROM processor_dispatch_sources source
       WHERE source.lifecycle_status = 'pending'
       ON CONFLICT(processor_type, target_id) DO NOTHING`
    ),
    terminalSyncStatement(env.DB, "succeeded"),
    terminalSyncStatement(env.DB, "failed"),
    terminalSyncStatement(env.DB, "canceled"),
    env.DB.prepare(
      `UPDATE processor_dispatches
       SET
         status = 'running',
         started_at = COALESCE(started_at, datetime('now')),
         updated_at = datetime('now')
       WHERE status IN ('leased', 'dispatched')
         AND EXISTS (
           SELECT 1
           FROM processor_dispatch_sources source
           WHERE source.processor_type = processor_dispatches.processor_type
             AND source.target_id = processor_dispatches.target_id
             AND source.processor_manifest_sha256 =
               processor_dispatches.processor_manifest_sha256
             AND source.lifecycle_status = 'running'
         )`
    ),
    env.DB.prepare(
      `UPDATE processor_dispatches
       SET
         status = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN 'failed'
           ELSE 'queued'
         END,
         next_attempt_at = datetime('now', '+' || (attempt_count * 5) || ' minutes'),
         lease_expires_at = NULL,
         failure_code = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS}
             THEN 'dispatch_attempts_exhausted'
           ELSE NULL
         END,
         last_error = 'GitHub dispatcher lease expired before acknowledgement.',
         completed_at = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN datetime('now')
           ELSE NULL
         END,
         updated_at = datetime('now')
       WHERE status = 'leased'
         AND lease_expires_at <= datetime('now')`
    ),
    env.DB.prepare(
      `UPDATE processor_dispatches
       SET
         status = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN 'failed'
           ELSE 'queued'
         END,
         next_attempt_at = datetime('now', '+' || (attempt_count * 5) || ' minutes'),
         failure_code = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS}
             THEN 'processor_start_attempts_exhausted'
           ELSE NULL
         END,
         last_error = 'Dispatched GitHub run did not start the exact source job.',
         completed_at = CASE
           WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN datetime('now')
           ELSE NULL
         END,
         updated_at = datetime('now')
       WHERE status = 'dispatched'
         AND dispatched_at <= datetime('now', '-8 hours')
         AND EXISTS (
           SELECT 1
           FROM processor_dispatch_sources source
           WHERE source.processor_type = processor_dispatches.processor_type
             AND source.target_id = processor_dispatches.target_id
             AND source.processor_manifest_sha256 =
               processor_dispatches.processor_manifest_sha256
             AND source.lifecycle_status = 'pending'
         )`
    )
  ]);
}

export async function claimProcessorDispatches(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!processorDispatchConfigured(env)) {
    return processorNotFound(request, env);
  }
  const signed = await readDispatchBody(
    request,
    env,
    "Processor dispatch claim"
  );
  if (!signed.ok) return processorAuthError(request, env);
  if (
    signed.body.action !== "claim"
    || signed.body.dispatcher !== "github-actions"
  ) {
    throw new RequestValidationError(
      "Processor dispatch claim identity is invalid",
      "invalid_processor_dispatch_claim"
    );
  }
  const maximum = Number(signed.body.maximum ?? 1);
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > MAXIMUM_CLAIM_COUNT
  ) {
    throw new RequestValidationError(
      `maximum must be between 1 and ${MAXIMUM_CLAIM_COUNT}`,
      "invalid_processor_dispatch_claim"
    );
  }

  await syncProcessorDispatches(env);
  const candidates = await env.DB.prepare(
    `SELECT
       id, processor_type, target_id, processor_manifest_sha256,
       status, attempt_count, lease_id, github_run_id
     FROM processor_dispatches
     WHERE status = 'queued'
       AND attempt_count < ?
       AND next_attempt_at <= datetime('now')
     ORDER BY source_requested_at, created_at, id
     LIMIT ?`
  ).bind(MAXIMUM_ATTEMPTS, maximum * 2).all<ProcessorDispatchRow>();

  const claimed: ProcessorDispatchClaim[] = [];
  for (const candidate of candidates.results) {
    if (claimed.length >= maximum) break;
    assertDispatchRow(candidate);
    const leaseId = `processor_lease_${crypto.randomUUID()}`;
    const result = await env.DB.prepare(
      `UPDATE processor_dispatches
       SET
         status = 'leased',
         attempt_count = attempt_count + 1,
         lease_id = ?,
         lease_expires_at = datetime('now', '+15 minutes'),
         leased_at = datetime('now'),
         failure_code = NULL,
         last_error = NULL,
         completed_at = NULL,
         updated_at = datetime('now')
       WHERE id = ?
         AND status = 'queued'
         AND attempt_count = ?
         AND attempt_count < ?
         AND next_attempt_at <= datetime('now')`
    ).bind(
      leaseId,
      candidate.id,
      candidate.attempt_count,
      MAXIMUM_ATTEMPTS
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) continue;
    claimed.push({
      id: candidate.id,
      processorType: candidate.processor_type,
      targetId: candidate.target_id,
      processorManifestSha256: candidate.processor_manifest_sha256,
      leaseId,
      attempt: candidate.attempt_count + 1
    });
  }

  const ledger = await loadProcessorDispatchLedgerSummary(env.DB);

  return privateJson(request, env.ALLOWED_ORIGINS, {
    schemaVersion: 1,
    dispatches: claimed,
    ledger
  });
}

async function loadProcessorDispatchLedgerSummary(
  db: D1Database
): Promise<ProcessorDispatchLedgerSummary> {
  const row = await db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
       SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END) AS dispatched,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled
     FROM processor_dispatches`
  ).first<Record<keyof ProcessorDispatchLedgerSummary, number | null>>();
  const summary = {} as ProcessorDispatchLedgerSummary;
  for (const key of [
    "total",
    "queued",
    "leased",
    "dispatched",
    "running",
    "succeeded",
    "failed",
    "canceled"
  ] as const) {
    const value = Number(row?.[key] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Durable processor dispatch summary is invalid");
    }
    summary[key] = value;
  }
  return summary;
}

export async function acknowledgeProcessorDispatch(
  request: Request,
  env: PodcastEnv,
  dispatchIdValue: string
): Promise<Response> {
  if (!processorDispatchConfigured(env)) {
    return processorNotFound(request, env);
  }
  const dispatchId = validDispatchIdentifier(dispatchIdValue);
  const signed = await readDispatchBody(
    request,
    env,
    "Processor dispatch acknowledgement"
  );
  if (!signed.ok) return processorAuthError(request, env);
  const bodyDispatchId = validDispatchIdentifier(signed.body.dispatchId);
  const leaseId = validIdentifier(signed.body.leaseId, "leaseId");
  const githubRunId = requiredText(
    signed.body.githubRunId,
    "githubRunId",
    30
  );
  if (
    signed.body.action !== "dispatched"
    || bodyDispatchId !== dispatchId
    || !/^[0-9]+$/.test(githubRunId)
  ) {
    throw new RequestValidationError(
      "Processor dispatch acknowledgement is invalid",
      "invalid_processor_dispatch_acknowledgement"
    );
  }

  const result = await env.DB.prepare(
    `UPDATE processor_dispatches
     SET
       status = 'dispatched',
       github_run_id = ?,
       lease_expires_at = NULL,
       dispatched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?
       AND status = 'leased'
       AND lease_id = ?`
  ).bind(githubRunId, dispatchId, leaseId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    const current = await loadDispatch(env.DB, dispatchId);
    if (
      current?.status !== "dispatched"
      || current.lease_id !== leaseId
      || current.github_run_id !== githubRunId
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "processor_dispatch_conflict" },
        { status: 409 }
      );
    }
  }

  return privateJson(request, env.ALLOWED_ORIGINS, {
    dispatch: {
      id: dispatchId,
      status: "dispatched",
      githubRunId
    }
  });
}

export async function rejectProcessorDispatchLease(
  request: Request,
  env: PodcastEnv,
  dispatchIdValue: string
): Promise<Response> {
  if (!processorDispatchConfigured(env)) {
    return processorNotFound(request, env);
  }
  const dispatchId = validDispatchIdentifier(dispatchIdValue);
  const signed = await readDispatchBody(
    request,
    env,
    "Processor dispatch failure"
  );
  if (!signed.ok) return processorAuthError(request, env);
  const bodyDispatchId = validDispatchIdentifier(signed.body.dispatchId);
  const leaseId = validIdentifier(signed.body.leaseId, "leaseId");
  const failureCode = requiredText(
    signed.body.failureCode,
    "failureCode",
    80
  );
  if (
    signed.body.action !== "dispatch_failed"
    || bodyDispatchId !== dispatchId
    || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(failureCode)
  ) {
    throw new RequestValidationError(
      "Processor dispatch failure is invalid",
      "invalid_processor_dispatch_failure"
    );
  }

  const result = await env.DB.prepare(
    `UPDATE processor_dispatches
     SET
       status = CASE
         WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN 'failed'
         ELSE 'queued'
       END,
       next_attempt_at = datetime('now', '+' || (attempt_count * 5) || ' minutes'),
       lease_expires_at = NULL,
       failure_code = CASE
         WHEN attempt_count >= ${MAXIMUM_ATTEMPTS}
           THEN 'dispatch_attempts_exhausted'
         ELSE NULL
       END,
       last_error = ?,
       completed_at = CASE
         WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN datetime('now')
         ELSE NULL
       END,
       updated_at = datetime('now')
     WHERE id = ?
       AND status = 'leased'
       AND lease_id = ?`
  ).bind(failureCode, dispatchId, leaseId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "processor_dispatch_conflict" },
      { status: 409 }
    );
  }

  return privateJson(request, env.ALLOWED_ORIGINS, {
    dispatch: {
      id: dispatchId,
      status: "retry_scheduled"
    }
  });
}

function terminalSyncStatement(
  db: D1Database,
  lifecycleStatus: "succeeded" | "failed" | "canceled"
): D1PreparedStatement {
  return db.prepare(
    `UPDATE processor_dispatches
     SET
       status = '${lifecycleStatus}',
       completed_at = COALESCE(completed_at, datetime('now')),
       lease_expires_at = NULL,
       updated_at = datetime('now')
     WHERE status NOT IN ('succeeded', 'failed', 'canceled')
       AND EXISTS (
         SELECT 1
         FROM processor_dispatch_sources source
         WHERE source.processor_type = processor_dispatches.processor_type
           AND source.target_id = processor_dispatches.target_id
           AND source.processor_manifest_sha256 =
             processor_dispatches.processor_manifest_sha256
           AND source.lifecycle_status = '${lifecycleStatus}'
       )`
  );
}

async function readDispatchBody(
  request: Request,
  env: PodcastEnv,
  bodyName: string
) {
  return readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    maximumBytes: 4_000,
    bodyName,
    invalidBodyCode: "invalid_processor_dispatch_body"
  });
}

async function loadDispatch(
  db: D1Database,
  dispatchId: string
): Promise<ProcessorDispatchRow | null> {
  return db.prepare(
    `SELECT
       id, processor_type, target_id, processor_manifest_sha256,
       status, attempt_count, lease_id, github_run_id
     FROM processor_dispatches
     WHERE id = ?`
  ).bind(dispatchId).first<ProcessorDispatchRow>();
}

function assertDispatchRow(row: ProcessorDispatchRow): void {
  validDispatchIdentifier(row.id);
  validIdentifier(row.target_id, "targetId");
  if (
    !PROCESSOR_TYPES.has(row.processor_type)
    || !/^[a-f0-9]{64}$/.test(row.processor_manifest_sha256)
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 0
    || row.attempt_count >= MAXIMUM_ATTEMPTS
  ) {
    throw new Error("Durable processor dispatch state is invalid");
  }
}

function validDispatchIdentifier(value: unknown): string {
  const dispatchId = requiredText(value, "dispatchId", 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(dispatchId)) {
    throw new RequestValidationError("dispatchId is invalid");
  }
  return dispatchId;
}

function processorAuthError(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "invalid_processor_signature" },
    { status: 401 }
  );
}

function processorNotFound(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "not_found" },
    { status: 404 }
  );
}
