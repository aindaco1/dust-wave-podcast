import { requireAdmin } from "./admin-auth";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  requiredText,
  safeFilename,
  validIdentifier
} from "./validation";

const UPLOAD_ROLES = ["super_admin", "admin", "producer"] as const;
const UPLOAD_KINDS = [
  "source_audio",
  "delivery_audio",
  "video_source",
  "artwork",
  "transcript"
] as const;
type UploadKind = typeof UPLOAD_KINDS[number];

type UploadRow = {
  id: string;
  show_id: string;
  episode_id: string | null;
  kind: UploadKind;
  object_key: string;
  r2_upload_id: string;
  filename: string;
  content_type: string;
  expected_bytes: number;
  status: string;
  completed_bytes: number | null;
  object_etag: string | null;
};

export async function createMultipartUpload(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const body = await readJsonObject(request);
  const showId = validIdentifier(body.showId, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...UPLOAD_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const show = await env.DB
    .prepare(`SELECT id FROM shows WHERE id = ? AND status != 'archived'`)
    .bind(showId)
    .first<{ id: string }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }

  const episodeId = body.episodeId
    ? validIdentifier(body.episodeId, "episodeId")
    : null;
  if (episodeId) {
    const episode = await env.DB
      .prepare(`SELECT id FROM episodes WHERE id = ? AND show_id = ?`)
      .bind(episodeId, showId)
      .first<{ id: string }>();
    if (!episode) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "episode_not_found" },
        { status: 404 }
      );
    }
  }
  const kind = requiredText(body.kind, "kind", 40) as UploadKind;
  if (!UPLOAD_KINDS.includes(kind)) {
    throw new RequestValidationError("upload kind is invalid");
  }
  if (["source_audio", "delivery_audio", "video_source", "transcript"].includes(kind) && !episodeId) {
    throw new RequestValidationError("episodeId is required for this upload kind");
  }
  const filename = safeFilename(body.filename);
  const contentType = requiredText(body.contentType, "contentType", 160).toLowerCase();
  validateContentType(kind, contentType);
  const expectedBytes = positiveInteger(
    body.expectedBytes,
    "expectedBytes",
    20 * 1024 * 1024 * 1024
  );
  const uploadId = `upload_${crypto.randomUUID().replace(/-/g, "")}`;
  const key = [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    showId,
    episodeId ?? "show",
    kind,
    `${uploadId}-${filename}`
  ].join("/");
  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: {
      uploadId,
      showId,
      ...(episodeId ? { episodeId } : {}),
      kind
    }
  });
  await env.DB
    .prepare(
      `INSERT INTO media_uploads (
         id, show_id, episode_id, kind, object_key, r2_upload_id,
         filename, content_type, expected_bytes, initiated_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      uploadId,
      showId,
      episodeId,
      kind,
      key,
      multipart.uploadId,
      filename,
      contentType,
      expectedBytes,
      auth.authorization.identity.id
    )
    .run();
  if (episodeId && ["source_audio", "delivery_audio", "video_source"].includes(kind)) {
    await env.DB
      .prepare(
        `UPDATE episodes
         SET media_status = 'uploading', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(episodeId)
      .run();
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "media_upload.created",
    targetType: "media_upload",
    targetId: uploadId,
    metadata: { showId, episodeId, kind, expectedBytes, contentType }
  });
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      uploadId,
      key,
      recommendedPartBytes: 32 * 1024 * 1024,
      maximumPartBytes: 95 * 1024 * 1024,
      expiresAfterDays: 7
    },
    { status: 201 }
  );
}

export async function uploadMultipartPart(
  request: Request,
  env: PodcastEnv,
  uploadIdValue: string,
  partNumberValue: string
): Promise<Response> {
  const uploadId = validIdentifier(uploadIdValue, "uploadId");
  const partNumber = positiveInteger(partNumberValue, "partNumber", 10_000);
  const upload = await loadUpload(env.DB, uploadId);
  if (!upload) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "upload_not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...UPLOAD_ROLES],
    requireCsrf: true,
    showId: upload.show_id
  });
  if (!auth.ok) return auth.response;
  if (upload.status !== "uploading") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "upload_not_open" },
      { status: 409 }
    );
  }
  const contentLength = positiveInteger(
    request.headers.get("content-length"),
    "Content-Length",
    100 * 1024 * 1024
  );
  if (!request.body) {
    throw new RequestValidationError("An upload part body is required");
  }
  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
    upload.object_key,
    upload.r2_upload_id
  );
  let part: R2UploadedPart;
  try {
    part = await multipart.uploadPart(partNumber, request.body);
  } catch {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "multipart_upload_unavailable" },
      { status: 409 }
    );
  }
  await env.DB
    .prepare(
      `INSERT INTO media_upload_parts (
         upload_id, part_number, etag, uploaded_bytes
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(upload_id, part_number) DO UPDATE SET
         etag = excluded.etag,
         uploaded_bytes = excluded.uploaded_bytes,
         uploaded_at = datetime('now')`
    )
    .bind(uploadId, part.partNumber, part.etag, contentLength)
    .run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    uploadId,
    partNumber: part.partNumber,
    etag: part.etag,
    uploadedBytes: contentLength
  });
}

export async function completeMultipartUpload(
  request: Request,
  env: PodcastEnv,
  uploadIdValue: string
): Promise<Response> {
  const uploadId = validIdentifier(uploadIdValue, "uploadId");
  const upload = await loadUpload(env.DB, uploadId);
  if (!upload) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "upload_not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...UPLOAD_ROLES],
    requireCsrf: true,
    showId: upload.show_id
  });
  if (!auth.ok) return auth.response;
  if (upload.status === "completed") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      uploadId,
      completed: true,
      bytes: upload.completed_bytes,
      etag: upload.object_etag
    });
  }
  if (upload.status !== "uploading" && upload.status !== "completing") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "upload_not_open" },
      { status: 409 }
    );
  }
  const parts = await env.DB
    .prepare(
      `SELECT part_number, etag, uploaded_bytes
       FROM media_upload_parts
       WHERE upload_id = ?
       ORDER BY part_number`
    )
    .bind(uploadId)
    .all<{ part_number: number; etag: string; uploaded_bytes: number }>();
  if (parts.results.length === 0) {
    throw new RequestValidationError("At least one uploaded part is required");
  }
  const totalUploadedBytes = parts.results.reduce(
    (total, part) => total + part.uploaded_bytes,
    0
  );
  if (totalUploadedBytes !== upload.expected_bytes) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "upload_size_mismatch",
        expectedBytes: upload.expected_bytes,
        uploadedBytes: totalUploadedBytes
      },
      { status: 409 }
    );
  }
  await env.DB
    .prepare(
      `UPDATE media_uploads
       SET status = 'completing', updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(uploadId)
    .run();
  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(
    upload.object_key,
    upload.r2_upload_id
  );
  let object: R2Object;
  try {
    object = await multipart.complete(
      parts.results.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag
      }))
    );
  } catch {
    await env.DB
      .prepare(
        `UPDATE media_uploads
         SET status = 'failed', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(uploadId)
      .run();
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "multipart_completion_failed" },
      { status: 409 }
    );
  }
  if (object.size !== upload.expected_bytes) {
    await env.MEDIA_BUCKET.delete(upload.object_key);
    await env.DB
      .prepare(
        `UPDATE media_uploads
         SET status = 'failed', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(uploadId)
      .run();
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "completed_object_size_mismatch" },
      { status: 409 }
    );
  }
  await env.DB
    .prepare(
      `UPDATE media_uploads
       SET
         status = 'completed',
         completed_bytes = ?,
         object_etag = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(object.size, object.httpEtag, uploadId)
    .run();
  if (upload.episode_id) {
    if (upload.kind === "delivery_audio") {
      await env.DB
        .prepare(
          `UPDATE episodes
           SET
             audio_key = ?,
             audio_mime_type = ?,
             audio_bytes = ?,
             audio_etag = ?,
             audio_filename = ?,
             media_status = 'ready',
             updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(
          upload.object_key,
          upload.content_type,
          object.size,
          object.httpEtag,
          upload.filename,
          upload.episode_id
        )
        .run();
    } else if (upload.kind === "source_audio") {
      await env.DB
        .prepare(
          `UPDATE episodes
           SET
             source_audio_key = ?,
             media_status = CASE WHEN audio_key IS NULL THEN 'processing' ELSE media_status END,
             updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(upload.object_key, upload.episode_id)
        .run();
    } else if (upload.kind === "video_source") {
      await env.DB
        .prepare(
          `UPDATE episodes
           SET video_source_key = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(upload.object_key, upload.episode_id)
        .run();
    }
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "media_upload.completed",
    targetType: "media_upload",
    targetId: uploadId,
    metadata: {
      showId: upload.show_id,
      episodeId: upload.episode_id,
      kind: upload.kind,
      bytes: object.size
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    uploadId,
    completed: true,
    bytes: object.size,
    etag: object.httpEtag
  });
}

export async function abortMultipartUpload(
  request: Request,
  env: PodcastEnv,
  uploadIdValue: string
): Promise<Response> {
  const uploadId = validIdentifier(uploadIdValue, "uploadId");
  const upload = await loadUpload(env.DB, uploadId);
  if (!upload) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "upload_not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...UPLOAD_ROLES],
    requireCsrf: true,
    showId: upload.show_id
  });
  if (!auth.ok) return auth.response;
  if (upload.status === "uploading" || upload.status === "completing") {
    try {
      await env.MEDIA_BUCKET
        .resumeMultipartUpload(upload.object_key, upload.r2_upload_id)
        .abort();
    } catch {
      // R2 abort is idempotent from the product perspective.
    }
  }
  await env.DB
    .prepare(
      `UPDATE media_uploads
       SET status = 'aborted', updated_at = datetime('now')
       WHERE id = ? AND status != 'completed'`
    )
    .bind(uploadId)
    .run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "media_upload.aborted",
    targetType: "media_upload",
    targetId: uploadId,
    metadata: { showId: upload.show_id, episodeId: upload.episode_id }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, { uploadId, aborted: true });
}

async function loadUpload(
  db: D1Database,
  uploadId: string
): Promise<UploadRow | null> {
  return db
    .prepare(
      `SELECT
         id, show_id, episode_id, kind, object_key, r2_upload_id, filename,
         content_type, expected_bytes, status, completed_bytes, object_etag
       FROM media_uploads
       WHERE id = ?`
    )
    .bind(uploadId)
    .first<UploadRow>();
}

function validateContentType(kind: UploadKind, contentType: string): void {
  const allowed = kind === "source_audio" || kind === "delivery_audio"
    ? ["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac"]
    : kind === "video_source"
      ? ["video/mp4", "video/quicktime", "video/webm"]
      : kind === "artwork"
        ? ["image/jpeg", "image/png", "image/webp"]
        : ["text/plain", "text/vtt", "application/x-subrip", "application/json"];
  if (!allowed.includes(contentType)) {
    throw new RequestValidationError(`contentType is not allowed for ${kind}`);
  }
}
