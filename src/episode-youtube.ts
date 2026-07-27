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
  verifyYouTubeVideo,
  youtubeProviderConfigured,
  youtubeProviderDescription,
  YouTubeProviderError,
  youtubeProviderTitle
} from "./youtube-provider";

const EDIT_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const MAXIMUM_EPISODE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const EPISODE_UPLOAD_TIMEOUT_MS = 13 * 60_000;
const AMBIGUOUS_PROVIDER_FAILURES = new Set([
  "youtube_upload_failed",
  "youtube_upload_incomplete",
  "youtube_verification_failed",
  "youtube_state_commit_failed"
]);

type ReadyEpisodeVideoRow = {
  episode_id: string;
  show_id: string;
  current_publication_revision: number;
  access: string;
  episode_status: string;
  video_source_key: string | null;
  episode_title: string;
  episode_summary: string;
  youtube_channel_url: string | null;
  distribution_job_id: string;
  distribution_job_status: string;
  scheduled_at: string;
  distribution_provider_id: string | null;
  video_upload_id: string;
  upload_status: string;
  upload_object_key: string;
  upload_object_bytes: number | null;
  upload_object_etag: string | null;
  upload_content_type: string;
};

type EpisodeYouTubePublicationRow = ReadyEpisodeVideoRow & {
  id: string;
  publication_revision: number;
  video_object_key: string;
  video_object_bytes: number;
  video_object_etag: string;
  video_content_type: string;
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

export async function createAdminEpisodeYouTubeDraft(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return episodeYoutubeNotFound(request, env);
  }
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const episode = await loadReadyEpisodeVideo(env.DB, episodeId);
  if (!episode) return episodeYoutubeNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: EDIT_ROLES,
    requireCsrf: true,
    showId: episode.show_id
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request, 20_000);
  const publicationId = validIdentifier(
    body.publicationId,
    "publicationId"
  );
  const expectedPublicationRevision = positiveInteger(
    body.expectedPublicationRevision,
    "expectedPublicationRevision"
  );
  if (
    expectedPublicationRevision !== episode.current_publication_revision
    || !readyEpisodeVideoEvidencePresent(episode)
  ) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_video_not_current"
    );
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
    !episode.youtube_channel_url
    || channelUrl !== episode.youtube_channel_url
    || channelUrl !== env.YOUTUBE_CHANNEL_URL
  ) {
    throw new RequestValidationError(
      "confirmChannelUrl must exactly match the configured show channel"
    );
  }
  const objectHead = await verifiedEpisodeVideoObject(env, episode);
  if (!objectHead) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_video_object_mismatch"
    );
  }
  const existing = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (existing) {
    if (!sameDraft(existing, {
      episodeId,
      expectedPublicationRevision,
      privacyStatus,
      title,
      description,
      channelUrl
    })) {
      return episodeYoutubeConflict(
        request,
        env,
        "episode_youtube_publication_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentEpisodeYouTubePublication(existing),
      idempotent: true
    });
  }
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO episode_youtube_publications (
       id, show_id, episode_id, publication_revision, distribution_job_id,
       video_upload_id, video_object_key, video_object_bytes,
       video_object_etag, video_content_type, channel_url, privacy_status,
       title, description, requested_by_admin_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    publicationId,
    episode.show_id,
    episodeId,
    expectedPublicationRevision,
    episode.distribution_job_id,
    episode.video_upload_id,
    episode.upload_object_key,
    episode.upload_object_bytes,
    episode.upload_object_etag,
    episode.upload_content_type,
    channelUrl,
    privacyStatus,
    title,
    description,
    auth.authorization.identity.id
  ).run();
  const created = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!created || !sameDraft(created, {
    episodeId,
    expectedPublicationRevision,
    privacyStatus,
    title,
    description,
    channelUrl
  })) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_youtube_revision_already_prepared"
    );
  }
  if (Number(insert.meta.changes ?? 0) === 1) {
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "episode.youtube_draft_created",
      targetType: "episode_youtube_publication",
      targetId: publicationId,
      metadata: {
        showId: episode.show_id,
        episodeId,
        publicationRevision: expectedPublicationRevision,
        distributionJobId: episode.distribution_job_id,
        videoUploadId: episode.video_upload_id,
        videoObjectBytes: objectHead.size,
        privacyStatus
      }
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentEpisodeYouTubePublication(created),
    idempotent: Number(insert.meta.changes ?? 0) !== 1
  });
}

export async function approveAdminEpisodeYouTubePublication(
  request: Request,
  env: PodcastEnv,
  publicationIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return episodeYoutubeNotFound(request, env);
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
  const publication = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (
    !publication
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      ["super_admin"],
      publication.show_id
    )
  ) {
    return episodeYoutubeNotFound(request, env);
  }
  if (["queued", "uploading", "uploaded"].includes(publication.status)) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentEpisodeYouTubePublication(publication),
      idempotent: true
    });
  }
  if (
    publication.status === "reconciliation_required"
    || !publicationReadyForApproval(publication)
    || publication.channel_url !== env.YOUTUBE_CHANNEL_URL
    || !["draft", "dry_run", "failed"].includes(publication.status)
  ) {
    return episodeYoutubeConflict(
      request,
      env,
      publication.status === "reconciliation_required"
        ? "episode_youtube_reconciliation_required"
        : "episode_youtube_publication_not_ready"
    );
  }
  const objectHead = await verifiedEpisodeVideoObject(env, publication);
  if (!objectHead) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_video_object_mismatch"
    );
  }
  const publishMode = String(env.YOUTUBE_PUBLISH_MODE ?? "dry_run");
  if (publication.status === "dry_run" && publishMode === "dry_run") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentEpisodeYouTubePublication(publication),
      idempotent: true
    });
  }
  if (publishMode === "dry_run") {
    const updated = await env.DB.prepare(
      `UPDATE episode_youtube_publications
       SET
         status = 'dry_run',
         approved_by_admin_user_id = ?,
         approved_at = datetime('now'),
         completed_at = datetime('now'),
         failure_code = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('draft', 'failed')`
    ).bind(auth.authorization.identity.id, publicationId).run();
    if (Number(updated.meta.changes ?? 0) !== 1) {
      return episodeYoutubeConflict(
        request,
        env,
        "episode_youtube_publication_conflict"
      );
    }
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "episode.youtube_dry_run_approved",
      targetType: "episode_youtube_publication",
      targetId: publicationId,
      metadata: {
        showId: publication.show_id,
        episodeId: publication.episode_id,
        publicationRevision: publication.publication_revision,
        videoObjectBytes: objectHead.size
      }
    });
    const dryRun = await loadEpisodeYouTubePublicationById(
      env.DB,
      publicationId
    );
    if (!dryRun) {
      return episodeYoutubeConflict(
        request,
        env,
        "episode_youtube_publication_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentEpisodeYouTubePublication(dryRun),
      idempotent: false
    });
  }
  if (
    publishMode !== "controlled_test"
    || publication.privacy_status !== "unlisted"
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
  const [queuedPublication, queuedJob] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE episode_youtube_publications
       SET
         status = 'queued',
         channel_id = ?,
         approved_by_admin_user_id = ?,
         approved_at = datetime('now'),
         started_at = NULL,
         completed_at = NULL,
         failure_code = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('draft', 'dry_run', 'failed')`
    ).bind(
      env.YOUTUBE_CHANNEL_ID,
      auth.authorization.identity.id,
      publicationId
    ),
    env.DB.prepare(
      `UPDATE distribution_jobs
       SET
         status = 'queued',
         started_at = NULL,
         completed_at = NULL,
         provider_id = NULL,
         last_error = NULL
       WHERE id = ?
         AND episode_id = ?
         AND publication_revision = ?
         AND destination = 'youtube'
         AND (
           status IN ('queued', 'failed')
           OR (status = 'succeeded' AND provider_id = 'dry-run')
         )`
    ).bind(
      publication.distribution_job_id,
      publication.episode_id,
      publication.publication_revision
    )
  ]);
  if (
    Number(queuedPublication.meta.changes ?? 0) !== 1
    || Number(queuedJob.meta.changes ?? 0) !== 1
  ) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_youtube_publication_conflict"
    );
  }
  const due = parseDatabaseDate(publication.scheduled_at).getTime()
    <= Date.now();
  if (due) {
    try {
      await env.JOBS.send({
        id: publication.distribution_job_id,
        type: "publish-youtube",
        showId: publication.show_id,
        episodeId: publication.episode_id,
        publicationRevision: publication.publication_revision,
        requestedAt: new Date().toISOString()
      } satisfies PodcastJob);
    } catch {
      await failQueuedPublication(
        env.DB,
        publication,
        "youtube_queue_failed"
      );
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "youtube_queue_failed" },
        { status: 503 }
      );
    }
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "episode.youtube_controlled_test_queued",
    targetType: "episode_youtube_publication",
    targetId: publicationId,
    metadata: {
      showId: publication.show_id,
      episodeId: publication.episode_id,
      publicationRevision: publication.publication_revision,
      distributionJobId: publication.distribution_job_id,
      channelId: env.YOUTUBE_CHANNEL_ID,
      privacyStatus: publication.privacy_status,
      queuedImmediately: due
    }
  });
  const queued = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!queued) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_youtube_publication_conflict"
    );
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      publication: presentEpisodeYouTubePublication(queued),
      idempotent: false
    },
    { status: 202 }
  );
}

export async function reconcileAdminEpisodeYouTubePublication(
  request: Request,
  env: PodcastEnv,
  publicationIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return episodeYoutubeNotFound(request, env);
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
  const publication = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (
    !publication
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      ["super_admin"],
      publication.show_id
    )
  ) {
    return episodeYoutubeNotFound(request, env);
  }
  if (publication.status !== "reconciliation_required") {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_youtube_reconciliation_not_required"
    );
  }
  const body = await readJsonObject(request, 10_000);
  const outcome = requiredText(body.outcome, "outcome", 32);
  if (outcome !== "uploaded" && outcome !== "not_uploaded") {
    throw new RequestValidationError(
      "outcome must be uploaded or not_uploaded"
    );
  }
  const confirmation = requiredText(
    body.confirmation,
    "confirmation",
    80
  );
  if (outcome === "uploaded") {
    if (confirmation !== "CONFIRM_VERIFIED_UNLISTED_VIDEO") {
      throw new RequestValidationError(
        "confirmation must acknowledge the verified unlisted video"
      );
    }
    if (
      !youtubeProviderConfigured(env)
      || publication.channel_id !== env.YOUTUBE_CHANNEL_ID
      || publication.channel_url !== env.YOUTUBE_CHANNEL_URL
      || publication.privacy_status !== "unlisted"
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "youtube_reconciliation_not_configured" },
        { status: 503 }
      );
    }
    const providerVideoId = requiredText(
      body.providerVideoId,
      "providerVideoId",
      64
    );
    try {
      await verifyYouTubeVideo(env, {
        videoId: providerVideoId,
        privacyStatus: "unlisted"
      });
    } catch (error) {
      const code = error instanceof YouTubeProviderError
        ? error.code
        : "youtube_verification_failed";
      return episodeYoutubeConflict(request, env, code);
    }
    const [updatedPublication, updatedJob] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE episode_youtube_publications
         SET
           status = 'uploaded',
           provider_video_id = ?,
           failure_code = NULL,
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status = 'reconciliation_required'`
      ).bind(providerVideoId, publicationId),
      env.DB.prepare(
        `UPDATE distribution_jobs
         SET
           status = CASE WHEN status = 'canceled' THEN status ELSE 'succeeded' END,
           provider_id = ?,
           last_error = NULL,
           completed_at = datetime('now')
         WHERE id = ?
           AND episode_id = ?
           AND publication_revision = ?
           AND destination = 'youtube'`
      ).bind(
        providerVideoId,
        publication.distribution_job_id,
        publication.episode_id,
        publication.publication_revision
      ),
      env.DB.prepare(
        `UPDATE episodes
         SET youtube_video_id = ?, updated_at = datetime('now')
         WHERE id = ?
           AND publication_revision = ?
           AND video_source_key = ?`
      ).bind(
        providerVideoId,
        publication.episode_id,
        publication.publication_revision,
        publication.video_object_key
      ),
      prepareAdminAudit(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "episode.youtube_reconciled_uploaded",
        targetType: "episode_youtube_publication",
        targetId: publicationId,
        metadata: {
          showId: publication.show_id,
          episodeId: publication.episode_id,
          publicationRevision: publication.publication_revision,
          providerVideoId
        }
      })
    ]);
    if (
      Number(updatedPublication.meta.changes ?? 0) !== 1
      || Number(updatedJob.meta.changes ?? 0) !== 1
    ) {
      return episodeYoutubeConflict(
        request,
        env,
        "episode_youtube_reconciliation_conflict"
      );
    }
  } else {
    if (confirmation !== "CONFIRM_NO_CHANNEL_VIDEO_REMAINS") {
      throw new RequestValidationError(
        "confirmation must acknowledge that no channel video remains"
      );
    }
    const [updatedPublication, updatedJob] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE episode_youtube_publications
         SET
           status = 'failed',
           failure_code = 'youtube_reconciled_no_video',
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status = 'reconciliation_required'`
      ).bind(publicationId),
      env.DB.prepare(
        `UPDATE distribution_jobs
         SET
           status = CASE WHEN status = 'canceled' THEN status ELSE 'failed' END,
           provider_id = NULL,
           last_error = 'youtube_reconciled_no_video',
           completed_at = datetime('now')
         WHERE id = ?
           AND episode_id = ?
           AND publication_revision = ?
           AND destination = 'youtube'`
      ).bind(
        publication.distribution_job_id,
        publication.episode_id,
        publication.publication_revision
      ),
      prepareAdminAudit(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "episode.youtube_reconciled_no_video",
        targetType: "episode_youtube_publication",
        targetId: publicationId,
        metadata: {
          showId: publication.show_id,
          episodeId: publication.episode_id,
          publicationRevision: publication.publication_revision
        }
      })
    ]);
    if (
      Number(updatedPublication.meta.changes ?? 0) !== 1
      || Number(updatedJob.meta.changes ?? 0) !== 1
    ) {
      return episodeYoutubeConflict(
        request,
        env,
        "episode_youtube_reconciliation_conflict"
      );
    }
  }
  const reconciled = await loadEpisodeYouTubePublicationById(
    env.DB,
    publicationId
  );
  if (!reconciled) {
    return episodeYoutubeConflict(
      request,
      env,
      "episode_youtube_reconciliation_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentEpisodeYouTubePublication(reconciled),
    reconciled: true
  });
}

export async function processEpisodeYouTubePublication(
  env: PodcastEnv,
  job: PodcastJob
): Promise<string> {
  if (!job.episodeId || !job.publicationRevision) {
    throw new Error("YouTube episode job is invalid");
  }
  const publishMode = String(env.YOUTUBE_PUBLISH_MODE ?? "dry_run");
  if (publishMode === "dry_run") return "dry-run";
  if (
    env.ENVIRONMENT !== "staging"
    || publishMode !== "controlled_test"
    || !youtubeProviderConfigured(env)
  ) {
    throw new YouTubeProviderError("youtube_mode_disabled");
  }
  const publication = await loadEpisodeYouTubePublicationForJob(
    env.DB,
    job.id,
    job.episodeId,
    job.publicationRevision
  );
  if (!publication) {
    throw new YouTubeProviderError("youtube_approval_required");
  }
  if (publication.status === "uploaded" && publication.provider_video_id) {
    return publication.provider_video_id;
  }
  if (
    publication.status === "uploading"
    || publication.status === "reconciliation_required"
  ) {
    throw new YouTubeProviderError(
      "youtube_upload_state_requires_reconciliation"
    );
  }
  if (
    publication.status !== "queued"
    || !publicationReadyForApproval(publication)
    || publication.channel_url !== env.YOUTUBE_CHANNEL_URL
    || publication.channel_id !== env.YOUTUBE_CHANNEL_ID
    || publication.privacy_status !== "unlisted"
  ) {
    throw new YouTubeProviderError("youtube_approval_required");
  }
  const claimed = await env.DB.prepare(
    `UPDATE episode_youtube_publications
     SET
       status = 'uploading',
       started_at = COALESCE(started_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ? AND status = 'queued'`
  ).bind(publication.id).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    throw new YouTubeProviderError("youtube_upload_claim_failed");
  }
  try {
    const objectHead = await verifiedEpisodeVideoObject(env, publication);
    if (!objectHead) {
      throw new YouTubeProviderError("episode_video_object_mismatch");
    }
    const object = await env.MEDIA_BUCKET.get(
      publication.video_object_key,
      { onlyIf: new Headers({ "if-match": objectHead.httpEtag }) }
    );
    if (
      !object
      || !("body" in object)
      || object.size !== publication.video_object_bytes
      || object.httpEtag !== objectHead.httpEtag
    ) {
      throw new YouTubeProviderError("episode_video_object_mismatch");
    }
    const uploaded = await uploadUnlistedYouTubeVideo(env, {
      title: publication.title,
      description: publication.description,
      privacyStatus: publication.privacy_status,
      contentLength: publication.video_object_bytes,
      body: object.body,
      uploadTimeoutMs: EPISODE_UPLOAD_TIMEOUT_MS
    });
    const auditActor = publication.approved_by_admin_user_id
      ?? publication.requested_by_admin_user_id;
    if (!auditActor) {
      throw new YouTubeProviderError("youtube_state_commit_failed");
    }
    const [completedPublication, completedEpisode] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE episode_youtube_publications
         SET
           status = 'uploaded',
           provider_video_id = ?,
           failure_code = NULL,
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status = 'uploading'`
      ).bind(uploaded.videoId, publication.id),
      env.DB.prepare(
        `UPDATE episodes
         SET youtube_video_id = ?, updated_at = datetime('now')
         WHERE id = ?
           AND publication_revision = ?
           AND video_source_key = ?`
      ).bind(
        uploaded.videoId,
        publication.episode_id,
        publication.publication_revision,
        publication.video_object_key
      ),
      prepareAdminAudit(env.DB, {
        adminUserId: auditActor,
        action: "episode.youtube_controlled_test_uploaded",
        targetType: "episode_youtube_publication",
        targetId: publication.id,
        metadata: {
          showId: publication.show_id,
          episodeId: publication.episode_id,
          publicationRevision: publication.publication_revision,
          privacyStatus: publication.privacy_status,
          providerVideoId: uploaded.videoId
        }
      })
    ]);
    if (
      Number(completedPublication.meta.changes ?? 0) !== 1
      || Number(completedEpisode.meta.changes ?? 0) !== 1
    ) {
      throw new YouTubeProviderError("youtube_state_commit_failed");
    }
    return uploaded.videoId;
  } catch (error) {
    const failureCode = error instanceof YouTubeProviderError
      ? error.code
      : "youtube_upload_failed";
    const status = AMBIGUOUS_PROVIDER_FAILURES.has(failureCode)
      ? "reconciliation_required"
      : "failed";
    await env.DB.prepare(
      `UPDATE episode_youtube_publications
       SET
         status = ?,
         failure_code = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'uploading'`
    ).bind(status, failureCode.slice(0, 160), publication.id).run();
    throw error;
  }
}

async function failQueuedPublication(
  db: D1Database,
  publication: EpisodeYouTubePublicationRow,
  failureCode: string
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE episode_youtube_publications
       SET
         status = 'failed',
         failure_code = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(failureCode, publication.id),
    db.prepare(
      `UPDATE distribution_jobs
       SET
         status = 'failed',
         last_error = ?,
         completed_at = datetime('now')
       WHERE id = ? AND status = 'queued'`
    ).bind(failureCode, publication.distribution_job_id)
  ]);
}

async function verifiedEpisodeVideoObject(
  env: PodcastEnv,
  video: ReadyEpisodeVideoRow | EpisodeYouTubePublicationRow
): Promise<R2Object | null> {
  if (!readyEpisodeVideoEvidencePresent(video)) return null;
  const key = "video_object_key" in video
    ? video.video_object_key
    : video.upload_object_key;
  const bytes = "video_object_bytes" in video
    ? video.video_object_bytes
    : video.upload_object_bytes;
  const etag = "video_object_etag" in video
    ? video.video_object_etag
    : video.upload_object_etag;
  const object = await env.MEDIA_BUCKET.head(key);
  if (
    !object
    || object.size !== bytes
    || object.size > MAXIMUM_EPISODE_UPLOAD_BYTES
    || object.httpEtag !== etag
    || object.httpMetadata?.contentType !== "video/mp4"
  ) {
    return null;
  }
  return object;
}

async function loadReadyEpisodeVideo(
  db: D1Database,
  episodeId: string
): Promise<ReadyEpisodeVideoRow | null> {
  return db.prepare(
    `${readyEpisodeVideoSelect()}
     WHERE e.id = ?
     ORDER BY upload.completed_at DESC
     LIMIT 1`
  ).bind(episodeId).first<ReadyEpisodeVideoRow>();
}

async function loadEpisodeYouTubePublicationById(
  db: D1Database,
  publicationId: string
): Promise<EpisodeYouTubePublicationRow | null> {
  return db.prepare(
    `${episodeYouTubePublicationSelect()}
     WHERE p.id = ?`
  ).bind(publicationId).first<EpisodeYouTubePublicationRow>();
}

async function loadEpisodeYouTubePublicationForJob(
  db: D1Database,
  distributionJobId: string,
  episodeId: string,
  publicationRevision: number
): Promise<EpisodeYouTubePublicationRow | null> {
  return db.prepare(
    `${episodeYouTubePublicationSelect()}
     WHERE p.distribution_job_id = ?
       AND p.episode_id = ?
       AND p.publication_revision = ?`
  ).bind(
    distributionJobId,
    episodeId,
    publicationRevision
  ).first<EpisodeYouTubePublicationRow>();
}

function readyEpisodeVideoSelect(): string {
  return `SELECT
      e.id AS episode_id, e.show_id,
      e.publication_revision AS current_publication_revision,
      e.access, e.status AS episode_status, e.video_source_key,
      e.title AS episode_title, e.summary AS episode_summary,
      s.youtube_channel_url,
      job.id AS distribution_job_id,
      job.status AS distribution_job_status,
      job.scheduled_at,
      job.provider_id AS distribution_provider_id,
      upload.id AS video_upload_id,
      upload.status AS upload_status,
      upload.object_key AS upload_object_key,
      upload.completed_bytes AS upload_object_bytes,
      upload.object_etag AS upload_object_etag,
      upload.content_type AS upload_content_type
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    JOIN distribution_jobs job
      ON job.episode_id = e.id
      AND job.destination = 'youtube'
      AND job.publication_revision = e.publication_revision
    JOIN media_uploads upload
      ON upload.episode_id = e.id
      AND upload.kind = 'video_source'
      AND upload.object_key = e.video_source_key`;
}

function episodeYouTubePublicationSelect(): string {
  return `SELECT
      p.id, p.episode_id, p.show_id, p.publication_revision,
      p.distribution_job_id, p.video_upload_id, p.video_object_key,
      p.video_object_bytes, p.video_object_etag, p.video_content_type,
      p.channel_url, p.channel_id, p.privacy_status, p.title,
      p.description, p.status, p.provider_video_id, p.failure_code,
      p.requested_by_admin_user_id, p.approved_by_admin_user_id,
      p.requested_at, p.approved_at, p.started_at, p.completed_at,
      p.updated_at,
      e.publication_revision AS current_publication_revision,
      e.access, e.status AS episode_status, e.video_source_key,
      e.title AS episode_title, e.summary AS episode_summary,
      s.youtube_channel_url,
      job.status AS distribution_job_status,
      job.scheduled_at,
      job.provider_id AS distribution_provider_id,
      upload.status AS upload_status,
      upload.object_key AS upload_object_key,
      upload.completed_bytes AS upload_object_bytes,
      upload.object_etag AS upload_object_etag,
      upload.content_type AS upload_content_type
    FROM episode_youtube_publications p
    JOIN episodes e
      ON e.id = p.episode_id
      AND e.show_id = p.show_id
    JOIN shows s ON s.id = p.show_id
    JOIN distribution_jobs job
      ON job.id = p.distribution_job_id
      AND job.episode_id = p.episode_id
      AND job.publication_revision = p.publication_revision
      AND job.destination = 'youtube'
    JOIN media_uploads upload
      ON upload.id = p.video_upload_id
      AND upload.episode_id = p.episode_id
      AND upload.show_id = p.show_id
      AND upload.kind = 'video_source'`;
}

function readyEpisodeVideoEvidencePresent(
  video: ReadyEpisodeVideoRow | EpisodeYouTubePublicationRow
): boolean {
  const key = "video_object_key" in video
    ? video.video_object_key
    : video.upload_object_key;
  const bytes = "video_object_bytes" in video
    ? video.video_object_bytes
    : video.upload_object_bytes;
  const etag = "video_object_etag" in video
    ? video.video_object_etag
    : video.upload_object_etag;
  const contentType = "video_content_type" in video
    ? video.video_content_type
    : video.upload_content_type;
  return Boolean(
    video.current_publication_revision > 0
    && ["scheduled", "published"].includes(video.episode_status)
    && video.access !== "premium_bonus"
    && video.video_source_key
    && key === video.video_source_key
    && video.upload_status === "completed"
    && video.upload_object_key === key
    && video.upload_object_bytes === bytes
    && video.upload_object_etag === etag
    && video.upload_content_type === contentType
    && contentType === "video/mp4"
    && bytes
    && bytes <= MAXIMUM_EPISODE_UPLOAD_BYTES
    && etag
  );
}

function publicationReadyForApproval(
  publication: EpisodeYouTubePublicationRow
): boolean {
  return Boolean(
    publication.publication_revision
      === publication.current_publication_revision
    && publication.distribution_job_id
    && publication.channel_url === publication.youtube_channel_url
    && publication.video_object_key === publication.video_source_key
    && readyEpisodeVideoEvidencePresent(publication)
  );
}

function sameDraft(
  publication: EpisodeYouTubePublicationRow,
  expected: {
    episodeId: string;
    expectedPublicationRevision: number;
    privacyStatus: "private" | "unlisted";
    title: string;
    description: string;
    channelUrl: string;
  }
): boolean {
  return publication.episode_id === expected.episodeId
    && publication.publication_revision
      === expected.expectedPublicationRevision
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
    throw new RequestValidationError("title contains invalid characters");
  }
}

function providerDescription(value: unknown): string {
  const description = optionalText(value, "description", 5_000);
  try {
    return youtubeProviderDescription(description);
  } catch {
    throw new RequestValidationError(
      "description contains invalid characters"
    );
  }
}

function presentEpisodeYouTubePublication(
  row: EpisodeYouTubePublicationRow
): Record<string, unknown> {
  return {
    id: row.id,
    episodeId: row.episode_id,
    publicationRevision: row.publication_revision,
    distributionJobId: row.distribution_job_id,
    videoUploadId: row.video_upload_id,
    videoObjectBytes: row.video_object_bytes,
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

function parseDatabaseDate(value: string): Date {
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid publication schedule");
  }
  return parsed;
}

function episodeYoutubeNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "episode_youtube_publication_not_found" },
    { status: 404 }
  );
}

function episodeYoutubeConflict(
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
