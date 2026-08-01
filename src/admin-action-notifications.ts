import {
  normalizeEmail,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import {
  issueAdminLoginToken,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import {
  FINAL_WORKING_MASTER_DECISION_SQL
} from "./final-working-master";
import { isValidEmailAddress } from "./passwordless-security";
import { sendAdminActionMagicLink } from "./resend";
import {
  currentWorkingMasterDecisionEvidenceSql
} from "./working-master-decision-evidence";

export type AdminActionKind =
  | "delivery_audio_approval"
  | "transcript_review"
  | "working_master_decision";

const MAXIMUM_ATTEMPTS = 3;
const MAXIMUM_DISCOVERIES = 20;
const MAXIMUM_DELIVERIES = 5;

type AdminActionEvidence = {
  target_id: string;
  episode_id: string;
  show_id: string;
  action_ready_at: string;
  source_master_id?: string;
  output_sha256?: string;
  processor_manifest_sha256?: string;
  processor_report_sha256?: string;
  peaks_sha256?: string;
  quality_control_report_sha256?: string;
  quality_control_policy_revision?: number;
  working_master_revision?: number;
  language?: string;
  transcript_revision?: number;
  transcript_sha256?: string;
  input_fingerprint?: string;
};

type PendingAdminAction = {
  id: string;
  action_kind: AdminActionKind;
  target_id: string;
  action_digest: string;
  attempt_count: number;
};

type ActionDefinition = {
  roles: AdminRole[];
  step: string;
  target: string;
  evidenceSelect: string;
};

export const WORKING_MASTER_DECISION_EVIDENCE_SELECT = `
  SELECT
    audio_enhancement_derivatives.id AS target_id,
    audio_enhancement_derivatives.episode_id,
    episode.show_id,
    audio_enhancement_derivatives.completed_at AS action_ready_at,
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

export const DELIVERY_AUDIO_APPROVAL_EVIDENCE_SELECT = `
  SELECT
    job.id AS target_id,
    job.episode_id,
    episode.show_id,
    job.completed_at AS action_ready_at,
    job.source_master_id,
    job.output_sha256,
    job.processor_manifest_sha256,
    job.processor_report_sha256,
    job.peaks_sha256
  FROM delivery_audio_jobs job
  JOIN episodes episode
    ON episode.id = job.episode_id
  JOIN episode_working_master_states state
    ON state.episode_id = job.episode_id
   AND state.current_master_id = job.source_master_id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = episode.id
  WHERE episode.status IN ('draft', 'scheduled')
    AND ${FINAL_WORKING_MASTER_DECISION_SQL}
    AND job.status = 'ready'
    AND job.completed_at IS NOT NULL
    AND job.output_sha256 IS NOT NULL
    AND job.processor_report_sha256 IS NOT NULL
    AND job.peaks_sha256 IS NOT NULL`;

export const TRANSCRIPT_REVIEW_EVIDENCE_SELECT = `
  SELECT
    transcript.id AS target_id,
    transcript.episode_id,
    episode.show_id,
    transcript.updated_at AS action_ready_at,
    job.working_master_id AS source_master_id,
    transcript.language,
    transcript.revision AS transcript_revision,
    transcript.content_sha256 AS transcript_sha256,
    job.input_fingerprint
  FROM transcripts transcript
  JOIN episodes episode
    ON episode.id = transcript.episode_id
  JOIN episode_working_master_states state
    ON state.episode_id = transcript.episode_id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = episode.id
  JOIN transcription_jobs job
    ON job.transcript_id = transcript.id
   AND job.transcript_revision = transcript.revision
   AND job.transcript_sha256 = transcript.content_sha256
   AND job.working_master_id = state.current_master_id
  WHERE episode.status IN ('draft', 'scheduled')
    AND ${FINAL_WORKING_MASTER_DECISION_SQL}
    AND transcript.status = 'needs_review'
    AND transcript.revision > 0
    AND transcript.content_sha256 IS NOT NULL
    AND job.status = 'succeeded'`;

const ACTION_DEFINITIONS: Record<AdminActionKind, ActionDefinition> = {
  working_master_decision: {
    roles: ["super_admin"],
    step: "media",
    target: "working_master",
    evidenceSelect: WORKING_MASTER_DECISION_EVIDENCE_SELECT
  },
  delivery_audio_approval: {
    roles: ["super_admin"],
    step: "media",
    target: "delivery_audio",
    evidenceSelect: DELIVERY_AUDIO_APPROVAL_EVIDENCE_SELECT
  },
  transcript_review: {
    roles: ["super_admin", "admin"],
    step: "transcript",
    target: "transcript_review",
    evidenceSelect: TRANSCRIPT_REVIEW_EVIDENCE_SELECT
  }
};

export function prepareResolveWorkingMasterAction(
  db: D1Database,
  targetId: string
): D1PreparedStatement {
  return prepareResolveAdminAction(
    db,
    "working_master_decision",
    targetId
  );
}

export function prepareResolveDeliveryAudioAction(
  db: D1Database,
  targetId: string
): D1PreparedStatement {
  return prepareResolveAdminAction(db, "delivery_audio_approval", targetId);
}

export function prepareResolveTranscriptReviewAction(
  db: D1Database,
  targetId: string
): D1PreparedStatement {
  return prepareResolveAdminAction(db, "transcript_review", targetId);
}

function prepareResolveAdminAction(
  db: D1Database,
  actionKind: AdminActionKind,
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
     WHERE action_kind = ?
       AND target_id = ?
       AND status IN ('pending', 'sending', 'sent', 'failed')`
  ).bind(actionKind, targetId);
}

export async function scheduleAdminActionNotifications(
  env: PodcastEnv
): Promise<void> {
  if (env.ADMIN_ACTION_NOTIFICATION_MODE !== "live") return;

  await recoverExpiredLeases(env.DB);
  for (const actionKind of actionKinds()) {
    await discoverActions(env.DB, actionKind);
    await resolveObsoleteActions(env.DB, actionKind);
  }

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
    `SELECT id, action_kind, target_id, action_digest, attempt_count
     FROM admin_action_notifications
     WHERE status = 'pending'
       AND attempt_count < ?
       AND next_attempt_at <= datetime('now')
     ORDER BY created_at, id
     LIMIT ?`
  ).bind(MAXIMUM_ATTEMPTS, MAXIMUM_DELIVERIES)
    .all<PendingAdminAction>();

  for (const candidate of candidates.results) {
    await deliverAdminAction(env, candidate, email);
  }
}

async function discoverActions(
  db: D1Database,
  actionKind: AdminActionKind
): Promise<void> {
  const definition = ACTION_DEFINITIONS[actionKind];
  const evidence = await db.prepare(
    `SELECT *
     FROM (${definition.evidenceSelect}) evidence
     ORDER BY evidence.action_ready_at, evidence.target_id
     LIMIT ?`
  ).bind(MAXIMUM_DISCOVERIES).all<AdminActionEvidence>();
  if (evidence.results.length < 1) return;

  await db.batch(await Promise.all(evidence.results.map(async (row) => {
    const digest = await actionDigest(actionKind, row);
    return db.prepare(
      `INSERT OR IGNORE INTO admin_action_notifications (
         id, episode_id, action_kind, target_id, action_digest
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      `admin_action_${digest.slice(0, 40)}`,
      row.episode_id,
      actionKind,
      row.target_id,
      digest
    );
  })));
}

async function resolveObsoleteActions(
  db: D1Database,
  actionKind: AdminActionKind
): Promise<void> {
  const definition = ACTION_DEFINITIONS[actionKind];
  await db.prepare(
    `UPDATE admin_action_notifications
     SET
       status = 'resolved',
       lease_id = NULL,
       lease_expires_at = NULL,
       failure_code = NULL,
       resolved_at = datetime('now'),
       updated_at = datetime('now')
     WHERE action_kind = ?
       AND status IN ('pending', 'sending', 'sent', 'failed')
       AND NOT EXISTS (
         SELECT 1
         FROM (${definition.evidenceSelect}) evidence
         WHERE evidence.target_id = admin_action_notifications.target_id
           AND evidence.episode_id = admin_action_notifications.episode_id
       )`
  ).bind(actionKind).run();
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

async function deliverAdminAction(
  env: PodcastEnv,
  candidate: PendingAdminAction,
  email: string
): Promise<void> {
  const definition = ACTION_DEFINITIONS[candidate.action_kind];
  if (!definition) return;
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
       AND action_kind = ?
       AND status = 'pending'
       AND attempt_count = ?
       AND attempt_count < ?
       AND next_attempt_at <= datetime('now')`
  ).bind(
    leaseId,
    candidate.id,
    candidate.action_kind,
    candidate.attempt_count,
    MAXIMUM_ATTEMPTS
  ).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return;

  const evidence = await env.DB.prepare(
    `SELECT *
     FROM (${definition.evidenceSelect}) evidence
     WHERE evidence.target_id = ?`
  ).bind(candidate.target_id).first<AdminActionEvidence>();
  if (
    !evidence
    || await actionDigest(candidate.action_kind, evidence)
      !== candidate.action_digest
  ) {
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
    step: definition.step,
    target: definition.target
  });
  const issued = await issueAdminLoginToken(env, {
    allowedRoles: definition.roles,
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
    actionKind: candidate.action_kind,
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
  actionKind: AdminActionKind,
  evidence: AdminActionEvidence
): Promise<string> {
  if (actionKind === "working_master_decision") {
    return sha256Hex([
      "podcast-admin-action-v1",
      actionKind,
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
  const parts = actionKind === "delivery_audio_approval"
    ? [
      evidence.source_master_id,
      evidence.output_sha256,
      evidence.peaks_sha256,
      evidence.processor_manifest_sha256,
      evidence.processor_report_sha256
    ]
    : [
      evidence.source_master_id,
      evidence.language,
      String(evidence.transcript_revision),
      evidence.transcript_sha256,
      evidence.input_fingerprint
    ];
  return sha256Hex([
    "podcast-admin-action-v2",
    actionKind,
    evidence.show_id,
    evidence.episode_id,
    evidence.target_id,
    ...parts
  ].join(":"));
}

function actionKinds(): AdminActionKind[] {
  return [
    "working_master_decision",
    "delivery_audio_approval",
    "transcript_review"
  ];
}

function deepLinkIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
