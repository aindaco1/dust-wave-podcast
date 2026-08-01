import {
  normalizeEmail,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import {
  issueAdminLoginToken,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { isValidEmailAddress } from "./passwordless-security";
import { sendAdminActionMagicLink } from "./resend";
import {
  currentWorkingMasterDecisionEvidenceSql
} from "./working-master-decision-evidence";

const ACTION_KIND = "working_master_decision" as const;
const ACTION_ROLES: AdminRole[] = ["super_admin"];
const MAXIMUM_ATTEMPTS = 3;
const MAXIMUM_DISCOVERIES = 20;
const MAXIMUM_DELIVERIES = 5;

type WorkingMasterDecisionEvidence = {
  target_id: string;
  episode_id: string;
  show_id: string;
  source_master_id: string;
  output_sha256: string;
  processor_report_sha256: string;
  quality_control_report_sha256: string;
  quality_control_policy_revision: number;
  working_master_revision: number;
};

type PendingAdminAction = {
  id: string;
  target_id: string;
  action_digest: string;
  attempt_count: number;
};

export const WORKING_MASTER_DECISION_EVIDENCE_SELECT = `
  SELECT
    audio_enhancement_derivatives.id AS target_id,
    audio_enhancement_derivatives.episode_id,
    episode.show_id,
    audio_enhancement_derivatives.source_master_id,
    audio_enhancement_derivatives.output_sha256,
    audio_enhancement_derivatives.processor_report_sha256,
    qc.report_sha256 AS quality_control_report_sha256,
    qc.policy_revision AS quality_control_policy_revision,
    state.revision AS working_master_revision
  FROM audio_enhancement_derivatives
  JOIN episodes episode
    ON episode.id = audio_enhancement_derivatives.episode_id
  JOIN episode_working_master_states state
    ON state.episode_id = audio_enhancement_derivatives.episode_id
  JOIN audio_qc_runs qc
    ON qc.id =
      audio_enhancement_derivatives.derivative_quality_control_run_id
  WHERE audio_enhancement_derivatives.status = 'ready'
    AND audio_enhancement_derivatives.rejected_at IS NULL
    AND audio_enhancement_derivatives.output_sha256 IS NOT NULL
    AND audio_enhancement_derivatives.processor_report_sha256 IS NOT NULL
    AND ${currentWorkingMasterDecisionEvidenceSql()}`;

export function prepareResolveWorkingMasterAction(
  db: D1Database,
  targetId: string
): D1PreparedStatement {
  return db.prepare(
    `UPDATE admin_action_notifications
     SET
       status = 'resolved',
       lease_id = NULL,
       lease_expires_at = NULL,
       failure_code = NULL,
       resolved_at = datetime('now'),
       updated_at = datetime('now')
     WHERE action_kind = '${ACTION_KIND}'
       AND target_id = ?
       AND status IN ('pending', 'sending', 'sent', 'failed')`
  ).bind(targetId);
}

export async function scheduleAdminActionNotifications(
  env: PodcastEnv
): Promise<void> {
  if (env.ADMIN_ACTION_NOTIFICATION_MODE !== "live") return;

  await recoverExpiredLeases(env.DB);
  await discoverWorkingMasterActions(env.DB);
  await resolveObsoleteActions(env.DB);

  const email = normalizeEmail(env.PODCAST_ACTION_EMAIL ?? "");
  if (
    !isValidEmailAddress(email)
    || !env.RESEND_API_KEY
    || !env.ADMIN_EMAIL_LOOKUP_PEPPER
    || !env.ADMIN_SESSION_SECRET
  ) {
    return;
  }

  const candidates = await env.DB.prepare(
    `SELECT id, target_id, action_digest, attempt_count
     FROM admin_action_notifications
     WHERE action_kind = '${ACTION_KIND}'
       AND status = 'pending'
       AND attempt_count < ?
       AND next_attempt_at <= datetime('now')
     ORDER BY created_at, id
     LIMIT ?`
  ).bind(MAXIMUM_ATTEMPTS, MAXIMUM_DELIVERIES).all<PendingAdminAction>();

  for (const candidate of candidates.results) {
    await deliverWorkingMasterAction(env, candidate, email);
  }
}

async function discoverWorkingMasterActions(db: D1Database): Promise<void> {
  const evidence = await db.prepare(
    `${WORKING_MASTER_DECISION_EVIDENCE_SELECT}
     ORDER BY audio_enhancement_derivatives.completed_at,
       audio_enhancement_derivatives.id
     LIMIT ?`
  ).bind(MAXIMUM_DISCOVERIES).all<WorkingMasterDecisionEvidence>();
  if (evidence.results.length < 1) return;

  await db.batch(await Promise.all(evidence.results.map(async (row) => {
    const digest = await actionDigest(row);
    return db.prepare(
      `INSERT OR IGNORE INTO admin_action_notifications (
         id, episode_id, action_kind, target_id, action_digest
       ) VALUES (?, ?, '${ACTION_KIND}', ?, ?)`
    ).bind(
      `admin_action_${digest.slice(0, 40)}`,
      row.episode_id,
      row.target_id,
      digest
    );
  })));
}

async function resolveObsoleteActions(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE admin_action_notifications
     SET
       status = 'resolved',
       lease_id = NULL,
       lease_expires_at = NULL,
       failure_code = NULL,
       resolved_at = datetime('now'),
       updated_at = datetime('now')
     WHERE action_kind = '${ACTION_KIND}'
       AND status IN ('pending', 'sending', 'sent', 'failed')
       AND NOT EXISTS (
         SELECT 1
         FROM (${WORKING_MASTER_DECISION_EVIDENCE_SELECT}) evidence
         WHERE evidence.target_id = admin_action_notifications.target_id
           AND evidence.episode_id = admin_action_notifications.episode_id
       )`
  ).run();
}

async function recoverExpiredLeases(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE admin_action_notifications
     SET
       status = CASE
         WHEN attempt_count >= ${MAXIMUM_ATTEMPTS} THEN 'failed'
         ELSE 'pending'
       END,
       next_attempt_at = datetime('now', '+5 minutes'),
       lease_id = NULL,
       lease_expires_at = NULL,
       failure_code = 'delivery_lease_expired',
       updated_at = datetime('now')
     WHERE status = 'sending'
       AND lease_expires_at <= datetime('now')`
  ).run();
}

async function deliverWorkingMasterAction(
  env: PodcastEnv,
  candidate: PendingAdminAction,
  email: string
): Promise<void> {
  const leaseId = `admin_action_lease_${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    `UPDATE admin_action_notifications
     SET
       status = 'sending',
       attempt_count = attempt_count + 1,
       lease_id = ?,
       lease_expires_at = datetime('now', '+4 minutes'),
       failure_code = NULL,
       updated_at = datetime('now')
     WHERE id = ?
       AND status = 'pending'
       AND attempt_count = ?
       AND attempt_count < ?
       AND next_attempt_at <= datetime('now')`
  ).bind(
    leaseId,
    candidate.id,
    candidate.attempt_count,
    MAXIMUM_ATTEMPTS
  ).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return;

  const evidence = await env.DB.prepare(
    `${WORKING_MASTER_DECISION_EVIDENCE_SELECT}
     AND audio_enhancement_derivatives.id = ?`
  ).bind(candidate.target_id).first<WorkingMasterDecisionEvidence>();
  if (!evidence || await actionDigest(evidence) !== candidate.action_digest) {
    await completeAction(env.DB, candidate.id, leaseId, {
      status: "resolved"
    });
    return;
  }
  if (
    !deepLinkIdentifier(evidence.show_id)
    || !deepLinkIdentifier(evidence.episode_id)
  ) {
    await completeAction(env.DB, candidate.id, leaseId, {
      failureCode: "admin_action_target_invalid",
      status: "failed"
    });
    return;
  }

  const search = new URLSearchParams({
    show: evidence.show_id,
    episode: evidence.episode_id,
    step: "media",
    target: "working_master"
  });
  const issued = await issueAdminLoginToken(env, {
    allowedRoles: ACTION_ROLES,
    email,
    returnPath: `/admin/podcasts/?${search.toString()}`,
    showId: evidence.show_id,
    stableSeed: candidate.action_digest
  });
  if (!issued) {
    await retryOrFailAction(
      env.DB,
      candidate,
      leaseId,
      "admin_action_recipient_not_authorized"
    );
    return;
  }

  const delivery = await sendAdminActionMagicLink(env, {
    deliveryKey: candidate.action_digest,
    email,
    loginUrl: issued.loginUrl
  });
  if (!delivery.sent) {
    await retryOrFailAction(
      env.DB,
      candidate,
      leaseId,
      delivery.failureCode ?? "admin_action_provider_unavailable"
    );
    return;
  }
  await completeAction(env.DB, candidate.id, leaseId, {
    providerId: delivery.providerId ?? null,
    status: "sent"
  });
}

async function retryOrFailAction(
  db: D1Database,
  candidate: PendingAdminAction,
  leaseId: string,
  failureCode: string
): Promise<void> {
  const attempt = candidate.attempt_count + 1;
  await completeAction(db, candidate.id, leaseId, {
    failureCode: failureCode.slice(0, 120),
    status: attempt >= MAXIMUM_ATTEMPTS ? "failed" : "pending"
  });
}

async function completeAction(
  db: D1Database,
  id: string,
  leaseId: string,
  {
    failureCode = null,
    providerId = null,
    status
  }: {
    failureCode?: string | null;
    providerId?: string | null;
    status: "pending" | "sent" | "resolved" | "failed";
  }
): Promise<void> {
  await db.prepare(
    `UPDATE admin_action_notifications
     SET
       status = ?,
       next_attempt_at = CASE
         WHEN ? = 'pending' THEN datetime('now', '+5 minutes')
         ELSE next_attempt_at
       END,
       lease_id = NULL,
       lease_expires_at = NULL,
       provider_id = ?,
       failure_code = ?,
       sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END,
       resolved_at = CASE
         WHEN ? = 'resolved' THEN datetime('now')
         ELSE resolved_at
       END,
       updated_at = datetime('now')
     WHERE id = ? AND status = 'sending' AND lease_id = ?`
  ).bind(
    status,
    status,
    providerId,
    failureCode,
    status,
    status,
    id,
    leaseId
  ).run();
}

async function actionDigest(
  evidence: WorkingMasterDecisionEvidence
): Promise<string> {
  return sha256Hex([
    "podcast-admin-action-v1",
    ACTION_KIND,
    evidence.show_id,
    evidence.episode_id,
    evidence.target_id,
    evidence.source_master_id,
    evidence.output_sha256,
    evidence.processor_report_sha256,
    evidence.quality_control_report_sha256,
    String(evidence.quality_control_policy_revision),
    String(evidence.working_master_revision)
  ].join(":"));
}

function deepLinkIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
