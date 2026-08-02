import {
  DELIVERY_AUDIO_PROFILE,
  buildDeliveryAudioManifest,
  deliveryAudioReportSha256,
  playerPeaksSha256,
  validateDeliveryAudioReport,
  validatePlayerPeaksDocument,
  type DeliveryAudioManifest,
  type DeliveryAudioReport,
  type PlayerPeaksDocument
} from "@dustwave/media-core/delivery-audio";
import {
  sha256BytesHex,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  prepareResolveDeliveryAudioAction
} from "./admin-action-notifications";
import {
  hasAdminRoleForShow,
  requireAdmin,
  requireRecentAdminAuthentication,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import type { PodcastEnv } from "./env";
import {
  FINAL_WORKING_MASTER_DECISION_SQL
} from "./final-working-master";
import {
  privateCorsHeaders,
  privateJson
} from "./http";
import {
  requestedMediaRange,
  safeDownloadFilename
} from "./media-range";
import { describeProcessorAvailability } from "./processor-mode";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import { completeMultipartUploadAndHead } from "./r2-multipart";
import {
  readSignedJsonBody,
  verifySignedText
} from "./signed-callback";
import {
  positiveInteger,
  readBoundedBytes,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const EDIT_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const PROCESSOR_TIMESTAMP_HEADER = "x-podcast-processor-timestamp";
const PROCESSOR_SIGNATURE_HEADER = "x-podcast-processor-signature";
const PROCESSOR_PART_PAYLOAD_HEADER =
  "x-podcast-processor-part-payload";
const MAXIMUM_PROCESSOR_BODY_BYTES = 125_000;
const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_PART_BYTES = 32 * 1024 * 1024;
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const RECOMMENDED_PART_BYTES = 33_554_432 as const;
const AUTOMATED_DELIVERY_AUDIO_MAX_ATTEMPTS = 3;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "render_failed",
  "audio_invalid",
  "peaks_invalid",
  "multipart_unavailable"
]);

type DeliverySourceRow = {
  episode_id: string;
  show_id: string;
  current_master_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  source_duration_ms: number;
};

type DeliveryJobRow = {
  id: string;
  episode_id: string;
  show_id: string;
  episode_slug: string;
  source_master_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  source_duration_ms: number;
  stream_profile: string;
  output_object_key: string;
  r2_upload_id: string;
  peaks_object_key: string;
  processor_manifest_sha256: string;
  status: string;
  output_object_bytes: number | null;
  output_object_etag: string | null;
  output_sha256: string | null;
  output_duration_ms: number | null;
  peaks_object_bytes: number | null;
  peaks_object_etag: string | null;
  peaks_sha256: string | null;
  peaks_length: number | null;
  processor_version: string | null;
  processor_report_json: string | null;
  processor_report_sha256: string | null;
  failure_code: string | null;
  requested_by_admin_user_id: string | null;
  requested_at: string;
  completed_at: string | null;
  approved_at: string | null;
  approval_reason: string | null;
  current_master_id: string | null;
  current_audio_key: string | null;
  current_audio_bytes: number | null;
  current_audio_etag: string | null;
};

type DeliveryPartRow = {
  part_number: number;
  etag: string;
  uploaded_bytes: number;
  sha256: string;
};

type EnsureDeliveryAudioJobResult =
  | {
    status: "created" | "existing";
    job: DeliveryJobRow | null;
    manifest: DeliveryAudioManifest;
  }
  | {
    status:
      | "job_conflict"
      | "job_exists"
      | "source_mismatch"
      | "source_not_ready";
    jobId?: string;
  };

type AutomatedDeliveryAudioCandidate = {
  episode_id: string;
  current_master_id: string;
  automated_attempt_count: number;
};

export const AUTOMATED_DELIVERY_AUDIO_CANDIDATES_SQL = `WITH eligible AS (
  SELECT
    episode.id AS episode_id,
    state.current_master_id,
    master.approved_at,
    (
      SELECT COUNT(*)
      FROM delivery_audio_jobs prior
      WHERE prior.episode_id = episode.id
        AND prior.source_master_id = master.id
        AND prior.stream_profile = '${DELIVERY_AUDIO_PROFILE}'
        AND prior.id LIKE 'delivery_audio_auto_%'
    ) AS automated_attempt_count
  FROM episodes episode
  JOIN episode_working_master_states state
    ON state.episode_id = episode.id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = episode.id
  WHERE episode.status IN ('draft', 'scheduled')
    AND episode.audio_key IS NULL
    AND ${FINAL_WORKING_MASTER_DECISION_SQL}
    AND NOT EXISTS (
      SELECT 1
      FROM delivery_audio_jobs delivery
      WHERE delivery.episode_id = episode.id
        AND delivery.source_master_id = master.id
        AND delivery.stream_profile = '${DELIVERY_AUDIO_PROFILE}'
        AND delivery.status IN (
          'queued', 'rendering', 'completing', 'ready', 'approved'
        )
    )
)
SELECT episode_id, current_master_id, automated_attempt_count
FROM eligible
WHERE automated_attempt_count < ?
ORDER BY approved_at, episode_id
LIMIT ?`;

export async function listAdminDeliveryAudioJobs(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    READ_ROLES
  );
  if (access instanceof Response) return access;
  const rows = await env.DB.prepare(
    `${deliveryJobSelect()}
     WHERE job.episode_id = ?
     ORDER BY job.requested_at DESC, job.id DESC
     LIMIT 20`
  ).bind(access.episode.id).all<DeliveryJobRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    jobs: rows.results.map((row) => presentDeliveryJob(env, row)),
    processor: describeProcessorAvailability(env, processorAvailable(env)),
    safeguards: {
      currentWorkingMasterRequired: true,
      normalizedStreamProfile: DELIVERY_AUDIO_PROFILE,
      fullyDecodedAudioRequired: true,
      checksumBoundPeaksRequired: true,
      explicitRecentSuperAdminApprovalRequired: true,
      productionQueueDisabled: true
    }
  });
}

export async function queueAdminDeliveryAudioJob(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  if (!processorAvailable(env)) return deliveryNotFound(request, env);
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const body = await readJsonObject(request, 20_000);
  const jobId = validIdentifier(body.jobId, "jobId");
  const expectedMasterId = validIdentifier(
    body.workingMasterId,
    "workingMasterId"
  );
  const result = await ensureDeliveryAudioJob(env, {
    episodeId: access.episode.id,
    expectedMasterId,
    jobId,
    requestedByAdminUserId: access.authorization.identity.id,
    automatedAttempt: null
  });
  if (result.status === "source_not_ready") {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_working_master_not_ready"
    );
  }
  if (result.status === "source_mismatch") {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_source_mismatch"
    );
  }
  if (result.status === "job_conflict") {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_conflict"
    );
  }
  if (result.status === "job_exists") {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_exists",
      { jobId: result.jobId }
    );
  }
  if (result.status !== "created" && result.status !== "existing") {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_conflict"
    );
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      job: result.job ? presentDeliveryJob(env, result.job) : null,
      processor: deliveryDispatch(env, result.manifest),
      idempotent: result.status === "existing"
    },
    { status: result.status === "created" ? 202 : 200 }
  );
}

export async function scheduleAutomatedDeliveryAudioJobs(
  env: PodcastEnv
): Promise<number> {
  if (!processorAvailable(env)) return 0;
  let candidates: D1Result<AutomatedDeliveryAudioCandidate>;
  try {
    candidates = await env.DB.prepare(
      AUTOMATED_DELIVERY_AUDIO_CANDIDATES_SQL
    ).bind(
      AUTOMATED_DELIVERY_AUDIO_MAX_ATTEMPTS,
      10
    ).all<AutomatedDeliveryAudioCandidate>();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "delivery_audio_automation_scan_failed",
      errorName: error instanceof Error ? error.name : "UnknownError"
    }));
    return 0;
  }
  let created = 0;
  for (const candidate of candidates.results) {
    const attempt = candidate.automated_attempt_count + 1;
    const digest = await sha256Hex([
      "podcast-delivery-audio-automation-v1",
      candidate.episode_id,
      candidate.current_master_id,
      DELIVERY_AUDIO_PROFILE,
      String(attempt)
    ].join(":"));
    try {
      const result = await ensureDeliveryAudioJob(env, {
        episodeId: candidate.episode_id,
        expectedMasterId: candidate.current_master_id,
        jobId: `delivery_audio_auto_${digest.slice(0, 32)}`,
        requestedByAdminUserId: null,
        automatedAttempt: attempt
      });
      if (result.status === "created") created += 1;
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "delivery_audio_automation_failed",
        episodeId: candidate.episode_id,
        errorName: error instanceof Error ? error.name : "UnknownError"
      }));
    }
  }
  return created;
}

async function ensureDeliveryAudioJob(
  env: PodcastEnv,
  {
    episodeId,
    expectedMasterId,
    jobId,
    requestedByAdminUserId,
    automatedAttempt
  }: {
    episodeId: string;
    expectedMasterId: string;
    jobId: string;
    requestedByAdminUserId: string | null;
    automatedAttempt: number | null;
  }
): Promise<EnsureDeliveryAudioJobResult> {
  const source = await loadDeliverySource(env.DB, episodeId);
  if (!source || source.current_master_id !== expectedMasterId) {
    return { status: "source_not_ready" };
  }
  const sourceObject = await env.MEDIA_BUCKET.head(source.source_object_key);
  if (
    !sourceObject
    || sourceObject.size !== source.source_object_bytes
    || sourceObject.httpEtag !== source.source_object_etag
    || sourceObject.httpMetadata?.contentType !== source.source_mime_type
  ) {
    return { status: "source_mismatch" };
  }
  const outputPrefix =
    `podcasts/${source.show_id}/${source.episode_id}/`
    + `delivery_audio/${jobId}`;
  const outputObjectKey = `${outputPrefix}/${jobId}.mp3`;
  const peaksObjectKey = `${outputPrefix}/${jobId}-peaks.json`;
  const manifest = await buildManifest(env, {
    id: jobId,
    ...source,
    output_object_key: outputObjectKey,
    peaks_object_key: peaksObjectKey
  });
  const prior = await loadDeliveryJob(env.DB, jobId);
  if (prior) {
    if (
      prior.episode_id !== episodeId
      || prior.source_master_id !== expectedMasterId
      || prior.processor_manifest_sha256 !== manifest.manifestSha256
    ) {
      return { status: "job_conflict" };
    }
    return { status: "existing", job: prior, manifest };
  }
  const active = await env.DB.prepare(
    `SELECT id
     FROM delivery_audio_jobs
     WHERE episode_id = ?
       AND source_master_id = ?
       AND stream_profile = ?
       AND status IN (
         'queued', 'rendering', 'completing', 'ready', 'approved'
       )
     LIMIT 1`
  ).bind(
    source.episode_id,
    source.current_master_id,
    DELIVERY_AUDIO_PROFILE
  ).first<{ id: string }>();
  if (active) return { status: "job_exists", jobId: active.id };

  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(
    outputObjectKey,
    {
      httpMetadata: {
        contentType: "audio/mpeg",
        contentDisposition: "attachment"
      },
      customMetadata: {
        "processor-manifest-sha256": manifest.manifestSha256,
        "stream-profile": DELIVERY_AUDIO_PROFILE
      }
    }
  );
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO delivery_audio_jobs (
           id, episode_id, source_master_id, source_object_key,
           source_object_bytes, source_object_etag, source_mime_type,
           source_sha256, source_duration_ms, stream_profile,
           output_object_key, r2_upload_id, peaks_object_key,
           processor_manifest_sha256, requested_by_admin_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        jobId,
        source.episode_id,
        source.current_master_id,
        source.source_object_key,
        source.source_object_bytes,
        source.source_object_etag,
        source.source_mime_type,
        source.source_sha256,
        source.source_duration_ms,
        DELIVERY_AUDIO_PROFILE,
        outputObjectKey,
        multipart.uploadId,
        peaksObjectKey,
        manifest.manifestSha256,
        requestedByAdminUserId
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: requestedByAdminUserId,
        action: "delivery_audio.queued",
        targetType: "delivery_audio_job",
        targetId: jobId,
        metadata: {
          automated: requestedByAdminUserId === null,
          automatedAttempt,
          episodeId: source.episode_id,
          sourceMasterId: source.current_master_id,
          streamProfile: DELIVERY_AUDIO_PROFILE,
          processorManifestSha256: manifest.manifestSha256
        }
      })
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      await multipart.abort();
      return { status: "job_conflict" };
    }
  } catch (error) {
    await multipart.abort().catch(() => {});
    throw error;
  }
  return {
    status: "created",
    job: await loadDeliveryJob(env.DB, jobId),
    manifest
  };
}

export async function getDeliveryAudioProcessorManifest(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const authorized = await authorizeProcessor(
    request,
    env,
    jobIdValue,
    "manifest"
  );
  if (authorized instanceof Response) return authorized;
  const manifest = await rebuildManifest(env, authorized.job);
  if (!manifest) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_manifest_mismatch"
    );
  }
  await env.DB.prepare(
    `UPDATE delivery_audio_jobs
     SET
       status = CASE WHEN status = 'queued' THEN 'rendering' ELSE status END,
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering')`
  ).bind(authorized.job.id).run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getDeliveryAudioProcessorSource(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const authorized = await authorizeProcessor(
    request,
    env,
    jobIdValue,
    "source"
  );
  if (authorized instanceof Response) return authorized;
  if (!await rebuildManifest(env, authorized.job)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_manifest_mismatch"
    );
  }
  const object = await env.MEDIA_BUCKET.get(
    authorized.job.source_object_key,
    {
      onlyIf: new Headers({
        "if-match": authorized.job.source_object_etag
      })
    }
  );
  if (
    !object
    || !("body" in object)
    || object.size !== authorized.job.source_object_bytes
    || object.httpEtag !== authorized.job.source_object_etag
    || object.httpMetadata?.contentType
      !== authorized.job.source_mime_type
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_source_mismatch"
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": authorized.job.source_mime_type,
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

export async function uploadDeliveryAudioProcessorPart(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  partNumberValue: string
): Promise<Response> {
  if (!processorAvailable(env)) return deliveryNotFound(request, env);
  const jobId = validIdentifier(jobIdValue, "jobId");
  const partNumber = positiveInteger(
    partNumberValue,
    "partNumber",
    10_000
  );
  const encodedPayload =
    request.headers.get(PROCESSOR_PART_PAYLOAD_HEADER) ?? "";
  if (
    !encodedPayload
    || encodedPayload.length > 2_000
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
  ) {
    return invalidProcessorSignature(request, env);
  }
  const verified = await verifySignedText(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    message: encodedPayload
  });
  if (!verified.ok) return invalidProcessorSignature(request, env);
  const payload = parsePartPayload(encodedPayload);
  if (payload.jobId !== jobId || payload.partNumber !== partNumber) {
    throw new RequestValidationError(
      "The delivery-audio part does not match its URL"
    );
  }
  const contentLength = positiveInteger(
    request.headers.get("content-length"),
    "Content-Length",
    MAXIMUM_PART_BYTES
  );
  if (
    !request.body
    || request.headers.get("content-type") !== "application/octet-stream"
    || contentLength !== payload.objectBytes
  ) {
    throw new RequestValidationError(
      "The delivery-audio part body does not match its signed payload"
    );
  }
  const job = await loadDeliveryJob(env.DB, jobId);
  if (
    !job
    || !jobCurrent(job)
    || !["queued", "rendering"].includes(job.status)
    || payload.manifestSha256 !== job.processor_manifest_sha256
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_not_processable"
    );
  }
  const prior = await loadPart(env.DB, jobId, partNumber);
  if (
    prior
    && prior.uploaded_bytes === payload.objectBytes
    && prior.sha256 === payload.sha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      jobId,
      partNumber,
      etag: prior.etag,
      uploadedBytes: prior.uploaded_bytes,
      checksumVerified: true,
      idempotent: true
    });
  }
  const bytes = await readBoundedBytes(
    request,
    MAXIMUM_PART_BYTES,
    "Delivery-audio multipart part"
  );
  if (
    bytes.byteLength !== contentLength
    || await sha256BytesHex(bytes) !== payload.sha256
  ) {
    throw new RequestValidationError(
      "The delivery-audio part checksum does not match its signed payload"
    );
  }
  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.MEDIA_BUCKET.resumeMultipartUpload(
      job.output_object_key,
      job.r2_upload_id
    ).uploadPart(partNumber, bytes);
  } catch {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_multipart_unavailable"
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO delivery_audio_job_parts (
         job_id, part_number, etag, uploaded_bytes, sha256
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id, part_number) DO UPDATE SET
         etag = excluded.etag,
         uploaded_bytes = excluded.uploaded_bytes,
         sha256 = excluded.sha256,
         uploaded_at = datetime('now')`
    ).bind(
      jobId,
      uploaded.partNumber,
      uploaded.etag,
      contentLength,
      payload.sha256
    ),
    env.DB.prepare(
      `UPDATE delivery_audio_jobs
       SET status = 'rendering', updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(jobId)
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    jobId,
    partNumber: uploaded.partNumber,
    etag: uploaded.etag,
    uploadedBytes: contentLength,
    checksumVerified: true,
    idempotent: false
  });
}

export async function completeDeliveryAudioMultipartUpload(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "Delivery-audio multipart evidence"
  );
  if (signed instanceof Response) return signed;
  const jobId = validIdentifier(jobIdValue, "jobId");
  const job = await loadDeliveryJob(env.DB, jobId);
  if (!job || !jobCurrent(job)) return deliveryNotFound(request, env);
  const evidence = multipartEvidence(signed.body, jobId);
  if (evidence.manifestSha256 !== job.processor_manifest_sha256) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_manifest_mismatch"
    );
  }
  const existing = await env.MEDIA_BUCKET.head(job.output_object_key);
  if (validCompletedObject(existing, job, evidence.objectBytes)) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      jobId,
      objectBytes: existing!.size,
      etag: existing!.httpEtag,
      outputSha256: evidence.outputSha256,
      multipartCompleted: true,
      idempotent: true
    });
  }
  if (!["queued", "rendering", "completing"].includes(job.status)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_not_processable"
    );
  }
  const parts = await listParts(env.DB, jobId);
  validateCompleteParts(parts, evidence);
  await env.DB.prepare(
    `UPDATE delivery_audio_jobs
     SET status = 'completing', updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering', 'completing')`
  ).bind(jobId).run();
  let object: R2Object | null;
  try {
    object = await completeMultipartUploadAndHead(
      env.MEDIA_BUCKET,
      job.output_object_key,
      job.r2_upload_id,
      parts.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag
      }))
    );
  } catch {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_multipart_completion_failed"
    );
  }
  if (!validCompletedObject(object, job, evidence.objectBytes)) {
    await env.MEDIA_BUCKET.delete(job.output_object_key);
    return failDeliveryJob(request, env, job, "audio_invalid");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    jobId,
    objectBytes: object!.size,
    etag: object!.httpEtag,
    outputSha256: evidence.outputSha256,
    multipartCompleted: true,
    idempotent: false
  });
}

export async function completeDeliveryAudioJob(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "Delivery-audio processor evidence"
  );
  if (signed instanceof Response) return signed;
  const jobId = validIdentifier(jobIdValue, "jobId");
  const job = await loadDeliveryJob(env.DB, jobId);
  if (!job) return deliveryNotFound(request, env);
  if (
    signed.body.jobId !== jobId
    || signed.body.manifestSha256 !== job.processor_manifest_sha256
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_manifest_mismatch"
    );
  }
  if (signed.body.status === "failed") {
    const failureCode = String(signed.body.failureCode ?? "");
    if (!FAILURE_CODES.has(failureCode)) {
      throw new RequestValidationError("failureCode is invalid");
    }
    return failDeliveryJob(request, env, job, failureCode);
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("status is invalid");
  }
  const manifest = await rebuildManifest(env, job);
  if (!manifest || !jobCurrent(job)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_not_processable"
    );
  }
  let report: DeliveryAudioReport;
  let peaks: PlayerPeaksDocument;
  let reportSha256: string;
  let peaksSha256: string;
  try {
    report = await validateDeliveryAudioReport(
      signed.body.report,
      manifest
    );
    peaks = validatePlayerPeaksDocument(signed.body.peaks);
    reportSha256 = await deliveryAudioReportSha256(report, manifest);
    peaksSha256 = await playerPeaksSha256(peaks);
  } catch {
    throw new RequestValidationError(
      "Delivery-audio evidence is invalid",
      "invalid_delivery_audio_report"
    );
  }
  const peaksText = JSON.stringify(peaks);
  const peaksBytes = new TextEncoder().encode(peaksText);
  if (
    signed.body.reportSha256 !== reportSha256
    || report.peaks.sha256 !== peaksSha256
    || report.peaks.objectBytes !== peaksBytes.byteLength
    || report.peaks.length !== peaks.length
    || report.peaks.dataPointCount !== peaks.data.length
  ) {
    throw new RequestValidationError(
      "Delivery-audio evidence digest is invalid",
      "invalid_delivery_audio_report"
    );
  }
  if (
    job.status === "ready"
    && job.processor_report_sha256 === reportSha256
    && job.peaks_sha256 === peaksSha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentDeliveryJob(env, job),
      idempotent: true
    });
  }
  if (!["rendering", "completing"].includes(job.status)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_not_processable"
    );
  }
  const audioObject = await env.MEDIA_BUCKET.head(job.output_object_key);
  if (!validCompletedObject(audioObject, job, report.audio.objectBytes)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_output_mismatch"
    );
  }
  const peaksObject = await env.MEDIA_BUCKET.put(
    job.peaks_object_key,
    peaksBytes,
    {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "public, max-age=300, stale-while-revalidate=86400"
      },
      customMetadata: {
        jobId,
        "processor-manifest-sha256": manifest.manifestSha256,
        "audio-sha256": report.audio.sha256,
        "peaks-sha256": peaksSha256
      }
    }
  );
  if (peaksObject.size !== peaksBytes.byteLength) {
    await env.MEDIA_BUCKET.delete(job.peaks_object_key);
    return failDeliveryJob(request, env, job, "peaks_invalid");
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE delivery_audio_jobs
       SET
         status = 'ready',
         output_object_bytes = ?,
         output_object_etag = ?,
         output_sha256 = ?,
         output_duration_ms = ?,
         peaks_object_bytes = ?,
         peaks_object_etag = ?,
         peaks_sha256 = ?,
         peaks_length = ?,
         processor_version = ?,
         processor_report_json = ?,
         processor_report_sha256 = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('rendering', 'completing')
         AND processor_manifest_sha256 = ?`
    ).bind(
      report.audio.objectBytes,
      audioObject!.httpEtag,
      report.audio.sha256,
      report.audio.durationMs,
      peaksObject.size,
      peaksObject.httpEtag,
      peaksSha256,
      peaks.length,
      report.processorVersion,
      JSON.stringify(report),
      reportSha256,
      jobId,
      manifest.manifestSha256
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: job.requested_by_admin_user_id,
      action: "delivery_audio.ready",
      targetType: "delivery_audio_job",
      targetId: jobId,
      metadata: {
        episodeId: job.episode_id,
        sourceMasterId: job.source_master_id,
        outputBytes: report.audio.objectBytes,
        outputSha256: report.audio.sha256,
        peaksSha256,
        peaksLength: peaks.length,
        processorReportSha256: reportSha256
      }
    })
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    await env.MEDIA_BUCKET.delete(job.peaks_object_key).catch(() => {});
    return deliveryConflict(
      request,
      env,
      "delivery_audio_completion_conflict"
    );
  }
  const ready = await loadDeliveryJob(env.DB, jobId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: ready ? presentDeliveryJob(env, ready) : null,
    idempotent: false
  });
}

export async function approveAdminDeliveryAudioJob(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const jobId = validIdentifier(jobIdValue, "jobId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const recentError = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recentError) return recentError;
  const job = await loadDeliveryJob(env.DB, jobId);
  if (
    !job
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      ["super_admin"],
      job.show_id
    )
  ) {
    return deliveryNotFound(request, env);
  }
  if (
    job.status === "approved"
    && job.current_audio_key === job.output_object_key
    && job.current_audio_bytes === job.output_object_bytes
    && job.current_audio_etag === job.output_object_etag
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentDeliveryJob(env, job),
      idempotent: true
    });
  }
  if (
    job.status !== "ready"
    || !jobCurrent(job)
    || !job.output_object_bytes
    || !job.output_object_etag
    || !job.output_duration_ms
    || !job.peaks_object_bytes
    || !job.peaks_object_etag
    || !job.peaks_sha256
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_not_approvable"
    );
  }
  const body = await readJsonObject(request, 20_000);
  const expectedMasterId = validIdentifier(
    body.workingMasterId,
    "workingMasterId"
  );
  const approvalReason = requiredText(
    body.approvalReason,
    "approvalReason",
    500
  );
  if (
    expectedMasterId !== job.source_master_id
    || approvalReason.length < 10
  ) {
    throw new RequestValidationError(
      "Approval must bind the current master and include a reason"
    );
  }
  const [audioObject, peaksObject] = await Promise.all([
    env.MEDIA_BUCKET.head(job.output_object_key),
    env.MEDIA_BUCKET.head(job.peaks_object_key)
  ]);
  if (
    !validCompletedObject(
      audioObject,
      job,
      job.output_object_bytes
    )
    || audioObject!.httpEtag !== job.output_object_etag
    || !validPeaksObject(peaksObject, job)
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_output_mismatch"
    );
  }
  const durationSeconds = Math.max(
    1,
    Math.round(job.output_duration_ms / 1_000)
  );
  const episodeGuardId =
    `delivery_episode_guard_${crypto.randomUUID().replace(/-/g, "")}`;
  const jobGuardId =
    `delivery_job_guard_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE episodes
         SET
           audio_key = ?,
           audio_mime_type = 'audio/mpeg',
           audio_bytes = ?,
           audio_etag = ?,
           audio_filename = ?,
           duration_seconds = ?,
           media_status = 'ready',
           updated_at = datetime('now')
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM episode_working_master_states state
             WHERE state.episode_id = episodes.id
               AND state.current_master_id = ?
           )`
      ).bind(
        job.output_object_key,
        job.output_object_bytes,
        job.output_object_etag,
        safeDownloadFilename(`${job.episode_slug}.mp3`),
        durationSeconds,
        job.episode_id,
        job.source_master_id
      ),
      env.DB.prepare(
        `INSERT INTO publication_batch_guards (id, update_succeeded)
         VALUES (?, changes())`
      ).bind(episodeGuardId),
      env.DB.prepare(
        `UPDATE delivery_audio_jobs
         SET
           status = 'approved',
           approved_by_admin_user_id = ?,
           approval_reason = ?,
           approved_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?
           AND status = 'ready'
           AND source_master_id = ?`
      ).bind(
        auth.authorization.identity.id,
        approvalReason,
        jobId,
        job.source_master_id
      ),
      env.DB.prepare(
        `INSERT INTO publication_batch_guards (id, update_succeeded)
         VALUES (?, changes())`
      ).bind(jobGuardId),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "delivery_audio.approved",
        targetType: "delivery_audio_job",
        targetId: jobId,
        metadata: {
          episodeId: job.episode_id,
          sourceMasterId: job.source_master_id,
          streamProfile: DELIVERY_AUDIO_PROFILE,
          outputBytes: job.output_object_bytes,
          outputSha256: job.output_sha256,
          peaksSha256: job.peaks_sha256,
          processorReportSha256: job.processor_report_sha256
        }
      }),
      prepareResolveDeliveryAudioAction(env.DB, jobId),
      env.DB.prepare(
        `DELETE FROM publication_batch_guards WHERE id = ?`
      ).bind(episodeGuardId),
      env.DB.prepare(
        `DELETE FROM publication_batch_guards WHERE id = ?`
      ).bind(jobGuardId)
    ]);
  } catch (error) {
    const message = String(error);
    if (
      message.includes("publication_batch_guards")
      || message.includes("update_succeeded")
    ) {
      return deliveryConflict(
        request,
        env,
        "delivery_audio_approval_conflict"
      );
    }
    throw error;
  }
  const approved = await loadDeliveryJob(env.DB, jobId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: approved ? presentDeliveryJob(env, approved) : null,
    idempotent: false
  });
}

export async function serveAdminDeliveryAudioJob(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const job = await authorizeAdminJob(
    request,
    env,
    jobIdValue,
    ["ready", "approved"]
  );
  if (job instanceof Response) return job;
  return serveDeliveryAudioObject(request, env, job);
}

export async function serveAdminDeliveryAudioPeaks(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const job = await authorizeAdminJob(
    request,
    env,
    jobIdValue,
    ["ready", "approved"]
  );
  if (job instanceof Response) return job;
  return servePeaksObject(request, env, job, "private");
}

export async function servePublicEpisodePeaks(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const job = await env.DB.prepare(
    `${deliveryJobSelect()}
     WHERE job.episode_id = ?
       AND job.status = 'approved'
       AND episode.status = 'published'
       AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
       AND episode.access IN ('public', 'early_access', 'free_mini')
       AND episode.media_status = 'ready'
       AND episode.audio_key = job.output_object_key
       AND episode.audio_bytes = job.output_object_bytes
       AND episode.audio_etag = job.output_object_etag
       AND EXISTS (
         SELECT 1
         FROM shows public_show
         WHERE public_show.id = episode.show_id
           AND public_show.test_fixture = 0
       )
     LIMIT 1`
  ).bind(episodeId).first<DeliveryJobRow>();
  if (!job) return publicPeaksNotFound();
  return servePeaksObject(request, env, job, "public");
}

async function authorizeAdminJob(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  statuses: string[]
): Promise<DeliveryJobRow | Response> {
  const jobId = validIdentifier(jobIdValue, "jobId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES
  });
  if (!auth.ok) return auth.response;
  const job = await loadDeliveryJob(env.DB, jobId);
  if (
    !job
    || !statuses.includes(job.status)
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      READ_ROLES,
      job.show_id
    )
  ) {
    return deliveryNotFound(request, env);
  }
  return job;
}

async function serveDeliveryAudioObject(
  request: Request,
  env: PodcastEnv,
  job: DeliveryJobRow
): Promise<Response> {
  if (!job.output_object_bytes || !job.output_object_etag) {
    return deliveryNotFound(request, env);
  }
  const head = await env.MEDIA_BUCKET.head(job.output_object_key);
  if (
    !validCompletedObject(head, job, job.output_object_bytes)
    || head!.httpEtag !== job.output_object_etag
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_output_mismatch"
    );
  }
  const headers = privateMediaHeaders(
    request,
    env,
    head!.httpEtag,
    "audio/mpeg"
  );
  headers.set(
    "content-disposition",
    new URL(request.url).searchParams.get("download") === "1"
      ? `attachment; filename="${safeDownloadFilename(
          `${job.episode_slug}.mp3`
        )}"`
      : "inline"
  );
  if (request.headers.get("if-none-match") === head!.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(job.output_object_bytes));
    return new Response(null, { headers });
  }
  const range = requestedMediaRange(
    request,
    job.output_object_bytes,
    head!.httpEtag
  );
  if (range === "invalid") {
    headers.set("content-range", `bytes */${job.output_object_bytes}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await env.MEDIA_BUCKET.get(job.output_object_key, {
    ...(range ? { range } : {}),
    onlyIf: new Headers({ "if-match": head!.httpEtag })
  });
  if (
    !object
    || !("body" in object)
    || object.size !== job.output_object_bytes
    || object.httpEtag !== head!.httpEtag
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_output_mismatch"
    );
  }
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-length", String(length));
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${job.output_object_bytes}`
    );
  } else {
    headers.set("content-length", String(job.output_object_bytes));
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers
  });
}

async function servePeaksObject(
  request: Request,
  env: PodcastEnv,
  job: DeliveryJobRow,
  visibility: "private" | "public"
): Promise<Response> {
  if (
    !job.peaks_object_bytes
    || !job.peaks_object_etag
    || !job.peaks_sha256
  ) {
    return visibility === "public"
      ? publicPeaksNotFound()
      : deliveryNotFound(request, env);
  }
  const head = await env.MEDIA_BUCKET.head(job.peaks_object_key);
  if (!validPeaksObject(head, job)) {
    return visibility === "public"
      ? publicPeaksNotFound()
      : deliveryConflict(
          request,
          env,
          "delivery_audio_peaks_mismatch"
        );
  }
  const headers = visibility === "private"
    ? privateMediaHeaders(
        request,
        env,
        head!.httpEtag,
        "application/json"
      )
    : new Headers({
        "content-type": "application/json",
        "cache-control": "public, max-age=300, stale-while-revalidate=86400",
        etag: head!.httpEtag,
        "access-control-allow-origin": "*",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      });
  if (request.headers.get("if-none-match") === head!.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(head!.size));
    return new Response(null, { headers });
  }
  const object = await env.MEDIA_BUCKET.get(job.peaks_object_key, {
    onlyIf: new Headers({ "if-match": head!.httpEtag })
  });
  if (
    !object
    || !("body" in object)
    || object.size !== job.peaks_object_bytes
    || object.httpEtag !== job.peaks_object_etag
  ) {
    return visibility === "public"
      ? publicPeaksNotFound()
      : deliveryConflict(
          request,
          env,
          "delivery_audio_peaks_mismatch"
        );
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

async function authorizeProcessor(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  action: "manifest" | "source"
): Promise<{ job: DeliveryJobRow } | Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    `Delivery-audio ${action} request`,
    10_000
  );
  if (signed instanceof Response) return signed;
  const jobId = validIdentifier(jobIdValue, "jobId");
  if (signed.body.jobId !== jobId || signed.body.action !== action) {
    throw new RequestValidationError(
      `The ${action} request does not match its URL or action`
    );
  }
  const job = await loadDeliveryJob(env.DB, jobId);
  if (
    !job
    || !jobCurrent(job)
    || !["queued", "rendering"].includes(job.status)
  ) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_job_not_processable"
    );
  }
  return { job };
}

async function signedProcessorJson(
  request: Request,
  env: PodcastEnv,
  bodyName: string,
  maximumBytes = MAXIMUM_PROCESSOR_BODY_BYTES
): Promise<{ body: Record<string, unknown> } | Response> {
  if (!processorAvailable(env)) return deliveryNotFound(request, env);
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    maximumBytes,
    bodyName,
    invalidBodyCode: "invalid_delivery_audio_processor_body"
  });
  if (!signed.ok) {
    return signed.reason === "secret_missing"
      ? deliveryNotFound(request, env)
      : invalidProcessorSignature(request, env);
  }
  return signed;
}

async function buildManifest(
  env: PodcastEnv,
  job: {
    id: string;
    episode_id: string;
    show_id: string;
    current_master_id?: string | null;
    source_master_id?: string;
    source_object_key: string;
    source_object_bytes: number;
    source_object_etag: string;
    source_mime_type: string;
    source_sha256: string;
    source_duration_ms: number;
    output_object_key: string;
    peaks_object_key: string;
  }
): Promise<DeliveryAudioManifest> {
  const origin = env.FEED_ORIGIN.replace(/\/$/, "");
  const base = `${origin}/v1/processor/delivery-audio-jobs/${job.id}`;
  return buildDeliveryAudioManifest({
    schemaVersion: "podcast-delivery-audio-job-v1",
    jobId: job.id,
    episodeId: job.episode_id,
    showId: job.show_id,
    source: {
      workingMasterId:
        job.source_master_id ?? job.current_master_id ?? "",
      bucketName: env.MEDIA_BUCKET_NAME || "",
      objectKey: job.source_object_key,
      objectBytes: job.source_object_bytes,
      etag: job.source_object_etag,
      mimeType: job.source_mime_type,
      sha256: job.source_sha256,
      durationMs: job.source_duration_ms
    },
    profile: {
      id: DELIVERY_AUDIO_PROFILE,
      codec: "mp3",
      sampleRateHz: 44_100,
      channels: 2,
      bitrateKbps: 128,
      writeXing: false
    },
    output: {
      objectKey: job.output_object_key,
      mimeType: "audio/mpeg",
      recommendedPartBytes: RECOMMENDED_PART_BYTES
    },
    peaks: {
      objectKey: job.peaks_object_key,
      schemaVersion: "dustwave-player-peaks-v1",
      mimeType: "application/json",
      maximumLength: 8_192
    },
    endpoints: {
      source: `${base}/source`,
      partTemplate: `${base}/parts/{partNumber}`,
      uploadComplete: `${base}/upload-complete`,
      evidenceComplete: `${base}/complete`
    }
  });
}

async function rebuildManifest(
  env: PodcastEnv,
  job: DeliveryJobRow
): Promise<DeliveryAudioManifest | null> {
  const manifest = await buildManifest(env, job);
  return manifest.manifestSha256 === job.processor_manifest_sha256
    ? manifest
    : null;
}

async function loadDeliverySource(
  db: D1Database,
  episodeId: string
): Promise<DeliverySourceRow | null> {
  return db.prepare(
    `SELECT
       episode.id AS episode_id,
       episode.show_id,
       state.current_master_id,
       master.object_key AS source_object_key,
       master.object_bytes AS source_object_bytes,
       master.object_etag AS source_object_etag,
       master.mime_type AS source_mime_type,
       master.source_sha256,
       qc.duration_ms AS source_duration_ms
     FROM episodes episode
     JOIN episode_working_master_states state
       ON state.episode_id = episode.id
     JOIN episode_working_masters master
       ON master.id = state.current_master_id
      AND master.episode_id = episode.id
     JOIN audio_qc_runs qc
       ON qc.id = master.quality_control_run_id
      AND qc.status = 'succeeded'
      AND qc.blocker_count = 0
      AND qc.source_sha256 = master.source_sha256
      AND qc.report_sha256 = master.quality_control_report_sha256
     JOIN show_audio_qc_policies policy
       ON policy.show_id = episode.show_id
      AND policy.revision = qc.policy_revision
     WHERE episode.id = ?`
  ).bind(episodeId).first<DeliverySourceRow>();
}

function deliveryJobSelect(): string {
  return `SELECT
     job.id,
     job.episode_id,
     episode.show_id,
     episode.slug AS episode_slug,
     job.source_master_id,
     job.source_object_key,
     job.source_object_bytes,
     job.source_object_etag,
     job.source_mime_type,
     job.source_sha256,
     job.source_duration_ms,
     job.stream_profile,
     job.output_object_key,
     job.r2_upload_id,
     job.peaks_object_key,
     job.processor_manifest_sha256,
     job.status,
     job.output_object_bytes,
     job.output_object_etag,
     job.output_sha256,
     job.output_duration_ms,
     job.peaks_object_bytes,
     job.peaks_object_etag,
     job.peaks_sha256,
     job.peaks_length,
     job.processor_version,
     job.processor_report_json,
     job.processor_report_sha256,
     job.failure_code,
     job.requested_by_admin_user_id,
     job.requested_at,
     job.completed_at,
     job.approved_at,
     job.approval_reason,
     state.current_master_id,
     episode.audio_key AS current_audio_key,
     episode.audio_bytes AS current_audio_bytes,
     episode.audio_etag AS current_audio_etag
   FROM delivery_audio_jobs job
   JOIN episodes episode ON episode.id = job.episode_id
   JOIN episode_working_master_states state
     ON state.episode_id = job.episode_id`;
}

async function loadDeliveryJob(
  db: D1Database,
  jobId: string
): Promise<DeliveryJobRow | null> {
  return db.prepare(
    `${deliveryJobSelect()} WHERE job.id = ?`
  ).bind(jobId).first<DeliveryJobRow>();
}

async function loadPart(
  db: D1Database,
  jobId: string,
  partNumber: number
): Promise<DeliveryPartRow | null> {
  return db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM delivery_audio_job_parts
     WHERE job_id = ? AND part_number = ?`
  ).bind(jobId, partNumber).first<DeliveryPartRow>();
}

async function listParts(
  db: D1Database,
  jobId: string
): Promise<DeliveryPartRow[]> {
  const rows = await db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM delivery_audio_job_parts
     WHERE job_id = ?
     ORDER BY part_number`
  ).bind(jobId).all<DeliveryPartRow>();
  return rows.results;
}

async function failDeliveryJob(
  request: Request,
  env: PodcastEnv,
  job: DeliveryJobRow,
  failureCode: string
): Promise<Response> {
  if (job.status === "failed") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentDeliveryJob(env, job),
      idempotent: true
    });
  }
  if (["ready", "approved", "stale"].includes(job.status)) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_completion_conflict"
    );
  }
  try {
    await env.MEDIA_BUCKET.resumeMultipartUpload(
      job.output_object_key,
      job.r2_upload_id
    ).abort();
  } catch {
    await env.MEDIA_BUCKET.delete(job.output_object_key).catch(() => {});
  }
  await env.MEDIA_BUCKET.delete(job.peaks_object_key).catch(() => {});
  const result = await env.DB.prepare(
    `UPDATE delivery_audio_jobs
     SET
       status = 'failed',
       failure_code = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering', 'completing')`
  ).bind(failureCode, job.id).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    return deliveryConflict(
      request,
      env,
      "delivery_audio_completion_conflict"
    );
  }
  const failed = await loadDeliveryJob(env.DB, job.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: failed ? presentDeliveryJob(env, failed) : null,
    idempotent: false
  });
}

function parsePartPayload(encoded: string): {
  jobId: string;
  partNumber: number;
  objectBytes: number;
  sha256: string;
  manifestSha256: string;
} {
  let value: Record<string, unknown>;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - encoded.length % 4) % 4);
    value = JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(
      "The delivery-audio part payload is invalid"
    );
  }
  return {
    jobId: validIdentifier(value.jobId, "jobId"),
    partNumber: positiveInteger(
      value.partNumber,
      "partNumber",
      10_000
    ),
    objectBytes: positiveInteger(
      value.objectBytes,
      "objectBytes",
      MAXIMUM_PART_BYTES
    ),
    sha256: requiredSha256(value.sha256, "sha256"),
    manifestSha256: requiredSha256(
      value.manifestSha256,
      "manifestSha256"
    )
  };
}

function multipartEvidence(
  body: Record<string, unknown>,
  jobId: string
): {
  objectBytes: number;
  outputSha256: string;
  partCount: number;
  manifestSha256: string;
} {
  if (body.jobId !== jobId || body.action !== "upload-complete") {
    throw new RequestValidationError(
      "The multipart evidence does not match its URL"
    );
  }
  return {
    objectBytes: positiveInteger(
      body.objectBytes,
      "objectBytes",
      MAXIMUM_OUTPUT_BYTES
    ),
    outputSha256: requiredSha256(
      body.outputSha256,
      "outputSha256"
    ),
    partCount: positiveInteger(body.partCount, "partCount", 10_000),
    manifestSha256: requiredSha256(
      body.manifestSha256,
      "manifestSha256"
    )
  };
}

function validateCompleteParts(
  parts: DeliveryPartRow[],
  evidence: { objectBytes: number; partCount: number }
): void {
  if (parts.length !== evidence.partCount || parts.length === 0) {
    throw new RequestValidationError(
      "The multipart part count is incomplete"
    );
  }
  let total = 0;
  parts.forEach((part, index) => {
    if (
      part.part_number !== index + 1
      || (
        index < parts.length - 1
        && part.uploaded_bytes < MINIMUM_MULTIPART_PART_BYTES
      )
    ) {
      throw new RequestValidationError(
        "The multipart part ordering or size is invalid"
      );
    }
    total += part.uploaded_bytes;
  });
  if (total !== evidence.objectBytes) {
    throw new RequestValidationError(
      "The multipart byte count is invalid"
    );
  }
}

function validCompletedObject(
  object: R2Object | null,
  job: Pick<
    DeliveryJobRow,
    "processor_manifest_sha256" | "stream_profile"
  >,
  expectedBytes: number | null
): boolean {
  return Boolean(
    object
    && expectedBytes
    && object.size === expectedBytes
    && object.httpMetadata?.contentType === "audio/mpeg"
    && object.customMetadata?.["processor-manifest-sha256"]
      === job.processor_manifest_sha256
    && object.customMetadata?.["stream-profile"] === job.stream_profile
  );
}

function validPeaksObject(
  object: R2Object | null,
  job: DeliveryJobRow
): boolean {
  return Boolean(
    object
    && job.peaks_object_bytes
    && job.peaks_object_etag
    && job.peaks_sha256
    && object.size === job.peaks_object_bytes
    && object.httpEtag === job.peaks_object_etag
    && object.httpMetadata?.contentType === "application/json"
    && object.customMetadata?.jobId === job.id
    && object.customMetadata?.["processor-manifest-sha256"]
      === job.processor_manifest_sha256
    && object.customMetadata?.["peaks-sha256"] === job.peaks_sha256
  );
}

function jobCurrent(job: DeliveryJobRow): boolean {
  return job.current_master_id === job.source_master_id;
}

function presentDeliveryJob(
  env: PodcastEnv,
  job: DeliveryJobRow
): Record<string, unknown> {
  const playable = ["ready", "approved"].includes(job.status)
    && Boolean(job.output_object_bytes && job.output_object_etag);
  const current = jobCurrent(job);
  const approvedCurrent = job.status === "approved"
    && job.current_audio_key === job.output_object_key
    && job.current_audio_bytes === job.output_object_bytes
    && job.current_audio_etag === job.output_object_etag;
  return {
    id: job.id,
    episodeId: job.episode_id,
    sourceMasterId: job.source_master_id,
    current,
    streamProfile: job.stream_profile,
    status: job.status,
    failureCode: job.failure_code,
    requestedAt: job.requested_at,
    completedAt: job.completed_at,
    approvedAt: job.approved_at,
    approvalReason: job.approval_reason,
    output: job.output_object_bytes
      ? {
          bytes: job.output_object_bytes,
          sha256: job.output_sha256,
          durationMs: job.output_duration_ms,
          mimeType: "audio/mpeg",
          mediaPath: playable
            ? `/v1/admin/delivery-audio-jobs/${job.id}/media`
            : null,
          downloadPath: playable
            ? `/v1/admin/delivery-audio-jobs/${job.id}/media?download=1`
            : null
        }
      : null,
    peaks: job.peaks_object_bytes
      ? {
          bytes: job.peaks_object_bytes,
          sha256: job.peaks_sha256,
          length: job.peaks_length,
          path: playable
            ? `/v1/admin/delivery-audio-jobs/${job.id}/peaks`
            : null
        }
      : null,
    processor: {
      version: job.processor_version,
      reportSha256: job.processor_report_sha256
    },
    approval: {
      eligible: env.ENVIRONMENT === "staging"
        && job.status === "ready"
        && current
        && Boolean(job.output_object_bytes)
        && Boolean(job.peaks_object_bytes),
      approvedCurrent
    }
  };
}

function deliveryDispatch(
  env: PodcastEnv,
  manifest: DeliveryAudioManifest
): Record<string, unknown> {
  const processor = describeProcessorAvailability(
    env,
    processorAvailable(env)
  );
  return {
    workflow: "process-delivery-audio.yml",
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256,
    dispatchMode: processor.mode,
    manualDispatchOnly: processor.mode !== "staging_automatic"
  };
}

function processorAvailable(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET)
    && Boolean(env.MEDIA_BUCKET_NAME);
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new RequestValidationError(`${label} must be a SHA-256 digest`);
  }
  return digest;
}

function privateMediaHeaders(
  request: Request,
  env: PodcastEnv,
  etag: string,
  contentType: string
): Headers {
  const headers = new Headers(
    privateCorsHeaders(request, env.ALLOWED_ORIGINS)
  );
  headers.set("content-type", contentType);
  headers.set("accept-ranges", contentType === "audio/mpeg" ? "bytes" : "none");
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("etag", etag);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return headers;
}

function invalidProcessorSignature(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "invalid_processor_signature" },
    { status: 401 }
  );
}

function deliveryNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "delivery_audio_job_not_found" },
    { status: 404 }
  );
}

function deliveryConflict(
  request: Request,
  env: PodcastEnv,
  error: string,
  detail: Record<string, unknown> = {}
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error, ...detail },
    { status: 409 }
  );
}

function publicPeaksNotFound(): Response {
  return new Response(JSON.stringify({ error: "media_not_found" }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
