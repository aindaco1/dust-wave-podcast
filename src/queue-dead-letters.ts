import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import type { PodcastJob } from "./types";

export const STAGING_PODCAST_JOB_QUEUE = "dust-wave-podcast-jobs-staging";
export const STAGING_PODCAST_DEAD_LETTER_QUEUE =
  "dust-wave-podcast-jobs-staging-dlq";

const DEAD_LETTER_RETRY_DELAY_SECONDS = 300;
const JOB_TYPES = new Set<PodcastJob["type"]>([
  "transcribe",
  "align-transcript",
  "render-clip",
  "publish-news",
  "publish-rss",
  "publish-youtube",
  "publish-youtube-clip",
  "execute-rss-import-item",
  "send-premium-notification",
  "send-announcement"
]);

interface SafePodcastJobEvidence {
  id: string;
  type: PodcastJob["type"];
  showId: string;
  episodeId: string | null;
  publicationRevision: number | null;
}

interface DeadLetterIncident {
  id: string;
  payloadSha256: string;
  classification: "podcast_job" | "malformed";
  jobId: string | null;
  jobType: PodcastJob["type"] | null;
  showId: string | null;
  episodeId: string | null;
  publicationRevision: number | null;
  failureCode:
    | "queue_delivery_attempts_exhausted"
    | "malformed_queue_job";
  deliveryAttempt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    return null;
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  return value;
}

function safeOptionalIdentifier(value: unknown): string | null | undefined {
  return value === undefined ? null : safeIdentifier(value) ?? undefined;
}

function safePublicationRevision(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) return undefined;
  return Number(value);
}

function validRequestedAt(value: unknown): boolean {
  return typeof value === "string"
    && value.length <= 64
    && !Number.isNaN(Date.parse(value));
}

function extractSafeJobEvidence(body: unknown): SafePodcastJobEvidence | null {
  if (!isRecord(body)) return null;

  const id = safeIdentifier(body.id);
  const showId = safeIdentifier(body.showId);
  const episodeId = safeOptionalIdentifier(body.episodeId);
  const publicationRevision = safePublicationRevision(body.publicationRevision);
  const type = typeof body.type === "string" && JOB_TYPES.has(
    body.type as PodcastJob["type"]
  )
    ? body.type as PodcastJob["type"]
    : null;

  if (
    !id
    || !showId
    || !type
    || episodeId === undefined
    || publicationRevision === undefined
    || !validRequestedAt(body.requestedAt)
  ) {
    return null;
  }

  return { id, type, showId, episodeId, publicationRevision };
}

function serializedBody(body: unknown): string {
  const serialized = JSON.stringify(body);
  return serialized === undefined ? "undefined" : serialized;
}

async function incidentForMessage(
  message: Message<unknown>
): Promise<DeadLetterIncident> {
  const payloadSha256 = await sha256Hex(serializedBody(message.body));
  const evidence = extractSafeJobEvidence(message.body);
  return {
    id: `queue_dead_letter_${payloadSha256}`,
    payloadSha256,
    classification: evidence ? "podcast_job" : "malformed",
    jobId: evidence?.id ?? null,
    jobType: evidence?.type ?? null,
    showId: evidence?.showId ?? null,
    episodeId: evidence?.episodeId ?? null,
    publicationRevision: evidence?.publicationRevision ?? null,
    failureCode: evidence
      ? "queue_delivery_attempts_exhausted"
      : "malformed_queue_job",
    deliveryAttempt: Math.max(1, Math.trunc(message.attempts || 1))
  };
}

async function persistIncident(
  env: PodcastEnv,
  incident: DeadLetterIncident
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO queue_dead_letter_incidents (
       id, payload_sha256, source_queue, dead_letter_queue,
       classification, job_id, job_type, show_id, episode_id,
       publication_revision, failure_code, last_dlq_delivery_attempt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(payload_sha256) DO UPDATE SET
       classification = excluded.classification,
       job_id = excluded.job_id,
       job_type = excluded.job_type,
       show_id = excluded.show_id,
       episode_id = excluded.episode_id,
       publication_revision = excluded.publication_revision,
       failure_code = excluded.failure_code,
       status = 'open',
       occurrence_count = queue_dead_letter_incidents.occurrence_count + 1,
       last_dlq_delivery_attempt = MAX(
         queue_dead_letter_incidents.last_dlq_delivery_attempt,
         excluded.last_dlq_delivery_attempt
       ),
       last_seen_at = datetime('now'),
       resolved_at = NULL`
  ).bind(
    incident.id,
    incident.payloadSha256,
    STAGING_PODCAST_JOB_QUEUE,
    STAGING_PODCAST_DEAD_LETTER_QUEUE,
    incident.classification,
    incident.jobId,
    incident.jobType,
    incident.showId,
    incident.episodeId,
    incident.publicationRevision,
    incident.failureCode,
    incident.deliveryAttempt
  ).run();
}

export function isPodcastDeadLetterQueue(
  env: PodcastEnv,
  queueName: string
): boolean {
  return env.ENVIRONMENT === "staging"
    && queueName === STAGING_PODCAST_DEAD_LETTER_QUEUE;
}

export async function handlePodcastDeadLetterBatch(
  batch: MessageBatch<unknown>,
  env: PodcastEnv
): Promise<void> {
  if (!isPodcastDeadLetterQueue(env, batch.queue)) {
    throw new Error("Unexpected podcast dead-letter queue");
  }

  for (const message of batch.messages) {
    try {
      const incident = await incidentForMessage(message);
      await persistIncident(env, incident);
      console.warn(JSON.stringify({
        level: "warn",
        event: "queue_dead_letter_incident_recorded",
        incidentId: incident.id,
        classification: incident.classification,
        jobId: incident.jobId,
        jobType: incident.jobType,
        showId: incident.showId,
        episodeId: incident.episodeId,
        deliveryAttempt: incident.deliveryAttempt
      }));
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "queue_dead_letter_incident_storage_failed",
        queueMessageId: message.id,
        attempt: message.attempts,
        errorName: error instanceof Error ? error.name : "UnknownError"
      }));
      message.retry({ delaySeconds: DEAD_LETTER_RETRY_DELAY_SECONDS });
    }
  }
}
