import {
  AUDIO_ENHANCEMENT_DERIVATIVE_RECIPE_SCHEMA,
  audioEnhancementDerivativeReportSha256,
  buildAudioEnhancementDerivativeManifest,
  validateAudioEnhancementDerivativeRecipe,
  validateAudioEnhancementDerivativeReport,
  type AudioEnhancementDerivativeManifest,
  type AudioEnhancementDerivativeRecipe,
  type AudioEnhancementDerivativeReport
} from "@dustwave/media-core/audio-enhancement-derivative";
import {
  buildAudioQcManifest,
  type AudioQcManifest,
  type AudioQcPolicy
} from "@dustwave/media-core/audio-qc";
import {
  sha256BytesHex,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import type { PodcastEnv } from "./env";
import {
  privateCorsHeaders,
  privateJson
} from "./http";
import {
  requestedMediaRange,
  safeDownloadFilename
} from "./media-range";
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
const APPROVE_ROLES: AdminRole[] = ["super_admin"];
const PROCESSOR_TIMESTAMP_HEADER = "x-podcast-processor-timestamp";
const PROCESSOR_SIGNATURE_HEADER = "x-podcast-processor-signature";
const PROCESSOR_PART_PAYLOAD_HEADER =
  "x-podcast-processor-part-payload";
const MAXIMUM_PROCESSOR_BODY_BYTES = 125_000;
const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_PART_BYTES = 32 * 1024 * 1024;
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const RECOMMENDED_PART_BYTES = 33_554_432 as const;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "render_failed",
  "output_invalid",
  "multipart_unavailable"
]);

type DerivativeSourceRow = {
  episode_id: string;
  show_id: string;
  source_duration_ms: number;
  current_master_id: string;
  source_upload_id: string;
  source_quality_control_run_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  source_quality_control_report_sha256: string;
  selected_preview_id: string;
  selected_preview_manifest_sha256: string;
  selected_preview_report_sha256: string;
  selected_preview_enhanced_sha256: string;
  preview_recipe_json: string;
};

type DerivativeRow = {
  id: string;
  episode_id: string;
  show_id: string;
  selected_preview_id: string;
  source_master_id: string;
  source_upload_id: string;
  source_quality_control_run_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  source_quality_control_report_sha256: string;
  selected_preview_manifest_sha256: string;
  selected_preview_report_sha256: string;
  selected_preview_enhanced_sha256: string;
  recipe_json: string;
  recipe_sha256: string;
  output_object_key: string;
  r2_upload_id: string;
  processor_manifest_sha256: string;
  status: string;
  output_upload_id: string | null;
  derivative_quality_control_run_id: string | null;
  output_object_bytes: number | null;
  output_object_etag: string | null;
  output_sha256: string | null;
  output_duration_ms: number | null;
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
  source_duration_ms: number;
  quality_control_status: string | null;
  quality_control_policy_revision: number | null;
  current_policy_revision: number;
  quality_control_source_sha256: string | null;
  quality_control_report_sha256: string | null;
  quality_control_blocker_count: number | null;
  quality_control_warning_count: number | null;
  quality_control_completed_at: string | null;
};

type DerivativePartRow = {
  part_number: number;
  etag: string;
  uploaded_bytes: number;
  sha256: string;
};

type AudioQcPolicyRow = {
  revision: number;
  mono_integrated_lufs: number;
  stereo_integrated_lufs: number;
  integrated_lufs_tolerance: number;
  maximum_true_peak_dbtp: number;
  maximum_dc_offset: number;
  maximum_channel_imbalance_lu: number;
  maximum_leading_silence_ms: number;
  maximum_trailing_silence_ms: number;
  maximum_internal_silence_ms: number;
  silence_threshold_db: number;
};

export async function listAdminAudioEnhancementDerivatives(
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
    `${derivativeSelect()}
     WHERE derivative.episode_id = ?
     ORDER BY derivative.requested_at DESC, derivative.id DESC
     LIMIT 20`
  ).bind(access.episode.id).all<DerivativeRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    derivatives: rows.results.map((row) => presentDerivative(env, row)),
    processor: {
      available: processorAvailable(env),
      mode: env.ENVIRONMENT === "staging"
        ? "staging_manual"
        : "unavailable"
    },
    safeguards: {
      selectedReadyPreviewRequired: true,
      currentMasterSnapshotRequired: true,
      fullLengthQualityControlRequired: true,
      explicitSuperAdminApprovalRequired: true,
      rendererCannotReplaceMaster: true
    }
  });
}

export async function queueAdminAudioEnhancementDerivative(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  if (!processorAvailable(env)) return derivativeNotFound(request, env);
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
  const previewId = validIdentifier(body.previewId, "previewId");
  const source = await loadDerivativeSource(
    env.DB,
    access.episode.id,
    previewId
  );
  if (!source) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_source_not_ready"
    );
  }
  const sourceObject = await env.MEDIA_BUCKET.head(source.source_object_key);
  if (
    !sourceObject
    || sourceObject.size !== source.source_object_bytes
    || sourceObject.httpEtag !== source.source_object_etag
    || sourceObject.httpMetadata?.contentType !== source.source_mime_type
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_source_mismatch"
    );
  }
  const previewRecipe = JSON.parse(source.preview_recipe_json) as {
    presetId?: unknown;
    targetIntegratedLufs?: unknown;
    maximumTruePeakDbtp?: unknown;
  };
  const recipe = validateAudioEnhancementDerivativeRecipe({
    schemaVersion: AUDIO_ENHANCEMENT_DERIVATIVE_RECIPE_SCHEMA,
    presetId: previewRecipe.presetId,
    targetIntegratedLufs: previewRecipe.targetIntegratedLufs,
    maximumTruePeakDbtp: previewRecipe.maximumTruePeakDbtp
  });
  const recipeSha256 = await sha256Hex(JSON.stringify(recipe));
  const outputObjectKey =
    `podcasts/${source.show_id}/${source.episode_id}/`
    + `audio_enhancement_derivatives/${jobId}/${jobId}.mp3`;
  const manifest = await buildDerivativeManifest(env, {
    id: jobId,
    ...source,
    recipe_json: JSON.stringify(recipe),
    output_object_key: outputObjectKey,
    processor_manifest_sha256: ""
  });
  const prior = await loadDerivative(env.DB, jobId);
  if (prior) {
    if (
      prior.episode_id !== access.episode.id
      || prior.selected_preview_id !== previewId
      || prior.processor_manifest_sha256 !== manifest.manifestSha256
    ) {
      return derivativeConflict(
        request,
        env,
        "audio_enhancement_derivative_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      derivative: presentDerivative(env, prior),
      processor: derivativeDispatch(manifest),
      idempotent: true
    });
  }
  const active = await env.DB.prepare(
    `SELECT id
     FROM audio_enhancement_derivatives
     WHERE episode_id = ?
       AND selected_preview_id = ?
       AND source_master_id = ?
       AND status IN ('queued', 'rendering', 'completing', 'ready')
     LIMIT 1`
  ).bind(
    source.episode_id,
    source.selected_preview_id,
    source.current_master_id
  ).first<{ id: string }>();
  if (active) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_exists",
      { derivativeId: active.id }
    );
  }
  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(
    outputObjectKey,
    {
      httpMetadata: {
        contentType: "audio/mpeg",
        contentDisposition: "attachment"
      },
      customMetadata: {
        "processor-manifest-sha256": manifest.manifestSha256
      }
    }
  );
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO audio_enhancement_derivatives (
           id, episode_id, selected_preview_id, source_master_id,
           source_upload_id, source_quality_control_run_id,
           source_object_key, source_object_bytes, source_object_etag,
           source_mime_type, source_sha256,
           source_quality_control_report_sha256,
           selected_preview_manifest_sha256,
           selected_preview_report_sha256,
           selected_preview_enhanced_sha256, recipe_json, recipe_sha256,
           output_object_key, r2_upload_id, processor_manifest_sha256,
           requested_by_admin_user_id
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`
      ).bind(
        jobId,
        source.episode_id,
        source.selected_preview_id,
        source.current_master_id,
        source.source_upload_id,
        source.source_quality_control_run_id,
        source.source_object_key,
        source.source_object_bytes,
        source.source_object_etag,
        source.source_mime_type,
        source.source_sha256,
        source.source_quality_control_report_sha256,
        source.selected_preview_manifest_sha256,
        source.selected_preview_report_sha256,
        source.selected_preview_enhanced_sha256,
        JSON.stringify(recipe),
        recipeSha256,
        outputObjectKey,
        multipart.uploadId,
        manifest.manifestSha256,
        access.authorization.identity.id
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: access.authorization.identity.id,
        action: "audio_enhancement_derivative.queued",
        targetType: "audio_enhancement_derivative",
        targetId: jobId,
        metadata: {
          episodeId: source.episode_id,
          selectedPreviewId: source.selected_preview_id,
          sourceMasterId: source.current_master_id,
          sourceQualityControlRunId:
            source.source_quality_control_run_id,
          recipeSha256,
          processorManifestSha256: manifest.manifestSha256
        }
      })
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      await multipart.abort();
      return derivativeConflict(
        request,
        env,
        "audio_enhancement_derivative_conflict"
      );
    }
  } catch (error) {
    await multipart.abort().catch(() => {});
    throw error;
  }
  const derivative = await loadDerivative(env.DB, jobId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      derivative: derivative ? presentDerivative(env, derivative) : null,
      processor: derivativeDispatch(manifest),
      idempotent: false
    },
    { status: 202 }
  );
}

export async function getAudioEnhancementDerivativeProcessorManifest(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const signed = await authorizeDerivativeProcessor(
    request,
    env,
    derivativeIdValue,
    "manifest"
  );
  if (signed instanceof Response) return signed;
  const manifest = await rebuildDerivativeManifest(env, signed.derivative);
  if (!manifest) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_manifest_mismatch"
    );
  }
  await env.DB.prepare(
    `UPDATE audio_enhancement_derivatives
     SET
       status = CASE WHEN status = 'queued' THEN 'rendering' ELSE status END,
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering')`
  ).bind(signed.derivative.id).run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getAudioEnhancementDerivativeProcessorSource(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const signed = await authorizeDerivativeProcessor(
    request,
    env,
    derivativeIdValue,
    "source"
  );
  if (signed instanceof Response) return signed;
  if (!await rebuildDerivativeManifest(env, signed.derivative)) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_manifest_mismatch"
    );
  }
  const object = await env.MEDIA_BUCKET.get(
    signed.derivative.source_object_key,
    {
      onlyIf: new Headers({
        "if-match": signed.derivative.source_object_etag
      })
    }
  );
  if (
    !object
    || !("body" in object)
    || object.size !== signed.derivative.source_object_bytes
    || object.httpEtag !== signed.derivative.source_object_etag
    || object.httpMetadata?.contentType
      !== signed.derivative.source_mime_type
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_source_mismatch"
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": signed.derivative.source_mime_type,
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

export async function uploadAudioEnhancementDerivativeProcessorPart(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string,
  partNumberValue: string
): Promise<Response> {
  if (!processorAvailable(env)) return derivativeNotFound(request, env);
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
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
  if (
    payload.derivativeId !== derivativeId
    || payload.partNumber !== partNumber
  ) {
    throw new RequestValidationError(
      "The derivative part does not match its URL"
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
      "The derivative part body does not match its signed payload"
    );
  }
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (
    !derivative
    || !derivativeCurrent(derivative)
    || !["queued", "rendering"].includes(derivative.status)
    || payload.manifestSha256 !== derivative.processor_manifest_sha256
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_processable"
    );
  }
  const prior = await loadPart(env.DB, derivativeId, partNumber);
  if (
    prior
    && prior.uploaded_bytes === payload.objectBytes
    && prior.sha256 === payload.sha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      derivativeId,
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
    "Audio enhancement derivative multipart part"
  );
  if (
    bytes.byteLength !== contentLength
    || await sha256BytesHex(bytes) !== payload.sha256
  ) {
    throw new RequestValidationError(
      "The derivative part checksum does not match its signed payload"
    );
  }
  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.MEDIA_BUCKET.resumeMultipartUpload(
      derivative.output_object_key,
      derivative.r2_upload_id
    ).uploadPart(partNumber, bytes);
  } catch {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_multipart_unavailable"
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audio_enhancement_derivative_parts (
         derivative_id, part_number, etag, uploaded_bytes, sha256
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(derivative_id, part_number) DO UPDATE SET
         etag = excluded.etag,
         uploaded_bytes = excluded.uploaded_bytes,
         sha256 = excluded.sha256,
         uploaded_at = datetime('now')`
    ).bind(
      derivativeId,
      uploaded.partNumber,
      uploaded.etag,
      contentLength,
      payload.sha256
    ),
    env.DB.prepare(
      `UPDATE audio_enhancement_derivatives
       SET status = 'rendering', updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(derivativeId)
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    derivativeId,
    partNumber: uploaded.partNumber,
    etag: uploaded.etag,
    uploadedBytes: contentLength,
    checksumVerified: true,
    idempotent: false
  });
}

export async function completeAudioEnhancementDerivativeMultipartUpload(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "Audio enhancement derivative multipart evidence"
  );
  if (signed instanceof Response) return signed;
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (!derivative || !derivativeCurrent(derivative)) {
    return derivativeNotFound(request, env);
  }
  const evidence = multipartEvidence(signed.body, derivativeId);
  if (evidence.manifestSha256 !== derivative.processor_manifest_sha256) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_manifest_mismatch"
    );
  }
  const existing = await env.MEDIA_BUCKET.head(
    derivative.output_object_key
  );
  if (validCompletedObject(existing, derivative, evidence.objectBytes)) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      derivativeId,
      objectBytes: existing!.size,
      etag: existing!.httpEtag,
      outputSha256: evidence.outputSha256,
      multipartCompleted: true,
      idempotent: true
    });
  }
  if (!["queued", "rendering", "completing"].includes(derivative.status)) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_processable"
    );
  }
  const parts = await listParts(env.DB, derivativeId);
  validateCompleteParts(parts, evidence);
  await env.DB.prepare(
    `UPDATE audio_enhancement_derivatives
     SET status = 'completing', updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering', 'completing')`
  ).bind(derivativeId).run();
  let object: R2Object | null;
  try {
    object = await completeMultipartUploadAndHead(
      env.MEDIA_BUCKET,
      derivative.output_object_key,
      derivative.r2_upload_id,
      parts.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag
      }))
    );
  } catch {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_multipart_completion_failed"
    );
  }
  if (!validCompletedObject(object, derivative, evidence.objectBytes)) {
    await env.MEDIA_BUCKET.delete(derivative.output_object_key);
    return failDerivative(
      request,
      env,
      derivative,
      "output_invalid"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    derivativeId,
    objectBytes: object!.size,
    etag: object!.httpEtag,
    outputSha256: evidence.outputSha256,
    multipartCompleted: true,
    idempotent: false
  });
}

export async function completeAudioEnhancementDerivative(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "Audio enhancement derivative processor evidence"
  );
  if (signed instanceof Response) return signed;
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (!derivative) return derivativeNotFound(request, env);
  if (
    signed.body.jobId !== derivativeId
    || signed.body.manifestSha256
      !== derivative.processor_manifest_sha256
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_manifest_mismatch"
    );
  }
  if (signed.body.status === "failed") {
    const failureCode = String(signed.body.failureCode ?? "");
    if (!FAILURE_CODES.has(failureCode)) {
      throw new RequestValidationError("failureCode is invalid");
    }
    return failDerivative(request, env, derivative, failureCode);
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("status is invalid");
  }
  const manifest = await rebuildDerivativeManifest(env, derivative);
  if (!manifest || !derivativeCurrent(derivative)) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_processable"
    );
  }
  let report: AudioEnhancementDerivativeReport;
  let reportSha256: string;
  try {
    report = await validateAudioEnhancementDerivativeReport(
      signed.body.report,
      manifest
    );
    reportSha256 = await audioEnhancementDerivativeReportSha256(
      report,
      manifest
    );
  } catch {
    throw new RequestValidationError(
      "Audio enhancement derivative report is invalid",
      "invalid_audio_enhancement_derivative_report"
    );
  }
  if (signed.body.reportSha256 !== reportSha256) {
    throw new RequestValidationError(
      "Audio enhancement derivative report digest is invalid",
      "invalid_audio_enhancement_derivative_report"
    );
  }
  if (
    derivative.status === "ready"
    && derivative.processor_report_sha256 === reportSha256
    && derivative.derivative_quality_control_run_id
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      derivative: presentDerivative(env, derivative),
      qualityControl: {
        workflow: "process-audio-qc.yml",
        runId: derivative.derivative_quality_control_run_id
      },
      idempotent: true
    });
  }
  if (!["rendering", "completing"].includes(derivative.status)) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_processable"
    );
  }
  const object = await env.MEDIA_BUCKET.head(derivative.output_object_key);
  if (
    !validCompletedObject(
      object,
      derivative,
      report.output.objectBytes
    )
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_output_mismatch"
    );
  }
  const identifiers = await derivativeOutputIdentifiers(derivativeId);
  const policy = await loadAudioQcPolicy(env.DB, derivative.show_id);
  if (!policy) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_qc_policy_not_found"
    );
  }
  const qcManifest = await buildDerivativeQcManifest(
    env,
    derivative,
    object!,
    report,
    identifiers.qcRunId,
    policy
  );
  const existingUpload = await loadMediaUploadByIdentity(
    env.DB,
    identifiers.outputUploadId,
    derivative.output_object_key
  );
  if (
    existingUpload
    && (
      existingUpload.id !== identifiers.outputUploadId
      || existingUpload.show_id !== derivative.show_id
      || existingUpload.episode_id !== derivative.episode_id
      || existingUpload.kind !== "source_audio"
      || existingUpload.object_key !== derivative.output_object_key
      || existingUpload.r2_upload_id !== derivative.r2_upload_id
      || existingUpload.content_type !== "audio/mpeg"
      || existingUpload.expected_bytes !== report.output.objectBytes
      || existingUpload.status !== "completed"
      || existingUpload.completed_bytes !== report.output.objectBytes
      || existingUpload.object_etag !== object!.httpEtag
    )
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_output_upload_conflict"
    );
  }
  const existingQc = await env.DB.prepare(
    `SELECT
       id, episode_id, source_upload_id, source_object_key,
       source_object_bytes, source_object_etag, source_mime_type,
       policy_revision, processor_manifest_sha256
     FROM audio_qc_runs
     WHERE id = ?`
  ).bind(identifiers.qcRunId).first<{
    id: string;
    episode_id: string;
    source_upload_id: string;
    source_object_key: string;
    source_object_bytes: number;
    source_object_etag: string;
    source_mime_type: string;
    policy_revision: number;
    processor_manifest_sha256: string;
  }>();
  if (
    existingQc
    && (
      existingQc.episode_id !== derivative.episode_id
      || existingQc.source_upload_id !== identifiers.outputUploadId
      || existingQc.source_object_key !== derivative.output_object_key
      || existingQc.source_object_bytes !== report.output.objectBytes
      || existingQc.source_object_etag !== object!.httpEtag
      || existingQc.source_mime_type !== "audio/mpeg"
      || existingQc.policy_revision !== policy.revision
      || existingQc.processor_manifest_sha256
        !== qcManifest.manifestSha256
    )
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_qc_conflict"
    );
  }
  const policyJson = JSON.stringify(audioQcPolicyContract(policy));
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO media_uploads (
         id, show_id, episode_id, kind, object_key, r2_upload_id,
         filename, content_type, expected_bytes, status, completed_bytes,
         object_etag, initiated_by_admin_user_id, completed_at, updated_at
       ) VALUES (
         ?, ?, ?, 'source_audio', ?, ?, ?, 'audio/mpeg', ?,
         'completed', ?, ?, ?, datetime('now'), datetime('now')
       )`
    ).bind(
      identifiers.outputUploadId,
      derivative.show_id,
      derivative.episode_id,
      derivative.output_object_key,
      derivative.r2_upload_id,
      `enhanced-${identifiers.digest.slice(0, 16)}.mp3`,
      report.output.objectBytes,
      report.output.objectBytes,
      object!.httpEtag,
      derivative.requested_by_admin_user_id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO audio_qc_runs (
         id, episode_id, source_upload_id, source_object_key,
         source_object_bytes, source_object_etag, source_mime_type,
         policy_revision, policy_json, processor_manifest_sha256,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, ?, ?, ?)`
    ).bind(
      identifiers.qcRunId,
      derivative.episode_id,
      identifiers.outputUploadId,
      derivative.output_object_key,
      report.output.objectBytes,
      object!.httpEtag,
      policy.revision,
      policyJson,
      qcManifest.manifestSha256,
      derivative.requested_by_admin_user_id
    ),
    env.DB.prepare(
      `UPDATE audio_enhancement_derivatives
       SET
         status = 'ready',
         output_upload_id = ?,
         derivative_quality_control_run_id = ?,
         output_object_bytes = ?,
         output_object_etag = ?,
         output_sha256 = ?,
         output_duration_ms = ?,
         processor_version = ?,
         processor_report_json = ?,
         processor_report_sha256 = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('rendering', 'completing')
         AND processor_manifest_sha256 = ?`
    ).bind(
      identifiers.outputUploadId,
      identifiers.qcRunId,
      report.output.objectBytes,
      object!.httpEtag,
      report.output.sha256,
      report.output.durationMs,
      report.processorVersion,
      JSON.stringify(report),
      reportSha256,
      derivativeId,
      manifest.manifestSha256
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: derivative.requested_by_admin_user_id,
      action: "audio_enhancement_derivative.ready",
      targetType: "audio_enhancement_derivative",
      targetId: derivativeId,
      metadata: {
        episodeId: derivative.episode_id,
        outputUploadId: identifiers.outputUploadId,
        qualityControlRunId: identifiers.qcRunId,
        outputBytes: report.output.objectBytes,
        outputSha256: report.output.sha256,
        processorReportSha256: reportSha256,
        qualityControlManifestSha256: qcManifest.manifestSha256
      }
    })
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_completion_conflict"
    );
  }
  const ready = await loadDerivative(env.DB, derivativeId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    derivative: ready ? presentDerivative(env, ready) : null,
    qualityControl: qcDispatch(qcManifest),
    idempotent: false
  });
}

export async function approveAdminAudioEnhancementDerivative(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: APPROVE_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (
    !derivative
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      APPROVE_ROLES,
      derivative.show_id
    )
  ) {
    return derivativeNotFound(request, env);
  }
  const body = await readJsonObject(request, 20_000);
  const masterId = validIdentifier(body.masterId, "masterId");
  const baseRevision = positiveInteger(
    body.baseRevision,
    "baseRevision"
  );
  const approvalReason = requiredText(
    body.approvalReason,
    "approvalReason",
    500
  );
  if (
    derivative.status !== "ready"
    || !derivativeCurrent(derivative)
    || !derivative.output_upload_id
    || !derivative.derivative_quality_control_run_id
    || !derivative.output_object_bytes
    || !derivative.output_object_etag
    || !derivative.output_sha256
    || derivative.quality_control_status !== "succeeded"
    || derivative.quality_control_blocker_count !== 0
    || derivative.quality_control_policy_revision
      !== derivative.current_policy_revision
    || derivative.quality_control_source_sha256
      !== derivative.output_sha256
    || !derivative.quality_control_report_sha256
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_approvable"
    );
  }
  const state = await env.DB.prepare(
    `SELECT revision, current_master_id
     FROM episode_working_master_states
     WHERE episode_id = ?`
  ).bind(derivative.episode_id).first<{
    revision: number;
    current_master_id: string | null;
  }>();
  if (
    !state
    || state.revision !== baseRevision
    || state.current_master_id !== derivative.source_master_id
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_master_conflict",
      {
        currentRevision: state?.revision ?? null,
        currentMasterId: state?.current_master_id ?? null
      }
    );
  }
  const object = await env.MEDIA_BUCKET.head(derivative.output_object_key);
  if (
    !validCompletedObject(
      object,
      derivative,
      derivative.output_object_bytes
    )
    || object!.httpEtag !== derivative.output_object_etag
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_output_mismatch"
    );
  }
  const revision = baseRevision + 1;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE audio_enhancement_derivatives
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
      derivativeId,
      derivative.source_master_id
    ),
    env.DB.prepare(
      `INSERT INTO episode_working_masters (
         id, episode_id, revision, origin_kind, source_upload_id,
         quality_control_run_id, object_key, object_bytes, object_etag,
         mime_type, source_sha256, quality_control_report_sha256,
         approval_reason, approved_by_admin_user_id
       ) VALUES (
         ?, ?, ?, 'enhanced_derivative', ?, ?, ?, ?, ?, 'audio/mpeg',
         ?, ?, ?, ?
       )`
    ).bind(
      masterId,
      derivative.episode_id,
      revision,
      derivative.output_upload_id,
      derivative.derivative_quality_control_run_id,
      derivative.output_object_key,
      derivative.output_object_bytes,
      derivative.output_object_etag,
      derivative.output_sha256,
      derivative.quality_control_report_sha256,
      approvalReason,
      auth.authorization.identity.id
    ),
    env.DB.prepare(
      `UPDATE episode_working_master_states
       SET
         revision = ?,
         current_master_id = ?,
         updated_at = datetime('now')
       WHERE episode_id = ?
         AND revision = ?
         AND current_master_id = ?`
    ).bind(
      revision,
      masterId,
      derivative.episode_id,
      baseRevision,
      derivative.source_master_id
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "audio_enhancement_derivative.approved",
      targetType: "episode_working_master",
      targetId: masterId,
      metadata: {
        derivativeId,
        episodeId: derivative.episode_id,
        revision,
        sourceMasterId: derivative.source_master_id,
        outputUploadId: derivative.output_upload_id,
        qualityControlRunId:
          derivative.derivative_quality_control_run_id,
        outputSha256: derivative.output_sha256,
        qualityControlReportSha256:
          derivative.quality_control_report_sha256
      }
    })
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || Number(results[2]?.meta?.changes ?? 0) !== 1
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_master_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    master: {
      id: masterId,
      episodeId: derivative.episode_id,
      revision,
      originKind: "enhanced_derivative",
      sourceUploadId: derivative.output_upload_id,
      qualityControlRunId:
        derivative.derivative_quality_control_run_id,
      objectBytes: derivative.output_object_bytes,
      mimeType: "audio/mpeg",
      sourceSha256: derivative.output_sha256,
      qualityControlReportSha256:
        derivative.quality_control_report_sha256,
      approvalReason,
      approvedAt: new Date().toISOString()
    }
  });
}

export async function serveAdminAudioEnhancementDerivative(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string
): Promise<Response> {
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES
  });
  if (!auth.ok) return auth.response;
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (
    !derivative
    || ![
      "ready",
      "quality_control_failed",
      "approved"
    ].includes(derivative.status)
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      READ_ROLES,
      derivative.show_id
    )
    || !derivative.output_object_bytes
    || !derivative.output_object_etag
  ) {
    return derivativeNotFound(request, env);
  }
  const head = await env.MEDIA_BUCKET.head(derivative.output_object_key);
  if (
    !validCompletedObject(
      head,
      derivative,
      derivative.output_object_bytes
    )
    || head!.httpEtag !== derivative.output_object_etag
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_output_mismatch"
    );
  }
  const headers = derivativeMediaHeaders(
    request,
    env,
    head!.httpEtag
  );
  headers.set(
    "content-disposition",
    new URL(request.url).searchParams.get("download") === "1"
      ? `attachment; filename="${safeDownloadFilename(
          `${derivativeId}-enhanced.mp3`
        )}"`
      : "inline"
  );
  if (request.headers.get("if-none-match") === head!.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set(
      "content-length",
      String(derivative.output_object_bytes)
    );
    return new Response(null, { headers });
  }
  const range = requestedMediaRange(
    request,
    derivative.output_object_bytes,
    head!.httpEtag
  );
  if (range === "invalid") {
    headers.set(
      "content-range",
      `bytes */${derivative.output_object_bytes}`
    );
    return new Response(null, { status: 416, headers });
  }
  const object = await env.MEDIA_BUCKET.get(
    derivative.output_object_key,
    {
      ...(range ? { range } : {}),
      onlyIf: new Headers({ "if-match": head!.httpEtag })
    }
  );
  if (
    !object
    || !("body" in object)
    || object.size !== derivative.output_object_bytes
    || object.httpEtag !== head!.httpEtag
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_output_mismatch"
    );
  }
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-length", String(length));
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/`
      + `${derivative.output_object_bytes}`
    );
  } else {
    headers.set(
      "content-length",
      String(derivative.output_object_bytes)
    );
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers
  });
}

async function authorizeDerivativeProcessor(
  request: Request,
  env: PodcastEnv,
  derivativeIdValue: string,
  action: "manifest" | "source"
): Promise<{ derivative: DerivativeRow } | Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    `Audio enhancement derivative ${action} request`,
    10_000
  );
  if (signed instanceof Response) return signed;
  const derivativeId = validIdentifier(derivativeIdValue, "derivativeId");
  if (
    signed.body.jobId !== derivativeId
    || signed.body.action !== action
  ) {
    throw new RequestValidationError(
      `The ${action} request does not match its URL or action`
    );
  }
  const derivative = await loadDerivative(env.DB, derivativeId);
  if (!derivative) return derivativeNotFound(request, env);
  if (
    !derivativeCurrent(derivative)
    || !["queued", "rendering"].includes(derivative.status)
  ) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_not_processable"
    );
  }
  return { derivative };
}

async function signedProcessorJson(
  request: Request,
  env: PodcastEnv,
  bodyName: string,
  maximumBytes = MAXIMUM_PROCESSOR_BODY_BYTES
): Promise<{ body: Record<string, unknown> } | Response> {
  if (!processorAvailable(env)) return derivativeNotFound(request, env);
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    maximumBytes,
    bodyName,
    invalidBodyCode: "invalid_audio_enhancement_derivative_processor_body"
  });
  if (!signed.ok) {
    return signed.reason === "secret_missing"
      ? derivativeNotFound(request, env)
      : invalidProcessorSignature(request, env);
  }
  return signed;
}

async function buildDerivativeManifest(
  env: PodcastEnv,
  derivative: {
    id: string;
    selected_preview_id: string;
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
    source_quality_control_run_id: string;
    source_quality_control_report_sha256: string;
    selected_preview_manifest_sha256: string;
    selected_preview_report_sha256: string;
    selected_preview_enhanced_sha256: string;
    recipe_json: string;
    output_object_key: string;
    processor_manifest_sha256: string;
  }
): Promise<AudioEnhancementDerivativeManifest> {
  const origin = env.FEED_ORIGIN.replace(/\/$/, "");
  const base =
    `${origin}/v1/processor/audio-enhancement-derivatives/`
    + derivative.id;
  return buildAudioEnhancementDerivativeManifest({
    schemaVersion: "audio-enhancement-derivative-job-v1",
    jobId: derivative.id,
    selectedPreviewId: derivative.selected_preview_id,
    episodeId: derivative.episode_id,
    showId: derivative.show_id,
    source: {
      workingMasterId:
        derivative.source_master_id
        ?? derivative.current_master_id
        ?? "",
      bucketName: env.MEDIA_BUCKET_NAME || "",
      objectKey: derivative.source_object_key,
      objectBytes: derivative.source_object_bytes,
      etag: derivative.source_object_etag,
      mimeType: derivative.source_mime_type,
      sha256: derivative.source_sha256,
      durationMs: derivative.source_duration_ms
    },
    qualityControl: {
      runId: derivative.source_quality_control_run_id,
      reportSha256:
        derivative.source_quality_control_report_sha256,
      blockerCount: 0
    },
    selection: {
      previewManifestSha256:
        derivative.selected_preview_manifest_sha256,
      previewReportSha256:
        derivative.selected_preview_report_sha256,
      previewEnhancedSha256:
        derivative.selected_preview_enhanced_sha256
    },
    recipe: JSON.parse(
      derivative.recipe_json
    ) as AudioEnhancementDerivativeRecipe,
    output: {
      objectKey: derivative.output_object_key,
      mimeType: "audio/mpeg",
      recommendedPartBytes: RECOMMENDED_PART_BYTES
    },
    endpoints: {
      source: `${base}/source`,
      partTemplate: `${base}/parts/{partNumber}`,
      uploadComplete: `${base}/upload-complete`,
      evidenceComplete: `${base}/complete`
    }
  });
}

async function rebuildDerivativeManifest(
  env: PodcastEnv,
  derivative: DerivativeRow
): Promise<AudioEnhancementDerivativeManifest | null> {
  const manifest = await buildDerivativeManifest(env, derivative);
  return manifest.manifestSha256 === derivative.processor_manifest_sha256
    ? manifest
    : null;
}

async function loadDerivativeSource(
  db: D1Database,
  episodeId: string,
  previewId: string
): Promise<DerivativeSourceRow | null> {
  return db.prepare(
    `SELECT
       episode.id AS episode_id,
       episode.show_id,
       qc.duration_ms AS source_duration_ms,
       state.current_master_id,
       master.source_upload_id,
       master.quality_control_run_id AS source_quality_control_run_id,
       master.object_key AS source_object_key,
       master.object_bytes AS source_object_bytes,
       master.object_etag AS source_object_etag,
       master.mime_type AS source_mime_type,
       master.source_sha256,
       master.quality_control_report_sha256
         AS source_quality_control_report_sha256,
       preview.id AS selected_preview_id,
       preview.processor_manifest_sha256
         AS selected_preview_manifest_sha256,
       preview.processor_report_sha256
         AS selected_preview_report_sha256,
       preview.enhanced_sha256 AS selected_preview_enhanced_sha256,
       preview.recipe_json AS preview_recipe_json
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
     JOIN audio_enhancement_previews preview
       ON preview.id = ?
      AND preview.episode_id = episode.id
      AND preview.status = 'ready'
      AND preview.source_upload_id = master.source_upload_id
      AND preview.quality_control_run_id =
        master.quality_control_run_id
      AND preview.source_object_key = master.object_key
      AND preview.source_object_bytes = master.object_bytes
      AND preview.source_object_etag = master.object_etag
      AND preview.source_mime_type = master.mime_type
      AND preview.source_sha256 = master.source_sha256
      AND preview.quality_control_report_sha256 =
        master.quality_control_report_sha256
      AND preview.processor_report_sha256 IS NOT NULL
      AND preview.enhanced_sha256 IS NOT NULL
     WHERE episode.id = ?`
  ).bind(previewId, episodeId).first<DerivativeSourceRow>();
}

function derivativeSelect(): string {
  return `SELECT
     derivative.id,
     derivative.episode_id,
     episode.show_id,
     derivative.selected_preview_id,
     derivative.source_master_id,
     derivative.source_upload_id,
     derivative.source_quality_control_run_id,
     derivative.source_object_key,
     derivative.source_object_bytes,
     derivative.source_object_etag,
     derivative.source_mime_type,
     derivative.source_sha256,
     derivative.source_quality_control_report_sha256,
     derivative.selected_preview_manifest_sha256,
     derivative.selected_preview_report_sha256,
     derivative.selected_preview_enhanced_sha256,
     derivative.recipe_json,
     derivative.recipe_sha256,
     derivative.output_object_key,
     derivative.r2_upload_id,
     derivative.processor_manifest_sha256,
     derivative.status,
     derivative.output_upload_id,
     derivative.derivative_quality_control_run_id,
     derivative.output_object_bytes,
     derivative.output_object_etag,
     derivative.output_sha256,
     derivative.output_duration_ms,
     derivative.processor_version,
     derivative.processor_report_json,
     derivative.processor_report_sha256,
     derivative.failure_code,
     derivative.requested_by_admin_user_id,
     derivative.requested_at,
     derivative.completed_at,
     derivative.approved_at,
     derivative.approval_reason,
     state.current_master_id,
     source_qc.duration_ms AS source_duration_ms,
     derivative_qc.status AS quality_control_status,
     derivative_qc.policy_revision AS quality_control_policy_revision,
     policy.revision AS current_policy_revision,
     derivative_qc.source_sha256 AS quality_control_source_sha256,
     derivative_qc.report_sha256 AS quality_control_report_sha256,
     derivative_qc.blocker_count AS quality_control_blocker_count,
     derivative_qc.warning_count AS quality_control_warning_count,
     derivative_qc.completed_at AS quality_control_completed_at
   FROM audio_enhancement_derivatives derivative
   JOIN episodes episode ON episode.id = derivative.episode_id
   JOIN episode_working_master_states state
     ON state.episode_id = derivative.episode_id
   JOIN audio_qc_runs source_qc
     ON source_qc.id = derivative.source_quality_control_run_id
   JOIN show_audio_qc_policies policy
     ON policy.show_id = episode.show_id
   LEFT JOIN audio_qc_runs derivative_qc
     ON derivative_qc.id =
       derivative.derivative_quality_control_run_id`;
}

async function loadDerivative(
  db: D1Database,
  derivativeId: string
): Promise<DerivativeRow | null> {
  return db.prepare(
    `${derivativeSelect()} WHERE derivative.id = ?`
  ).bind(derivativeId).first<DerivativeRow>();
}

async function loadPart(
  db: D1Database,
  derivativeId: string,
  partNumber: number
): Promise<DerivativePartRow | null> {
  return db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM audio_enhancement_derivative_parts
     WHERE derivative_id = ? AND part_number = ?`
  ).bind(derivativeId, partNumber).first<DerivativePartRow>();
}

async function listParts(
  db: D1Database,
  derivativeId: string
): Promise<DerivativePartRow[]> {
  const rows = await db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM audio_enhancement_derivative_parts
     WHERE derivative_id = ?
     ORDER BY part_number`
  ).bind(derivativeId).all<DerivativePartRow>();
  return rows.results;
}

async function failDerivative(
  request: Request,
  env: PodcastEnv,
  derivative: DerivativeRow,
  failureCode: string
): Promise<Response> {
  if (derivative.status === "failed") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      derivative: presentDerivative(env, derivative),
      idempotent: true
    });
  }
  if (["ready", "approved", "stale"].includes(derivative.status)) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_completion_conflict"
    );
  }
  try {
    await env.MEDIA_BUCKET.resumeMultipartUpload(
      derivative.output_object_key,
      derivative.r2_upload_id
    ).abort();
  } catch {
    await env.MEDIA_BUCKET.delete(derivative.output_object_key)
      .catch(() => {});
  }
  const result = await env.DB.prepare(
    `UPDATE audio_enhancement_derivatives
     SET
       status = 'failed',
       failure_code = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering', 'completing')`
  ).bind(failureCode, derivative.id).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    return derivativeConflict(
      request,
      env,
      "audio_enhancement_derivative_completion_conflict"
    );
  }
  const failed = await loadDerivative(env.DB, derivative.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    derivative: failed ? presentDerivative(env, failed) : null,
    idempotent: false
  });
}

function parsePartPayload(encoded: string): {
  derivativeId: string;
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
      "The derivative part payload is invalid"
    );
  }
  return {
    derivativeId: validIdentifier(
      value.derivativeId,
      "derivativeId"
    ),
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
  derivativeId: string
): {
  objectBytes: number;
  outputSha256: string;
  partCount: number;
  manifestSha256: string;
} {
  if (
    body.jobId !== derivativeId
    || body.action !== "upload-complete"
  ) {
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
  parts: DerivativePartRow[],
  evidence: { objectBytes: number; partCount: number }
): void {
  if (parts.length !== evidence.partCount || parts.length === 0) {
    throw new RequestValidationError(
      "The multipart part count is incomplete"
    );
  }
  let total = 0;
  for (const [index, part] of parts.entries()) {
    if (part.part_number !== index + 1) {
      throw new RequestValidationError(
        "The multipart parts must be contiguous"
      );
    }
    if (
      index < parts.length - 1
      && part.uploaded_bytes < MINIMUM_MULTIPART_PART_BYTES
    ) {
      throw new RequestValidationError(
        "Every non-final multipart part must be at least 5 MiB"
      );
    }
    total += part.uploaded_bytes;
  }
  if (total !== evidence.objectBytes) {
    throw new RequestValidationError(
      "The multipart byte total does not match the output"
    );
  }
}

function validCompletedObject(
  object: R2Object | null,
  derivative: Pick<
    DerivativeRow,
    "output_object_key" | "processor_manifest_sha256"
  >,
  objectBytes: number
): boolean {
  return Boolean(
    object
    && object.key === derivative.output_object_key
    && object.size === objectBytes
    && object.httpMetadata?.contentType === "audio/mpeg"
    && object.customMetadata?.["processor-manifest-sha256"]
      === derivative.processor_manifest_sha256
  );
}

async function derivativeOutputIdentifiers(derivativeId: string): Promise<{
  digest: string;
  outputUploadId: string;
  qcRunId: string;
}> {
  const digest = await sha256Hex(
    `audio-enhancement-derivative:${derivativeId}`
  );
  return {
    digest,
    outputUploadId: `upload_derivative_${digest.slice(0, 32)}`,
    qcRunId: `qc_derivative_${digest.slice(0, 32)}`
  };
}

async function loadAudioQcPolicy(
  db: D1Database,
  showId: string
): Promise<AudioQcPolicyRow | null> {
  return db.prepare(
    `SELECT
       revision, mono_integrated_lufs, stereo_integrated_lufs,
       integrated_lufs_tolerance, maximum_true_peak_dbtp,
       maximum_dc_offset, maximum_channel_imbalance_lu,
       maximum_leading_silence_ms, maximum_trailing_silence_ms,
       maximum_internal_silence_ms, silence_threshold_db
     FROM show_audio_qc_policies
     WHERE show_id = ?`
  ).bind(showId).first<AudioQcPolicyRow>();
}

function audioQcPolicyContract(row: AudioQcPolicyRow): AudioQcPolicy {
  return {
    schemaVersion: "audio-qc-policy-v1",
    revision: row.revision,
    monoIntegratedLufs: row.mono_integrated_lufs,
    stereoIntegratedLufs: row.stereo_integrated_lufs,
    integratedLufsTolerance: row.integrated_lufs_tolerance,
    maximumTruePeakDbtp: row.maximum_true_peak_dbtp,
    maximumDcOffset: row.maximum_dc_offset,
    maximumChannelImbalanceLu: row.maximum_channel_imbalance_lu,
    maximumLeadingSilenceMs: row.maximum_leading_silence_ms,
    maximumTrailingSilenceMs: row.maximum_trailing_silence_ms,
    maximumInternalSilenceMs: row.maximum_internal_silence_ms,
    silenceThresholdDb: row.silence_threshold_db
  };
}

async function buildDerivativeQcManifest(
  env: PodcastEnv,
  derivative: DerivativeRow,
  object: R2Object,
  report: AudioEnhancementDerivativeReport,
  runId: string,
  policy: AudioQcPolicyRow
): Promise<AudioQcManifest> {
  return buildAudioQcManifest({
    schemaVersion: "audio-qc-job-v1",
    runId,
    episodeId: derivative.episode_id,
    showId: derivative.show_id,
    source: {
      bucketName: env.MEDIA_BUCKET_NAME || "",
      objectKey: derivative.output_object_key,
      objectBytes: report.output.objectBytes,
      etag: object.httpEtag,
      mimeType: "audio/mpeg"
    },
    policy: audioQcPolicyContract(policy),
    callbackUrl: `${env.FEED_ORIGIN.replace(/\/$/, "")}`
      + `/v1/processor/audio-qc/${runId}/complete`
  });
}

async function loadMediaUploadByIdentity(
  db: D1Database,
  id: string,
  objectKey: string
): Promise<{
  id: string;
  show_id: string;
  episode_id: string | null;
  kind: string;
  object_key: string;
  r2_upload_id: string;
  content_type: string;
  expected_bytes: number;
  status: string;
  completed_bytes: number | null;
  object_etag: string | null;
} | null> {
  return db.prepare(
    `SELECT
       id, show_id, episode_id, kind, object_key, r2_upload_id,
       content_type, expected_bytes, status, completed_bytes, object_etag
     FROM media_uploads
     WHERE id = ? OR object_key = ?
     LIMIT 1`
  ).bind(id, objectKey).first();
}

function presentDerivative(
  env: PodcastEnv,
  row: DerivativeRow
): Record<string, unknown> {
  const qcCurrent = row.quality_control_policy_revision
    === row.current_policy_revision;
  const qcMatchesOutput = Boolean(
    row.output_sha256
    && row.quality_control_source_sha256 === row.output_sha256
  );
  const approvable = row.status === "ready"
    && derivativeCurrent(row)
    && row.quality_control_status === "succeeded"
    && row.quality_control_blocker_count === 0
    && qcCurrent
    && qcMatchesOutput;
  return {
    id: row.id,
    episodeId: row.episode_id,
    selectedPreviewId: row.selected_preview_id,
    sourceMasterId: row.source_master_id,
    sourceQualityControlRunId: row.source_quality_control_run_id,
    recipe: JSON.parse(row.recipe_json) as AudioEnhancementDerivativeRecipe,
    recipeSha256: row.recipe_sha256,
    processorManifestSha256: row.processor_manifest_sha256,
    status: row.status,
    current: derivativeCurrent(row),
    output: row.output_object_bytes
      ? {
          uploadId: row.output_upload_id,
          objectBytes: row.output_object_bytes,
          etag: row.output_object_etag,
          sha256: row.output_sha256,
          durationMs: row.output_duration_ms,
          mimeType: "audio/mpeg",
          mediaUrl:
            `/v1/admin/audio-enhancement-derivatives/${row.id}/media`,
          downloadUrl:
            `/v1/admin/audio-enhancement-derivatives/${row.id}/media`
            + "?download=1"
        }
      : null,
    qualityControl: row.derivative_quality_control_run_id
      ? {
          runId: row.derivative_quality_control_run_id,
          status: row.quality_control_status,
          policyRevision: row.quality_control_policy_revision,
          currentPolicyRevision: row.current_policy_revision,
          policyCurrent: qcCurrent,
          sourceSha256: row.quality_control_source_sha256,
          outputDigestMatches: qcMatchesOutput,
          reportSha256: row.quality_control_report_sha256,
          blockerCount: row.quality_control_blocker_count,
          warningCount: row.quality_control_warning_count,
          completedAt: row.quality_control_completed_at
        }
      : null,
    approvable,
    processorVersion: row.processor_version,
    processorReportSha256: row.processor_report_sha256,
    failureCode: row.failure_code,
    approvalReason: row.approval_reason,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    approvedAt: row.approved_at,
    processor: row.derivative_quality_control_run_id
      && ["queued", "running"].includes(
        row.quality_control_status ?? ""
      )
      ? {
          workflow: "process-audio-qc.yml",
          runId: row.derivative_quality_control_run_id
        }
      : null,
    environment: env.ENVIRONMENT
  };
}

function derivativeDispatch(
  manifest: AudioEnhancementDerivativeManifest
): Record<string, unknown> {
  return {
    workflow: "process-audio-enhancement-derivative.yml",
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256
  };
}

function qcDispatch(manifest: AudioQcManifest): Record<string, unknown> {
  return {
    workflow: "process-audio-qc.yml",
    runId: manifest.runId,
    manifestSha256: manifest.manifestSha256
  };
}

function derivativeCurrent(row: DerivativeRow): boolean {
  return row.current_master_id === row.source_master_id;
}

function processorAvailable(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET)
    && Boolean(env.MEDIA_BUCKET_NAME)
    && Boolean(env.FEED_ORIGIN);
}

function requiredSha256(value: unknown, field: string): string {
  const digest = String(value ?? "");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new RequestValidationError(`${field} must be a SHA-256 digest`);
  }
  return digest;
}

function derivativeMediaHeaders(
  request: Request,
  env: PodcastEnv,
  etag: string
): Headers {
  const headers = new Headers({
    ...privateCorsHeaders(request, env.ALLOWED_ORIGINS),
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store, max-age=0",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-site",
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  headers.set(
    "access-control-expose-headers",
    "accept-ranges,content-disposition,content-length,content-range,etag"
  );
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

function derivativeNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "not_found" },
    { status: 404 }
  );
}

function derivativeConflict(
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
