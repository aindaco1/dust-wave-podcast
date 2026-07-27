import {
  sha256BytesHex,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import type { AdminRole } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
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
const MAXIMUM_PROCESSOR_BODY_BYTES = 100_000;
const MAXIMUM_ARTWORK_BYTES = 10 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_PART_BYTES = 32 * 1024 * 1024;
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const RECOMMENDED_PART_BYTES = 32 * 1024 * 1024;
const PROCESSOR_SCHEMA_VERSION = 1;
const RENDER_TEMPLATE_ID = "episode-artwork-waveform-v1";

type RenditionSourceRow = {
  episode_id: string;
  show_id: string;
  episode_title: string;
  duration_seconds: number;
  audio_key: string;
  audio_bytes: number;
  audio_etag: string;
  audio_mime_type: string;
  media_status: string;
  artwork_url: string;
  working_master_id: string;
  working_master_sha256: string;
};

type RenditionRow = {
  id: string;
  show_id: string;
  episode_id: string;
  working_master_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  artwork_url: string;
  artwork_object_key: string;
  artwork_object_bytes: number;
  artwork_object_etag: string;
  artwork_mime_type: string;
  artwork_sha256: string;
  output_object_key: string;
  r2_upload_id: string;
  output_upload_id: string | null;
  processor_manifest_sha256: string;
  status: string;
  output_object_bytes: number | null;
  output_object_etag: string | null;
  output_sha256: string | null;
  output_duration_ms: number | null;
  output_width: number | null;
  output_height: number | null;
  processor_version: string | null;
  processor_report_json: string | null;
  failure_code: string | null;
  requested_at: string;
  completed_at: string | null;
  current_working_master_id: string | null;
  current_audio_key: string | null;
  current_audio_bytes: number | null;
  current_audio_etag: string | null;
  current_audio_mime_type: string | null;
  current_artwork_url: string;
  episode_title: string;
  episode_duration_seconds: number;
  video_source_key: string | null;
  youtube_rendition_upload_id: string | null;
};

type RenditionPartRow = {
  part_number: number;
  etag: string;
  uploaded_bytes: number;
  sha256: string;
};

type ProcessorManifest = Record<string, unknown> & {
  schemaVersion: 1;
  renditionId: string;
  source: {
    objectKey: string;
    objectBytes: number;
    etag: string;
    mimeType: string;
    workingMasterId: string;
    workingMasterSha256: string;
  };
  artwork: {
    objectKey: string;
    objectBytes: number;
    etag: string;
    mimeType: string;
    sha256: string;
  };
  output: {
    objectKey: string;
    mimeType: "video/mp4";
    width: 1920;
    height: 1080;
    maximumBytes: number;
    recommendedPartBytes: number;
    maximumPartBytes: number;
  };
  endpoints: {
    audioSource: string;
    artworkSource: string;
    partTemplate: string;
    uploadComplete: string;
    evidenceComplete: string;
  };
};

export async function listAdminEpisodeYouTubeAudioRenditions(
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
  const renditions = await env.DB.prepare(
    `${renditionSelect()}
     WHERE rendition.episode_id = ?
     ORDER BY rendition.requested_at DESC, rendition.id DESC
     LIMIT 20`
  ).bind(access.episode.id).all<RenditionRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: access.episode.id,
    environment: env.ENVIRONMENT,
    processorEnabled: Boolean(
      env.ENVIRONMENT === "staging"
      && env.MEDIA_PROCESSOR_CALLBACK_SECRET
    ),
    nativeVideoPreferred: true,
    renditions: renditions.results.map(presentRendition)
  });
}

export async function queueAdminEpisodeYouTubeAudioRendition(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") return renditionNotFound(request, env);
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  if (!env.MEDIA_PROCESSOR_CALLBACK_SECRET || !env.MEDIA_BUCKET_NAME) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "youtube_audio_processor_not_configured" },
      { status: 503 }
    );
  }
  const body = await readJsonObject(request, 20_000);
  const renditionId = validIdentifier(body.renditionId, "renditionId");
  const expectedWorkingMasterId = validIdentifier(
    body.expectedWorkingMasterId,
    "expectedWorkingMasterId"
  );
  const existing = await loadRendition(env.DB, renditionId);
  if (existing) {
    if (
      existing.episode_id !== access.episode.id
      || existing.working_master_id !== expectedWorkingMasterId
    ) {
      return renditionConflict(
        request,
        env,
        "youtube_audio_rendition_id_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      rendition: presentRendition(existing),
      idempotent: true
    });
  }
  const source = await loadRenditionSource(env.DB, access.episode.id);
  if (
    !source
    || source.working_master_id !== expectedWorkingMasterId
    || source.media_status !== "ready"
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_source_not_ready"
    );
  }
  const sourceObject = await env.MEDIA_BUCKET.head(source.audio_key);
  if (
    !sourceObject
    || sourceObject.size !== source.audio_bytes
    || sourceObject.httpEtag !== source.audio_etag
    || sourceObject.httpMetadata?.contentType !== source.audio_mime_type
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_source_object_mismatch"
    );
  }

  const artwork = await snapshotArtwork(env, source, renditionId);
  const outputKey = [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    source.show_id,
    source.episode_id,
    "youtube_audio_rendition",
    `${renditionId}.mp4`
  ].join("/");
  const manifestBody = buildProcessorManifest(
    env,
    renditionId,
    source,
    artwork,
    outputKey
  );
  const manifestSha256 = await sha256Hex(JSON.stringify(manifestBody));
  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(outputKey, {
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: {
      renditionId,
      episodeId: source.episode_id,
      showId: source.show_id,
      "processor-manifest-sha256": manifestSha256
    }
  });
  try {
    await env.DB.prepare(
      `INSERT INTO episode_youtube_audio_renditions (
         id, show_id, episode_id, working_master_id,
         source_object_key, source_object_bytes, source_object_etag,
         source_mime_type, source_sha256, artwork_url,
         artwork_object_key, artwork_object_bytes, artwork_object_etag,
         artwork_mime_type, artwork_sha256, output_object_key,
         r2_upload_id, processor_manifest_sha256,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      renditionId,
      source.show_id,
      source.episode_id,
      source.working_master_id,
      source.audio_key,
      source.audio_bytes,
      source.audio_etag,
      source.audio_mime_type,
      source.working_master_sha256,
      source.artwork_url,
      artwork.key,
      artwork.bytes,
      artwork.etag,
      artwork.mimeType,
      artwork.sha256,
      outputKey,
      multipart.uploadId,
      manifestSha256,
      access.authorization.identity.id
    ).run();
  } catch (error) {
    await multipart.abort().catch(() => {});
    throw error;
  }
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "episode.youtube_audio_rendition_queued",
    targetType: "episode_youtube_audio_rendition",
    targetId: renditionId,
    metadata: {
      showId: source.show_id,
      episodeId: source.episode_id,
      workingMasterId: source.working_master_id,
      sourceBytes: source.audio_bytes,
      artworkBytes: artwork.bytes,
      processorManifestSha256: manifestSha256
    }
  });
  const created = await loadRendition(env.DB, renditionId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      rendition: created ? presentRendition(created) : null,
      processorManifest: {
        ...manifestBody,
        manifestSha256
      },
      idempotent: false
    },
    { status: 202 }
  );
}

export async function getYouTubeAudioRenditionProcessorManifest(
  request: Request,
  env: PodcastEnv,
  renditionIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "YouTube rendition manifest request",
    10_000
  );
  if (signed instanceof Response) return signed;
  const renditionId = validIdentifier(renditionIdValue, "renditionId");
  if (
    signed.body.action !== "manifest"
    || signed.body.renditionId !== renditionId
  ) {
    throw new RequestValidationError(
      "The rendition manifest request does not match its URL"
    );
  }
  const rendition = await loadRendition(env.DB, renditionId);
  if (!rendition) return renditionNotFound(request, env);
  const manifest = manifestFromRendition(env, rendition);
  const digest = await sha256Hex(JSON.stringify(manifest));
  if (digest !== rendition.processor_manifest_sha256) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_manifest_mismatch"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: {
      ...manifest,
      manifestSha256: digest
    }
  });
}

export async function getYouTubeAudioRenditionProcessorSource(
  request: Request,
  env: PodcastEnv,
  renditionIdValue: string,
  sourceKind: "audio" | "artwork"
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "YouTube rendition source request",
    10_000
  );
  if (signed instanceof Response) return signed;
  const renditionId = validIdentifier(renditionIdValue, "renditionId");
  if (
    signed.body.action !== `source:${sourceKind}`
    || signed.body.renditionId !== renditionId
  ) {
    throw new RequestValidationError(
      "The rendition source request does not match its URL"
    );
  }
  const rendition = await loadRendition(env.DB, renditionId);
  if (!rendition || !renditionCurrent(rendition)) {
    return renditionNotFound(request, env);
  }
  const descriptor = sourceKind === "audio"
    ? {
        key: rendition.source_object_key,
        bytes: rendition.source_object_bytes,
        etag: rendition.source_object_etag,
        mimeType: rendition.source_mime_type
      }
    : {
        key: rendition.artwork_object_key,
        bytes: rendition.artwork_object_bytes,
        etag: rendition.artwork_object_etag,
        mimeType: rendition.artwork_mime_type
      };
  const object = await env.MEDIA_BUCKET.get(descriptor.key, {
    onlyIf: new Headers({ "if-match": descriptor.etag })
  });
  if (
    !object
    || !("body" in object)
    || object.size !== descriptor.bytes
    || object.httpEtag !== descriptor.etag
    || object.httpMetadata?.contentType !== descriptor.mimeType
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_source_object_mismatch"
    );
  }
  const headers = new Headers({
    "content-type": descriptor.mimeType,
    "content-length": String(descriptor.bytes),
    etag: descriptor.etag,
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  return new Response(object.body, { headers });
}

export async function uploadYouTubeAudioRenditionProcessorPart(
  request: Request,
  env: PodcastEnv,
  renditionIdValue: string,
  partNumberValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") return renditionNotFound(request, env);
  if (!env.MEDIA_PROCESSOR_CALLBACK_SECRET) {
    return renditionNotFound(request, env);
  }
  const renditionId = validIdentifier(renditionIdValue, "renditionId");
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
    payload.renditionId !== renditionId
    || payload.partNumber !== partNumber
  ) {
    throw new RequestValidationError(
      "The rendition part does not match its URL"
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
      "The rendition part body does not match its signed payload"
    );
  }
  const rendition = await loadRendition(env.DB, renditionId);
  if (
    !rendition
    || !renditionCurrent(rendition)
    || !["queued", "rendering"].includes(rendition.status)
    || payload.manifestSha256 !== rendition.processor_manifest_sha256
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_rendition_not_processable"
    );
  }
  const prior = await loadPart(env.DB, renditionId, partNumber);
  if (
    prior
    && prior.uploaded_bytes === payload.objectBytes
    && prior.sha256 === payload.sha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      renditionId,
      partNumber,
      etag: prior.etag,
      uploadedBytes: prior.uploaded_bytes,
      checksumVerified: true,
      idempotent: true
    });
  }
  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
    rendition.output_object_key,
    rendition.r2_upload_id
  );
  const partBytes = await readBoundedBytes(
    request,
    MAXIMUM_PART_BYTES,
    "YouTube rendition multipart part"
  );
  if (
    partBytes.byteLength !== contentLength
    || await sha256BytesHex(partBytes) !== payload.sha256
  ) {
    throw new RequestValidationError(
      "The rendition part checksum does not match its signed payload"
    );
  }
  let uploaded: R2UploadedPart;
  try {
    uploaded = await multipart.uploadPart(partNumber, partBytes);
  } catch {
    return renditionConflict(
      request,
      env,
      "youtube_audio_multipart_unavailable"
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO episode_youtube_audio_rendition_parts (
         rendition_id, part_number, etag, uploaded_bytes, sha256
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(rendition_id, part_number) DO UPDATE SET
         etag = excluded.etag,
         uploaded_bytes = excluded.uploaded_bytes,
         sha256 = excluded.sha256,
         uploaded_at = datetime('now')`
    ).bind(
      renditionId,
      uploaded.partNumber,
      uploaded.etag,
      contentLength,
      payload.sha256
    ),
    env.DB.prepare(
      `UPDATE episode_youtube_audio_renditions
       SET status = 'rendering', updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(renditionId)
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    renditionId,
    partNumber: uploaded.partNumber,
    etag: uploaded.etag,
    uploadedBytes: contentLength,
    checksumVerified: true,
    idempotent: false
  });
}

export async function completeYouTubeAudioRenditionMultipartUpload(
  request: Request,
  env: PodcastEnv,
  renditionIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "YouTube rendition multipart evidence",
    MAXIMUM_PROCESSOR_BODY_BYTES
  );
  if (signed instanceof Response) return signed;
  const renditionId = validIdentifier(renditionIdValue, "renditionId");
  const rendition = await loadRendition(env.DB, renditionId);
  if (!rendition || !renditionCurrent(rendition)) {
    return renditionNotFound(request, env);
  }
  const evidence = multipartEvidence(signed.body, renditionId);
  if (evidence.manifestSha256 !== rendition.processor_manifest_sha256) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_manifest_mismatch"
    );
  }
  const existingObject = await env.MEDIA_BUCKET.head(
    rendition.output_object_key
  );
  if (
    existingObject
    && existingObject.size === evidence.objectBytes
    && existingObject.httpMetadata?.contentType === "video/mp4"
    && existingObject.customMetadata?.["processor-manifest-sha256"]
      === rendition.processor_manifest_sha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      renditionId,
      objectBytes: existingObject.size,
      etag: existingObject.httpEtag,
      multipartCompleted: true,
      idempotent: true
    });
  }
  if (!["queued", "rendering", "completing"].includes(rendition.status)) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_rendition_not_processable"
    );
  }
  const parts = await listParts(env.DB, renditionId);
  validateCompleteParts(parts, evidence);
  await env.DB.prepare(
    `UPDATE episode_youtube_audio_renditions
     SET status = 'completing', updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'rendering', 'completing')`
  ).bind(renditionId).run();
  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
    rendition.output_object_key,
    rendition.r2_upload_id
  );
  let object: R2Object;
  try {
    object = await multipart.complete(
      parts.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag
      }))
    );
  } catch {
    return renditionConflict(
      request,
      env,
      "youtube_audio_multipart_completion_failed"
    );
  }
  if (
    object.size !== evidence.objectBytes
    || object.httpMetadata?.contentType !== "video/mp4"
    || object.customMetadata?.["processor-manifest-sha256"]
      !== rendition.processor_manifest_sha256
  ) {
    await env.MEDIA_BUCKET.delete(rendition.output_object_key);
    return failRendition(
      request,
      env,
      rendition,
      "youtube_audio_completed_object_mismatch",
      "multipart-validator"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    renditionId,
    objectBytes: object.size,
    etag: object.httpEtag,
    outputSha256: evidence.outputSha256,
    multipartCompleted: true,
    idempotent: false
  });
}

export async function completeYouTubeAudioRendition(
  request: Request,
  env: PodcastEnv,
  renditionIdValue: string
): Promise<Response> {
  const signed = await signedProcessorJson(
    request,
    env,
    "YouTube rendition processor evidence",
    MAXIMUM_PROCESSOR_BODY_BYTES
  );
  if (signed instanceof Response) return signed;
  const renditionId = validIdentifier(renditionIdValue, "renditionId");
  const rendition = await loadRendition(env.DB, renditionId);
  if (!rendition) return renditionNotFound(request, env);
  if (
    signed.body.renditionId !== renditionId
    || signed.body.manifestSha256 !== rendition.processor_manifest_sha256
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_manifest_mismatch"
    );
  }
  const processorVersion = requiredText(
    signed.body.processorVersion,
    "processorVersion",
    240
  );
  const status = requiredText(signed.body.status, "status", 20);
  if (status === "failed") {
    const failureCode = requiredText(
      signed.body.failureCode,
      "failureCode",
      160
    );
    return failRendition(
      request,
      env,
      rendition,
      failureCode,
      processorVersion
    );
  }
  if (status !== "succeeded") {
    throw new RequestValidationError("status must be succeeded or failed");
  }
  if (!renditionCurrent(rendition)) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_source_stale"
    );
  }
  const output = outputEvidence(signed.body.output, rendition);
  const reportJson = boundedReportJson(signed.body.report);
  if (
    rendition.status === "ready"
    && rendition.output_object_bytes === output.objectBytes
    && rendition.output_sha256 === output.sha256
    && rendition.output_duration_ms === output.durationMs
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      rendition: presentRendition(rendition),
      idempotent: true
    });
  }
  if (!["rendering", "completing"].includes(rendition.status)) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_rendition_not_processable"
    );
  }
  const object = await env.MEDIA_BUCKET.head(rendition.output_object_key);
  if (
    !object
    || object.size !== output.objectBytes
    || object.httpMetadata?.contentType !== "video/mp4"
    || object.customMetadata?.["processor-manifest-sha256"]
      !== rendition.processor_manifest_sha256
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_completed_object_mismatch"
    );
  }
  const outputUploadId =
    `upload_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO media_uploads (
         id, show_id, episode_id, kind, object_key, r2_upload_id,
         filename, content_type, expected_bytes, status, completed_bytes,
         object_etag, initiated_by_admin_user_id, completed_at
       ) VALUES (
         ?, ?, ?, 'video_source', ?, ?, ?, 'video/mp4', ?,
         'completed', ?, ?, ?, datetime('now')
       )`
    ).bind(
      outputUploadId,
      rendition.show_id,
      rendition.episode_id,
      rendition.output_object_key,
      rendition.r2_upload_id,
      `${rendition.id}.mp4`,
      output.objectBytes,
      output.objectBytes,
      object.httpEtag,
      null
    ),
    env.DB.prepare(
      `UPDATE episode_youtube_audio_renditions
       SET
         status = 'ready',
         output_upload_id = ?,
         output_object_bytes = ?,
         output_object_etag = ?,
         output_sha256 = ?,
         output_duration_ms = ?,
         output_width = 1920,
         output_height = 1080,
         processor_version = ?,
         processor_report_json = ?,
         failure_code = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('rendering', 'completing')`
    ).bind(
      outputUploadId,
      output.objectBytes,
      object.httpEtag,
      output.sha256,
      output.durationMs,
      processorVersion,
      reportJson,
      rendition.id
    ),
    env.DB.prepare(
      `UPDATE episodes
       SET
         youtube_rendition_upload_id = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND show_id = ?
         AND audio_key = ?
         AND audio_bytes = ?
         AND audio_etag = ?
         AND audio_mime_type = ?
         AND (
           SELECT current_master_id
           FROM episode_working_master_states
           WHERE episode_id = episodes.id
         ) = ?
         AND (
           SELECT artwork_url FROM shows WHERE id = episodes.show_id
         ) = ?`
    ).bind(
      outputUploadId,
      rendition.episode_id,
      rendition.show_id,
      rendition.source_object_key,
      rendition.source_object_bytes,
      rendition.source_object_etag,
      rendition.source_mime_type,
      rendition.working_master_id,
      rendition.artwork_url
    )
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || Number(results[1]?.meta?.changes ?? 0) !== 1
    || Number(results[2]?.meta?.changes ?? 0) !== 1
  ) {
    return renditionConflict(
      request,
      env,
      "youtube_audio_completion_conflict"
    );
  }
  const completed = await loadRendition(env.DB, renditionId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    rendition: completed ? presentRendition(completed) : null,
    idempotent: false
  });
}

async function loadRenditionSource(
  db: D1Database,
  episodeId: string
): Promise<RenditionSourceRow | null> {
  return db.prepare(
    `SELECT
       e.id AS episode_id,
       e.show_id,
       e.title AS episode_title,
       e.duration_seconds,
       e.audio_key,
       e.audio_bytes,
       e.audio_etag,
       e.audio_mime_type,
       e.media_status,
       s.artwork_url,
       master.id AS working_master_id,
       master.source_sha256 AS working_master_sha256
     FROM episodes e
     JOIN shows s ON s.id = e.show_id
     JOIN episode_working_master_states state ON state.episode_id = e.id
     JOIN episode_working_masters master
       ON master.id = state.current_master_id
       AND master.episode_id = e.id
     WHERE e.id = ?
       AND e.duration_seconds > 0
       AND e.audio_key IS NOT NULL
       AND e.audio_bytes > 0
       AND e.audio_etag IS NOT NULL
       AND e.audio_mime_type IS NOT NULL
       AND s.artwork_url IS NOT NULL`
  ).bind(episodeId).first<RenditionSourceRow>();
}

async function snapshotArtwork(
  env: PodcastEnv,
  source: RenditionSourceRow,
  renditionId: string
): Promise<{
  key: string;
  bytes: number;
  etag: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sha256: string;
}> {
  const artworkUrl = safeArtworkUrl(source.artwork_url, env);
  const response = await fetch(artworkUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg" }
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new RequestValidationError(
      "Show artwork could not be fetched",
      "youtube_audio_artwork_unavailable",
      409
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAXIMUM_ARTWORK_BYTES
  ) {
    await response.body.cancel("artwork_too_large").catch(() => {});
    throw new RequestValidationError(
      "Show artwork exceeds the maximum byte size",
      "youtube_audio_artwork_too_large",
      413
    );
  }
  const bytes = await readBoundedResponseBytes(
    response,
    MAXIMUM_ARTWORK_BYTES
  );
  const mimeType = validatedArtworkMimeType(
    response.headers.get("content-type"),
    bytes
  );
  const sha256 = await sha256BytesHex(bytes);
  const key = [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    source.show_id,
    source.episode_id,
    "youtube_audio_rendition",
    `${renditionId}-artwork.${artworkExtension(mimeType)}`
  ].join("/");
  const stored = await env.MEDIA_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      renditionId,
      sourceUrlSha256: await sha256Hex(artworkUrl.toString()),
      sha256
    },
    sha256
  });
  if (
    !stored
    || stored.size !== bytes.byteLength
    || stored.httpMetadata?.contentType !== mimeType
    || stored.checksums.toJSON().sha256 !== sha256
  ) {
    throw new RequestValidationError(
      "Show artwork snapshot could not be verified",
      "youtube_audio_artwork_mismatch",
      409
    );
  }
  return {
    key,
    bytes: stored.size,
    etag: stored.httpEtag,
    mimeType,
    sha256
  };
}

function buildProcessorManifest(
  env: PodcastEnv,
  renditionId: string,
  source: RenditionSourceRow,
  artwork: {
    key: string;
    bytes: number;
    etag: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    sha256: string;
  },
  outputKey: string
): ProcessorManifest {
  const base = env.MEDIA_ORIGIN.replace(/\/+$/, "");
  const processorBase =
    `${base}/v1/processor/youtube-audio-renditions/${renditionId}`;
  return {
    schemaVersion: PROCESSOR_SCHEMA_VERSION,
    renditionId,
    environment: "staging",
    templateId: RENDER_TEMPLATE_ID,
    episode: {
      id: source.episode_id,
      title: source.episode_title,
      durationMs: source.duration_seconds * 1_000
    },
    source: {
      objectKey: source.audio_key,
      objectBytes: source.audio_bytes,
      etag: source.audio_etag,
      mimeType: source.audio_mime_type,
      workingMasterId: source.working_master_id,
      workingMasterSha256: source.working_master_sha256
    },
    artwork: {
      objectKey: artwork.key,
      objectBytes: artwork.bytes,
      etag: artwork.etag,
      mimeType: artwork.mimeType,
      sha256: artwork.sha256
    },
    video: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      pixelFormat: "yuv420p",
      codec: "h264",
      profile: "high",
      crf: 26,
      preset: "veryfast",
      fastStart: true
    },
    audio: {
      codec: "aac",
      sampleRateHz: 48000,
      channels: 2,
      bitrateKbps: 192
    },
    output: {
      objectKey: outputKey,
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      maximumBytes: MAXIMUM_OUTPUT_BYTES,
      recommendedPartBytes: RECOMMENDED_PART_BYTES,
      maximumPartBytes: MAXIMUM_PART_BYTES
    },
    endpoints: {
      audioSource: `${processorBase}/sources/audio`,
      artworkSource: `${processorBase}/sources/artwork`,
      partTemplate: `${processorBase}/parts/{partNumber}`,
      uploadComplete: `${processorBase}/upload-complete`,
      evidenceComplete: `${processorBase}/complete`
    }
  };
}

function manifestFromRendition(
  env: PodcastEnv,
  rendition: RenditionRow
): ProcessorManifest {
  return buildProcessorManifest(
    env,
    rendition.id,
    {
      episode_id: rendition.episode_id,
      show_id: rendition.show_id,
      episode_title: rendition.episode_title,
      duration_seconds: rendition.episode_duration_seconds,
      audio_key: rendition.source_object_key,
      audio_bytes: rendition.source_object_bytes,
      audio_etag: rendition.source_object_etag,
      audio_mime_type: rendition.source_mime_type,
      media_status: "ready",
      artwork_url: rendition.artwork_url,
      working_master_id: rendition.working_master_id,
      working_master_sha256: rendition.source_sha256
    },
    {
      key: rendition.artwork_object_key,
      bytes: rendition.artwork_object_bytes,
      etag: rendition.artwork_object_etag,
      mimeType: rendition.artwork_mime_type as
        "image/jpeg" | "image/png" | "image/webp",
      sha256: rendition.artwork_sha256
    },
    rendition.output_object_key
  );
}

function renditionSelect(): string {
  return `SELECT
      rendition.id, rendition.show_id, rendition.episode_id,
      rendition.working_master_id, rendition.source_object_key,
      rendition.source_object_bytes, rendition.source_object_etag,
      rendition.source_mime_type, rendition.source_sha256,
      rendition.artwork_url, rendition.artwork_object_key,
      rendition.artwork_object_bytes, rendition.artwork_object_etag,
      rendition.artwork_mime_type, rendition.artwork_sha256,
      rendition.output_object_key, rendition.r2_upload_id,
      rendition.output_upload_id, rendition.processor_manifest_sha256,
      rendition.status, rendition.output_object_bytes,
      rendition.output_object_etag, rendition.output_sha256,
      rendition.output_duration_ms, rendition.output_width,
      rendition.output_height, rendition.processor_version,
      rendition.processor_report_json, rendition.failure_code,
      rendition.requested_at, rendition.completed_at,
      state.current_master_id AS current_working_master_id,
      episode.audio_key AS current_audio_key,
      episode.audio_bytes AS current_audio_bytes,
      episode.audio_etag AS current_audio_etag,
      episode.audio_mime_type AS current_audio_mime_type,
      episode.video_source_key,
      episode.youtube_rendition_upload_id,
      show.artwork_url AS current_artwork_url,
      episode.title AS episode_title,
      episode.duration_seconds AS episode_duration_seconds
    FROM episode_youtube_audio_renditions rendition
    JOIN episodes episode ON episode.id = rendition.episode_id
    JOIN shows show ON show.id = rendition.show_id
    JOIN episode_working_master_states state
      ON state.episode_id = rendition.episode_id`;
}

async function loadRendition(
  db: D1Database,
  renditionId: string
): Promise<RenditionRow | null> {
  return db.prepare(
    `${renditionSelect()} WHERE rendition.id = ?`
  ).bind(renditionId).first<RenditionRow>();
}

async function loadPart(
  db: D1Database,
  renditionId: string,
  partNumber: number
): Promise<RenditionPartRow | null> {
  return db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM episode_youtube_audio_rendition_parts
     WHERE rendition_id = ? AND part_number = ?`
  ).bind(renditionId, partNumber).first<RenditionPartRow>();
}

async function listParts(
  db: D1Database,
  renditionId: string
): Promise<RenditionPartRow[]> {
  const parts = await db.prepare(
    `SELECT part_number, etag, uploaded_bytes, sha256
     FROM episode_youtube_audio_rendition_parts
     WHERE rendition_id = ?
     ORDER BY part_number`
  ).bind(renditionId).all<RenditionPartRow>();
  return parts.results;
}

function renditionCurrent(rendition: RenditionRow): boolean {
  return rendition.current_working_master_id === rendition.working_master_id
    && rendition.current_audio_key === rendition.source_object_key
    && rendition.current_audio_bytes === rendition.source_object_bytes
    && rendition.current_audio_etag === rendition.source_object_etag
    && rendition.current_audio_mime_type === rendition.source_mime_type
    && rendition.current_artwork_url === rendition.artwork_url;
}

function presentRendition(row: RenditionRow): Record<string, unknown> {
  return {
    id: row.id,
    episodeId: row.episode_id,
    showId: row.show_id,
    workingMasterId: row.working_master_id,
    sourceBytes: row.source_object_bytes,
    sourceMimeType: row.source_mime_type,
    artworkBytes: row.artwork_object_bytes,
    artworkMimeType: row.artwork_mime_type,
    outputUploadId: row.output_upload_id,
    outputBytes: row.output_object_bytes,
    outputSha256: row.output_sha256,
    outputDurationMs: row.output_duration_ms,
    outputWidth: row.output_width,
    outputHeight: row.output_height,
    processorManifestSha256: row.processor_manifest_sha256,
    processorVersion: row.processor_version,
    status: row.status,
    failureCode: row.failure_code,
    current: renditionCurrent(row),
    selected: row.youtube_rendition_upload_id === row.output_upload_id,
    nativeVideoPreferred: Boolean(row.video_source_key),
    requestedAt: row.requested_at,
    completedAt: row.completed_at
  };
}

async function signedProcessorJson(
  request: Request,
  env: PodcastEnv,
  bodyName: string,
  maximumBytes: number
): Promise<{ body: Record<string, unknown> } | Response> {
  if (env.ENVIRONMENT !== "staging") return renditionNotFound(request, env);
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    maximumBytes,
    bodyName,
    invalidBodyCode: "invalid_youtube_audio_processor_body"
  });
  if (!signed.ok) {
    return signed.reason === "secret_missing"
      ? renditionNotFound(request, env)
      : invalidProcessorSignature(request, env);
  }
  return signed;
}

function parsePartPayload(encoded: string): {
  renditionId: string;
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
    throw new RequestValidationError("The rendition part payload is invalid");
  }
  const sha256 = requiredSha256(value.sha256, "sha256");
  const manifestSha256 = requiredSha256(
    value.manifestSha256,
    "manifestSha256"
  );
  return {
    renditionId: validIdentifier(value.renditionId, "renditionId"),
    partNumber: positiveInteger(value.partNumber, "partNumber", 10_000),
    objectBytes: positiveInteger(
      value.objectBytes,
      "objectBytes",
      MAXIMUM_PART_BYTES
    ),
    sha256,
    manifestSha256
  };
}

function multipartEvidence(
  body: Record<string, unknown>,
  renditionId: string
): {
  objectBytes: number;
  outputSha256: string;
  partCount: number;
  manifestSha256: string;
} {
  if (body.renditionId !== renditionId || body.action !== "upload-complete") {
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
    outputSha256: requiredSha256(body.outputSha256, "outputSha256"),
    partCount: positiveInteger(body.partCount, "partCount", 10_000),
    manifestSha256: requiredSha256(
      body.manifestSha256,
      "manifestSha256"
    )
  };
}

function validateCompleteParts(
  parts: RenditionPartRow[],
  evidence: {
    objectBytes: number;
    partCount: number;
  }
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

function outputEvidence(
  value: unknown,
  rendition: RenditionRow
): {
  objectBytes: number;
  sha256: string;
  durationMs: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("output must be an object");
  }
  const output = value as Record<string, unknown>;
  if (
    output.objectKey !== rendition.output_object_key
    || output.mimeType !== "video/mp4"
    || output.width !== 1920
    || output.height !== 1080
    || output.videoCodec !== "h264"
    || output.pixelFormat !== "yuv420p"
    || output.audioCodec !== "aac"
    || output.sampleRateHz !== 48000
    || output.channels !== 2
    || output.fullyDecoded !== true
  ) {
    throw new RequestValidationError(
      "The rendition output codec evidence is invalid"
    );
  }
  const objectBytes = positiveInteger(
    output.objectBytes,
    "output.objectBytes",
    MAXIMUM_OUTPUT_BYTES
  );
  const durationMs = positiveInteger(
    output.durationMs,
    "output.durationMs",
    86_401_000
  );
  const expectedDurationMs = rendition.episode_duration_seconds * 1_000;
  const tolerance = Math.max(1_000, Math.round(expectedDurationMs * 0.005));
  if (Math.abs(durationMs - expectedDurationMs) > tolerance) {
    throw new RequestValidationError(
      "The rendition duration does not match its source"
    );
  }
  return {
    objectBytes,
    sha256: requiredSha256(output.sha256, "output.sha256"),
    durationMs
  };
}

function boundedReportJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("report must be an object");
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 100_000) {
    throw new RequestValidationError("report exceeds its byte limit");
  }
  return json;
}

async function failRendition(
  request: Request,
  env: PodcastEnv,
  rendition: RenditionRow,
  failureCode: string,
  processorVersion: string
): Promise<Response> {
  if (rendition.status === "ready") {
    return renditionConflict(
      request,
      env,
      "youtube_audio_rendition_already_ready"
    );
  }
  if (rendition.status !== "failed") {
    try {
      await env.MEDIA_BUCKET.resumeMultipartUpload(
        rendition.output_object_key,
        rendition.r2_upload_id
      ).abort();
    } catch {
      // The completed or expired multipart upload is already inert.
    }
    await env.DB.prepare(
      `UPDATE episode_youtube_audio_renditions
       SET
         status = 'failed',
         processor_version = ?,
         failure_code = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status != 'ready'`
    ).bind(
      processorVersion.slice(0, 240),
      failureCode.slice(0, 160),
      rendition.id
    ).run();
  }
  const failed = await loadRendition(env.DB, rendition.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    rendition: failed ? presentRendition(failed) : null,
    idempotent: rendition.status === "failed"
  });
}

function safeArtworkUrl(value: string, env: PodcastEnv): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RequestValidationError(
      "Show artwork URL is invalid",
      "youtube_audio_artwork_url_invalid"
    );
  }
  const permittedHosts = new Set([
    "dustwave.xyz",
    "www.dustwave.xyz",
    "dust-wave-website-staging.pages.dev"
  ]);
  try {
    permittedHosts.add(new URL(env.SITE_ORIGIN).hostname);
  } catch {
    // Deployment configuration validation reports an invalid site origin.
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !permittedHosts.has(url.hostname)
  ) {
    throw new RequestValidationError(
      "Show artwork must use an approved first-party HTTPS host",
      "youtube_audio_artwork_url_invalid"
    );
  }
  return url;
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  if (!response.body) throw new RequestValidationError("Artwork body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("artwork_too_large").catch(() => {});
        throw new RequestValidationError(
          "Show artwork exceeds the maximum byte size",
          "youtube_audio_artwork_too_large",
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validatedArtworkMimeType(
  contentTypeValue: string | null,
  bytes: Uint8Array
): "image/jpeg" | "image/png" | "image/webp" {
  const contentType = String(contentTypeValue ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const detected = bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    ? "image/jpeg"
    : bytes.length >= 8
      && bytes[0] === 0x89
      && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG"
      ? "image/png"
      : bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
        ? "image/webp"
        : null;
  if (!detected || detected !== contentType) {
    throw new RequestValidationError(
      "Show artwork MIME type and file signature must match",
      "youtube_audio_artwork_type_invalid"
    );
  }
  return detected;
}

function artworkExtension(
  mimeType: "image/jpeg" | "image/png" | "image/webp"
): string {
  return mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/png"
      ? "png"
      : "webp";
}

function requiredSha256(value: unknown, name: string): string {
  const digest = requiredText(value, name, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new RequestValidationError(`${name} must be a lowercase SHA-256`);
  }
  return digest;
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

function renditionNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "youtube_audio_rendition_not_found" },
    { status: 404 }
  );
}

function renditionConflict(
  request: Request,
  env: PodcastEnv,
  error: string
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error },
    { status: 409 }
  );
}
