import {
  hasAdminRoleForShow,
  requireAdmin,
  requireRecentAdminAuthentication,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAudit, recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import type { PodcastJob } from "./types";
import {
  optionalText,
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";
import {
  uploadUnlistedYouTubeVideo,
  verifyYouTubeChannelAccess,
  youtubeProviderDescription,
  YouTubeProviderError,
  youtubeProviderConfigured,
  youtubeProviderTitle
} from "./youtube-provider";

const EDIT_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const MAXIMUM_CLIP_UPLOAD_BYTES = 95 * 1024 * 1024;

type ReadyClipRenderRow = {
  render_id: string;
  clip_id: string;
  clip_revision: number;
  current_clip_revision: number;
  show_id: string;
  youtube_channel_url: string | null;
  render_status: string;
  output_object_key: string;
  output_object_bytes: number | null;
  output_sha256: string | null;
  output_mime_type: string | null;
  processor_manifest_sha256: string;
};

type ClipYouTubePublicationRow = ReadyClipRenderRow & {
  id: string;
  channel_url: string;
  channel_id: string | null;
  privacy_status: "private" | "unlisted";
  title: string;
  description: string;
  status: string;
  provider_video_id: string | null;
  failure_code: string | null;
  requested_by_admin_user_id: string | null;
  approved_by_admin_user_id: string | null;
  requested_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export async function createAdminClipYouTubeDraft(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return clipYoutubeNotFound(request, env);
  }
  const renderId = validIdentifier(renderIdValue, "renderId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: EDIT_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const render = await loadReadyClipRender(env.DB, renderId);
  if (
    !render
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      EDIT_ROLES,
      render.show_id
    )
  ) {
    return clipYoutubeNotFound(request, env);
  }
  const body = await readJsonObject(request, 20_000);
  const publicationId = validIdentifier(
    body.publicationId,
    "publicationId"
  );
  const expectedClipRevision = positiveInteger(
    body.expectedClipRevision,
    "expectedClipRevision"
  );
  if (
    render.clip_revision !== expectedClipRevision
    || render.current_clip_revision !== expectedClipRevision
    || !readyRenderEvidencePresent(render)
  ) {
    return clipYoutubeConflict(request, env, "clip_render_not_current");
  }
  const privacyStatus = validPrivacyStatus(body.privacyStatus);
  const title = providerTitle(body.title);
  const description = providerDescription(body.description);
  const channelUrl = requiredText(
    body.confirmChannelUrl,
    "confirmChannelUrl",
    2_000
  );
  if (
    !render.youtube_channel_url
    || channelUrl !== render.youtube_channel_url
    || channelUrl !== env.YOUTUBE_CHANNEL_URL
  ) {
    throw new RequestValidationError(
      "confirmChannelUrl must exactly match the configured show channel"
    );
  }
  const existing = await loadClipYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (existing) {
    if (!sameDraft(existing, {
      renderId,
      expectedClipRevision,
      privacyStatus,
      title,
      description,
      channelUrl
    })) {
      return clipYoutubeConflict(
        request,
        env,
        "clip_youtube_publication_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentClipYouTubePublication(existing),
      idempotent: true
    });
  }
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO clip_youtube_publications (
       id, show_id, clip_id, clip_revision, render_id, channel_url,
       privacy_status, title, description, requested_by_admin_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    publicationId,
    render.show_id,
    render.clip_id,
    expectedClipRevision,
    renderId,
    channelUrl,
    privacyStatus,
    title,
    description,
    auth.authorization.identity.id
  ).run();
  const created = await loadClipYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!created || !sameDraft(created, {
    renderId,
    expectedClipRevision,
    privacyStatus,
    title,
    description,
    channelUrl
  })) {
    return clipYoutubeConflict(
      request,
      env,
      "clip_youtube_render_already_prepared"
    );
  }
  if (Number(insert.meta.changes ?? 0) === 1) {
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "clip.youtube_draft_created",
      targetType: "clip_youtube_publication",
      targetId: publicationId,
      metadata: {
        showId: render.show_id,
        clipId: render.clip_id,
        renderId,
        clipRevision: expectedClipRevision,
        privacyStatus
      }
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentClipYouTubePublication(created),
    idempotent: Number(insert.meta.changes ?? 0) !== 1
  });
}

export async function approveAdminClipYouTubePublication(
  request: Request,
  env: PodcastEnv,
  publicationIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return clipYoutubeNotFound(request, env);
  }
  const publicationId = validIdentifier(
    publicationIdValue,
    "publicationId"
  );
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
  const publication = await loadClipYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!publication) return clipYoutubeNotFound(request, env);
  const publishMode = String(env.YOUTUBE_PUBLISH_MODE ?? "dry_run");
  if (["queued", "uploading", "uploaded"].includes(
    publication.status
  )) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentClipYouTubePublication(publication),
      idempotent: true
    });
  }
  if (publication.status === "dry_run" && publishMode === "dry_run") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentClipYouTubePublication(publication),
      idempotent: true
    });
  }
  const promotableDryRun = publication.status === "dry_run"
    && publishMode === "controlled_test";
  if (
    (publication.status !== "draft" && !promotableDryRun)
    || publication.render_status !== "ready"
    || publication.clip_revision !== publication.current_clip_revision
    || !readyRenderEvidencePresent(publication)
    || publication.channel_url !== publication.youtube_channel_url
    || publication.channel_url !== env.YOUTUBE_CHANNEL_URL
  ) {
    return clipYoutubeConflict(
      request,
      env,
      "clip_youtube_publication_not_ready"
    );
  }
  const objectHead = await verifiedRenderObject(env, publication);
  if (!objectHead) {
    return clipYoutubeConflict(
      request,
      env,
      "clip_render_object_mismatch"
    );
  }
  if (publishMode === "dry_run") {
    const updated = await env.DB.prepare(
      `UPDATE clip_youtube_publications
       SET
         status = 'dry_run',
         approved_by_admin_user_id = ?,
         approved_at = datetime('now'),
         completed_at = datetime('now'),
         failure_code = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'draft'`
    ).bind(
      auth.authorization.identity.id,
      publicationId
    ).run();
    if (Number(updated.meta.changes ?? 0) !== 1) {
      return clipYoutubeConflict(
        request,
        env,
        "clip_youtube_publication_conflict"
      );
    }
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "clip.youtube_dry_run_approved",
      targetType: "clip_youtube_publication",
      targetId: publicationId,
      metadata: {
        showId: publication.show_id,
        clipId: publication.clip_id,
        renderId: publication.render_id,
        privacyStatus: publication.privacy_status,
        objectBytes: objectHead.size
      }
    });
    const completedDryRun = await loadClipYouTubePublicationById(
      env.DB,
      publicationId
    );
    if (!completedDryRun) {
      return clipYoutubeConflict(
        request,
        env,
        "clip_youtube_publication_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentClipYouTubePublication(completedDryRun),
      idempotent: false
    });
  }
  if (
    publishMode !== "controlled_test"
    || !youtubeProviderConfigured(env)
    || !env.YOUTUBE_CHANNEL_ID
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "youtube_controlled_test_not_configured" },
      { status: 503 }
    );
  }
  let verifiedChannelId: string;
  try {
    const verified = await verifyYouTubeChannelAccess(env);
    verifiedChannelId = verified.channelId;
  } catch (error) {
    const code = error instanceof YouTubeProviderError
      ? error.code
      : "youtube_channel_verification_failed";
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: code },
      { status: 503 }
    );
  }
  const queued = await env.DB.prepare(
    `UPDATE clip_youtube_publications
     SET
       status = 'queued',
       channel_id = ?,
       approved_by_admin_user_id = ?,
       approved_at = datetime('now'),
       started_at = NULL,
       completed_at = NULL,
       failure_code = NULL,
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('draft', 'dry_run')`
  ).bind(
    verifiedChannelId,
    auth.authorization.identity.id,
    publicationId
  ).run();
  if (Number(queued.meta.changes ?? 0) !== 1) {
    return clipYoutubeConflict(
      request,
      env,
      "clip_youtube_publication_conflict"
    );
  }
  try {
    await env.JOBS.send({
      id: publicationId,
      type: "publish-youtube-clip",
      showId: publication.show_id,
      clipRenderId: publication.render_id,
      clipPublicationId: publicationId,
      requestedAt: new Date().toISOString()
    } satisfies PodcastJob);
  } catch {
    await env.DB.prepare(
      `UPDATE clip_youtube_publications
       SET
         status = 'failed',
         failure_code = 'youtube_queue_failed',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(publicationId).run();
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "youtube_queue_failed" },
      { status: 503 }
    );
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "clip.youtube_controlled_test_queued",
    targetType: "clip_youtube_publication",
    targetId: publicationId,
    metadata: {
      showId: publication.show_id,
      clipId: publication.clip_id,
      renderId: publication.render_id,
      privacyStatus: publication.privacy_status,
      channelId: verifiedChannelId,
      promotedFromDryRun: promotableDryRun
    }
  });
  const queuedPublication = await loadClipYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!queuedPublication) {
    return clipYoutubeConflict(
      request,
      env,
      "clip_youtube_publication_conflict"
    );
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      publication: presentClipYouTubePublication(queuedPublication),
      idempotent: false
    },
    { status: 202 }
  );
}

export async function processClipYouTubePublication(
  env: PodcastEnv,
  job: PodcastJob
): Promise<void> {
  if (!job.clipPublicationId || !job.clipRenderId) {
    throw new Error("Controlled YouTube clip job is invalid");
  }
  if (
    env.ENVIRONMENT !== "staging"
    || String(env.YOUTUBE_PUBLISH_MODE) !== "controlled_test"
  ) {
    await env.DB.prepare(
      `UPDATE clip_youtube_publications
       SET
         status = 'failed',
         failure_code = 'youtube_mode_disabled',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND render_id = ? AND status = 'queued'`
    ).bind(job.clipPublicationId, job.clipRenderId).run();
    return;
  }
  const publication = await loadClipYouTubePublicationById(
    env.DB,
    validIdentifier(job.clipPublicationId, "clipPublicationId")
  );
  if (
    !publication
    || publication.render_id !== job.clipRenderId
    || publication.status !== "queued"
  ) {
    return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE clip_youtube_publications
     SET
       status = 'uploading',
       started_at = COALESCE(started_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ? AND status = 'queued'`
  ).bind(publication.id).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) return;
  try {
    const objectHead = await verifiedRenderObject(env, publication);
    if (!objectHead) {
      throw new YouTubeProviderError("clip_render_object_mismatch");
    }
    const object = await env.MEDIA_BUCKET.get(
      publication.output_object_key,
      { onlyIf: new Headers({ "if-match": objectHead.httpEtag }) }
    );
    if (
      !object
      || !("body" in object)
      || object.size !== publication.output_object_bytes
      || object.httpEtag !== objectHead.httpEtag
    ) {
      throw new YouTubeProviderError("clip_render_object_mismatch");
    }
    const uploaded = await uploadUnlistedYouTubeVideo(env, {
      title: publication.title,
      description: publication.description,
      privacyStatus: publication.privacy_status,
      contentLength: publication.output_object_bytes as number,
      body: object.body
    });
    const auditActor = publication.approved_by_admin_user_id
      ?? publication.requested_by_admin_user_id;
    if (!auditActor) {
      throw new YouTubeProviderError("youtube_state_commit_failed");
    }
    const [completed] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE clip_youtube_publications
         SET
           status = 'uploaded',
           provider_video_id = ?,
           failure_code = NULL,
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status = 'uploading'`
      ).bind(uploaded.videoId, publication.id),
      prepareAdminAudit(env.DB, {
        adminUserId: auditActor,
        action: "clip.youtube_controlled_test_uploaded",
        targetType: "clip_youtube_publication",
        targetId: publication.id,
        metadata: {
          showId: publication.show_id,
          clipId: publication.clip_id,
          renderId: publication.render_id,
          privacyStatus: publication.privacy_status,
          providerVideoId: uploaded.videoId
        }
      })
    ]);
    if (Number(completed.meta.changes ?? 0) !== 1) {
      throw new YouTubeProviderError("youtube_state_commit_failed");
    }
  } catch (error) {
    const failureCode = error instanceof YouTubeProviderError
      ? error.code
      : "youtube_upload_failed";
    await env.DB.prepare(
      `UPDATE clip_youtube_publications
       SET
         status = 'failed',
         failure_code = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'uploading'`
    ).bind(failureCode.slice(0, 160), publication.id).run();
    throw error;
  }
}

async function verifiedRenderObject(
  env: PodcastEnv,
  render: ReadyClipRenderRow
): Promise<R2Object | null> {
  if (!readyRenderEvidencePresent(render)) return null;
  const object = await env.MEDIA_BUCKET.head(render.output_object_key);
  if (
    !object
    || object.size !== render.output_object_bytes
    || object.size > MAXIMUM_CLIP_UPLOAD_BYTES
    || object.httpMetadata?.contentType !== "video/mp4"
    || object.checksums.toJSON().sha256 !== render.output_sha256
    || object.customMetadata?.sha256 !== render.output_sha256
    || object.customMetadata?.["render-manifest-sha256"]
      !== render.processor_manifest_sha256
  ) {
    return null;
  }
  return object;
}

async function loadReadyClipRender(
  db: D1Database,
  renderId: string
): Promise<ReadyClipRenderRow | null> {
  return db.prepare(
    `${readyRenderSelect()}
     WHERE r.id = ?`
  ).bind(renderId).first<ReadyClipRenderRow>();
}

async function loadClipYouTubePublicationById(
  db: D1Database,
  publicationId: string
): Promise<ClipYouTubePublicationRow | null> {
  return db.prepare(
    `SELECT
       p.id, p.channel_url, p.channel_id, p.privacy_status, p.title,
       p.description, p.status, p.provider_video_id, p.failure_code,
       p.requested_by_admin_user_id, p.approved_by_admin_user_id,
       p.requested_at, p.approved_at, p.started_at, p.completed_at,
       p.updated_at,
       r.id AS render_id, r.clip_id, r.clip_revision,
       c.revision AS current_clip_revision, e.show_id,
       s.youtube_channel_url,
       r.status AS render_status, r.output_object_key,
       r.output_object_bytes, r.output_sha256, r.output_mime_type,
       r.processor_manifest_sha256
     FROM clip_youtube_publications p
     JOIN clip_renders r ON r.id = p.render_id
     JOIN clips c ON c.id = r.clip_id
     JOIN episodes e ON e.id = c.episode_id
     JOIN shows s ON s.id = e.show_id
     WHERE p.id = ?`
  ).bind(publicationId).first<ClipYouTubePublicationRow>();
}

function readyRenderSelect(): string {
  return `SELECT
      r.id AS render_id, r.clip_id, r.clip_revision,
      c.revision AS current_clip_revision, e.show_id,
      s.youtube_channel_url,
      r.status AS render_status, r.output_object_key,
      r.output_object_bytes, r.output_sha256, r.output_mime_type,
      r.processor_manifest_sha256
    FROM clip_renders r
    JOIN clips c ON c.id = r.clip_id
    JOIN episodes e ON e.id = c.episode_id
    JOIN shows s ON s.id = e.show_id`;
}

function readyRenderEvidencePresent(render: ReadyClipRenderRow): boolean {
  return Boolean(
    render.render_status === "ready"
    && render.clip_revision === render.current_clip_revision
    && render.output_mime_type === "video/mp4"
    && render.output_object_bytes
    && render.output_object_bytes <= MAXIMUM_CLIP_UPLOAD_BYTES
    && render.output_sha256
  );
}

function sameDraft(
  publication: ClipYouTubePublicationRow,
  expected: {
    renderId: string;
    expectedClipRevision: number;
    privacyStatus: "private" | "unlisted";
    title: string;
    description: string;
    channelUrl: string;
  }
): boolean {
  return publication.render_id === expected.renderId
    && publication.clip_revision === expected.expectedClipRevision
    && publication.privacy_status === expected.privacyStatus
    && publication.title === expected.title
    && publication.description === expected.description
    && publication.channel_url === expected.channelUrl;
}

function validPrivacyStatus(value: unknown): "private" | "unlisted" {
  const status = requiredText(value, "privacyStatus", 20);
  if (status !== "private" && status !== "unlisted") {
    throw new RequestValidationError(
      "privacyStatus must be private or unlisted"
    );
  }
  return status;
}

function providerTitle(value: unknown): string {
  const title = requiredText(value, "title", 100);
  try {
    return youtubeProviderTitle(title);
  } catch {
    throw new RequestValidationError("title contains control characters");
  }
}

function providerDescription(value: unknown): string {
  const description = optionalText(value, "description", 5_000);
  try {
    return youtubeProviderDescription(description);
  } catch {
    throw new RequestValidationError(
      "description contains control characters"
    );
  }
}

function presentClipYouTubePublication(
  row: ClipYouTubePublicationRow
): Record<string, unknown> {
  return {
    id: row.id,
    renderId: row.render_id,
    clipId: row.clip_id,
    clipRevision: row.clip_revision,
    channelUrl: row.channel_url,
    channelId: row.channel_id,
    privacyStatus: row.privacy_status,
    title: row.title,
    description: row.description,
    status: row.status,
    providerVideoId: row.provider_video_id,
    failureCode: row.failure_code,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function clipYoutubeNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "clip_youtube_publication_not_found" },
    { status: 404 }
  );
}

function clipYoutubeConflict(
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
