import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
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
const APPROVE_ROLES: AdminRole[] = ["super_admin", "admin"];
const REVIEW_STATUSES = new Set([
  "draft",
  "ready_for_review",
  "changes_requested",
  "approved"
]);
const RESOLUTION_STATUSES = new Set(["open", "resolved"]);
const TARGET_TYPES = new Set([
  "source_audio",
  "transcript",
  "chapters",
  "clip",
  "ad_plan"
]);
const MAXIMUM_REVIEW_COMMENTS = 500;

type ReviewTargetType =
  | "source_audio"
  | "transcript"
  | "chapters"
  | "clip"
  | "ad_plan";

type ReviewTarget = {
  type: ReviewTargetType;
  id: string;
  revision: number;
  digest: string;
  label: string;
};

type ReviewRow = {
  id: string;
  episode_id: string;
  target_type: ReviewTargetType;
  target_id: string;
  target_revision: number;
  target_digest: string;
  status: string;
  revision: number;
  assigned_to_admin_user_id: string | null;
  approved_by_admin_user_id: string | null;
  approved_at: string | null;
  created_by_admin_user_id: string | null;
  updated_by_admin_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: string;
  review_id: string;
  starts_at_ms: number | null;
  ends_at_ms: number | null;
  body_text: string;
  blocker: number;
  resolution_status: string;
  revision: number;
  assigned_to_admin_user_id: string | null;
  created_by_admin_user_id: string | null;
  updated_by_admin_user_id: string | null;
  resolved_by_admin_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProductionReviewReadiness = {
  currentTargetCount: number;
  currentReviewCount: number;
  approvedCurrentReviewCount: number;
  unreviewedCurrentTargetCount: number;
  openBlockerCount: number;
  evidenceTruncated: boolean;
  reviewReady: boolean;
  publishingEnforced: false;
};

type ReviewAuthorization = {
  authorization: AdminAuthorization;
  review: ReviewRow;
  showId: string;
  durationSeconds: number | null;
};

type CommentAuthorization = ReviewAuthorization & {
  comment: CommentRow;
};

export async function listAdminEpisodeReviews(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    READ_ROLES
  );
  if (authorized instanceof Response) return authorized;
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    await presentEpisodeReviews(
      env.DB,
      authorized.episode.id,
      authorized.episode.durationSeconds
    )
  );
}

export async function createAdminEpisodeReviewComment(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (authorized instanceof Response) return authorized;
  const body = await readJsonObject(request);
  const commentId = validIdentifier(body.commentId, "commentId");
  const targetType = reviewTargetType(body.targetType);
  const targetId = validIdentifier(body.targetId, "targetId");
  const comment = normalizeReviewComment(
    body,
    authorized.episode.durationSeconds
  );
  await ensureAssignableAdmin(
    env.DB,
    authorized.episode.showId,
    comment.assignedToAdminUserId
  );
  const targets = await loadCurrentReviewTargets(
    env.DB,
    authorized.episode.id
  );
  const target = targets.find(
    (candidate) =>
      candidate.type === targetType && candidate.id === targetId
  );
  if (!target) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "review_target_not_current" },
      { status: 409 }
    );
  }
  const reviewId = await deterministicReviewId(
    authorized.episode.id,
    target
  );
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO production_reviews (
         id, episode_id, target_type, target_id, target_revision,
         target_digest, assigned_to_admin_user_id, created_by_admin_user_id,
         updated_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      reviewId,
      authorized.episode.id,
      target.type,
      target.id,
      target.revision,
      target.digest,
      comment.assignedToAdminUserId,
      authorized.authorization.identity.id,
      authorized.authorization.identity.id
    )
    .run();

  const replay = await env.DB
    .prepare(
      `SELECT
         review_id, starts_at_ms, ends_at_ms, body_text, blocker,
         assigned_to_admin_user_id
       FROM production_review_comments
       WHERE id = ?`
    )
    .bind(commentId)
    .first<{
      review_id: string;
      starts_at_ms: number | null;
      ends_at_ms: number | null;
      body_text: string;
      blocker: number;
      assigned_to_admin_user_id: string | null;
    }>();
  if (replay) {
    if (
      replay.review_id !== reviewId
      || replay.starts_at_ms !== comment.startsAtMs
      || replay.ends_at_ms !== comment.endsAtMs
      || replay.body_text !== comment.bodyText
      || replay.blocker !== (comment.blocker ? 1 : 0)
      || replay.assigned_to_admin_user_id !== comment.assignedToAdminUserId
    ) {
      return conflict(request, env, "review_comment_id_conflict");
    }
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        ...(await presentEpisodeReviews(
          env.DB,
          authorized.episode.id,
          authorized.episode.durationSeconds
        )),
        idempotent: true
      }
    );
  }

  const auditId = await deterministicAuditId(
    "production-review-comment-create",
    commentId
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO production_review_comments (
         id, review_id, starts_at_ms, ends_at_ms, body_text, blocker,
         assigned_to_admin_user_id, created_by_admin_user_id,
         updated_by_admin_user_id
       )
       SELECT ?, id, ?, ?, ?, ?, ?, ?, ?
       FROM production_reviews
       WHERE id = ? AND episode_id = ?`
    ).bind(
      commentId,
      comment.startsAtMs,
      comment.endsAtMs,
      comment.bodyText,
      comment.blocker ? 1 : 0,
      comment.assignedToAdminUserId,
      authorized.authorization.identity.id,
      authorized.authorization.identity.id,
      reviewId,
      authorized.episode.id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'production_review.comment_created', 'episode', ?, ?
       FROM production_review_comments
       WHERE id = ? AND review_id = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      authorized.episode.id,
      JSON.stringify({
        reviewId,
        commentId,
        targetType: target.type,
        targetRevision: target.revision,
        blocker: comment.blocker,
        hasRange: comment.startsAtMs !== null
      }),
      commentId,
      reviewId
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const concurrentReplay = await env.DB
      .prepare(
        `SELECT
           review_id, starts_at_ms, ends_at_ms, body_text, blocker,
           assigned_to_admin_user_id
         FROM production_review_comments
         WHERE id = ?`
      )
      .bind(commentId)
      .first<{
        review_id: string;
        starts_at_ms: number | null;
        ends_at_ms: number | null;
        body_text: string;
        blocker: number;
        assigned_to_admin_user_id: string | null;
      }>();
    if (
      concurrentReplay
      && concurrentReplay.review_id === reviewId
      && concurrentReplay.starts_at_ms === comment.startsAtMs
      && concurrentReplay.ends_at_ms === comment.endsAtMs
      && concurrentReplay.body_text === comment.bodyText
      && concurrentReplay.blocker === (comment.blocker ? 1 : 0)
      && concurrentReplay.assigned_to_admin_user_id
        === comment.assignedToAdminUserId
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        {
          ...(await presentEpisodeReviews(
            env.DB,
            authorized.episode.id,
            authorized.episode.durationSeconds
          )),
          idempotent: true
        }
      );
    }
    return conflict(request, env, "review_comment_id_conflict");
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      ...(await presentEpisodeReviews(
        env.DB,
        authorized.episode.id,
        authorized.episode.durationSeconds
      )),
      idempotent: false
    },
    { status: 201 }
  );
}

export async function updateAdminProductionReview(
  request: Request,
  env: PodcastEnv,
  reviewIdValue: string
): Promise<Response> {
  const authorized = await authorizeReview(
    request,
    env,
    reviewIdValue,
    EDIT_ROLES,
    true
  );
  if (authorized instanceof Response) return authorized;
  const body = await readJsonObject(request);
  const mutationId = validIdentifier(body.mutationId, "mutationId");
  const baseRevision = nonNegativeInteger(body.baseRevision, "baseRevision");
  const status = reviewStatus(body.status);
  const assignedToAdminUserId = optionalIdentifier(
    body.assignedToAdminUserId,
    "assignedToAdminUserId"
  );
  const canApprove = hasAdminRoleForShow(
    authorized.authorization.identity,
    APPROVE_ROLES,
    authorized.showId
  );
  if (
    (status === "approved" || authorized.review.status === "approved")
    && !canApprove
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "review_approval_forbidden" },
      { status: 403 }
    );
  }
  if (status === "approved") {
    const openBlocker = await env.DB
      .prepare(
        `SELECT 1
         FROM production_review_comments
         WHERE review_id = ?
           AND blocker = 1
           AND resolution_status = 'open'
         LIMIT 1`
      )
      .bind(authorized.review.id)
      .first<{ 1: number }>();
    if (openBlocker) {
      return conflict(request, env, "review_open_blockers");
    }
    const currentTargets = await loadCurrentReviewTargets(
      env.DB,
      authorized.review.episode_id
    );
    const remainsCurrent = currentTargets.some((target) =>
      targetKey(target) === targetKey({
        type: authorized.review.target_type,
        id: authorized.review.target_id,
        revision: authorized.review.target_revision,
        digest: authorized.review.target_digest,
        label: ""
      })
    );
    if (!remainsCurrent) {
      return conflict(request, env, "review_target_not_current");
    }
  }
  await ensureAssignableAdmin(
    env.DB,
    authorized.showId,
    assignedToAdminUserId
  );
  const payload = JSON.stringify({ status, assignedToAdminUserId });
  const payloadSha256 = await sha256Hex(payload);
  const replay = await findMutation(env.DB, mutationId);
  if (replay) {
    if (
      replay.entity_type !== "review"
      || replay.entity_id !== authorized.review.id
      || replay.base_revision !== baseRevision
      || replay.payload_sha256 !== payloadSha256
    ) {
      return conflict(request, env, "review_mutation_conflict");
    }
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        ...(await presentEpisodeReviews(
          env.DB,
          authorized.review.episode_id,
          authorized.durationSeconds
        )),
        idempotent: true
      }
    );
  }

  const targetRevision = baseRevision + 1;
  const auditId = await deterministicAuditId(
    "production-review-state",
    mutationId
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO production_review_mutations (
         id, entity_type, entity_id, base_revision, target_revision,
         payload_sha256, admin_user_id
       )
       SELECT ?, 'review', id, ?, ?, ?, ?
       FROM production_reviews
       WHERE id = ? AND revision = ?`
    ).bind(
      mutationId,
      baseRevision,
      targetRevision,
      payloadSha256,
      authorized.authorization.identity.id,
      authorized.review.id,
      baseRevision
    ),
    env.DB.prepare(
      `UPDATE production_reviews
       SET
         status = ?,
         assigned_to_admin_user_id = ?,
         revision = ?,
         approved_by_admin_user_id =
           CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
         approved_at =
           CASE WHEN ? = 'approved' THEN datetime('now') ELSE NULL END,
         updated_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM production_review_mutations mutation
           WHERE mutation.id = ?
             AND mutation.entity_type = 'review'
             AND mutation.entity_id = production_reviews.id
             AND mutation.target_revision = ?
             AND mutation.payload_sha256 = ?
         )`
    ).bind(
      status,
      assignedToAdminUserId,
      targetRevision,
      status,
      authorized.authorization.identity.id,
      status,
      authorized.authorization.identity.id,
      authorized.review.id,
      baseRevision,
      mutationId,
      targetRevision,
      payloadSha256
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'production_review.state_changed', 'episode', ?, ?
       FROM production_review_mutations
       WHERE id = ? AND entity_type = 'review' AND entity_id = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      authorized.review.episode_id,
      JSON.stringify({
        reviewId: authorized.review.id,
        revision: targetRevision,
        status,
        assigned: assignedToAdminUserId !== null
      }),
      mutationId,
      authorized.review.id
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    const concurrentReplay = await findMutation(env.DB, mutationId);
    if (
      concurrentReplay?.entity_type === "review"
      && concurrentReplay.entity_id === authorized.review.id
      && concurrentReplay.base_revision === baseRevision
      && concurrentReplay.payload_sha256 === payloadSha256
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        {
          ...(await presentEpisodeReviews(
            env.DB,
            authorized.review.episode_id,
            authorized.durationSeconds
          )),
          idempotent: true
        }
      );
    }
    return conflict(request, env, "review_revision_conflict", {
      currentRevision: await currentEntityRevision(
        env.DB,
        "production_reviews",
        authorized.review.id
      )
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    ...(await presentEpisodeReviews(
      env.DB,
      authorized.review.episode_id,
      authorized.durationSeconds
    )),
    idempotent: false
  });
}

export async function updateAdminProductionReviewComment(
  request: Request,
  env: PodcastEnv,
  commentIdValue: string
): Promise<Response> {
  const authorized = await authorizeComment(
    request,
    env,
    commentIdValue,
    EDIT_ROLES,
    true
  );
  if (authorized instanceof Response) return authorized;
  const body = await readJsonObject(request);
  const mutationId = validIdentifier(body.mutationId, "mutationId");
  const baseRevision = nonNegativeInteger(body.baseRevision, "baseRevision");
  const resolutionStatus = resolutionState(body.resolutionStatus);
  const assignedToAdminUserId = optionalIdentifier(
    body.assignedToAdminUserId,
    "assignedToAdminUserId"
  );
  await ensureAssignableAdmin(
    env.DB,
    authorized.showId,
    assignedToAdminUserId
  );
  const payload = JSON.stringify({
    resolutionStatus,
    assignedToAdminUserId
  });
  const payloadSha256 = await sha256Hex(payload);
  const replay = await findMutation(env.DB, mutationId);
  if (replay) {
    if (
      replay.entity_type !== "comment"
      || replay.entity_id !== authorized.comment.id
      || replay.base_revision !== baseRevision
      || replay.payload_sha256 !== payloadSha256
    ) {
      return conflict(request, env, "review_mutation_conflict");
    }
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        ...(await presentEpisodeReviews(
          env.DB,
          authorized.review.episode_id,
          authorized.durationSeconds
        )),
        idempotent: true
      }
    );
  }

  const targetRevision = baseRevision + 1;
  const auditId = await deterministicAuditId(
    "production-review-comment-state",
    mutationId
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO production_review_mutations (
         id, entity_type, entity_id, base_revision, target_revision,
         payload_sha256, admin_user_id
       )
       SELECT ?, 'comment', id, ?, ?, ?, ?
       FROM production_review_comments
       WHERE id = ? AND revision = ?`
    ).bind(
      mutationId,
      baseRevision,
      targetRevision,
      payloadSha256,
      authorized.authorization.identity.id,
      authorized.comment.id,
      baseRevision
    ),
    env.DB.prepare(
      `UPDATE production_review_comments
       SET
         resolution_status = ?,
         assigned_to_admin_user_id = ?,
         revision = ?,
         resolved_by_admin_user_id =
           CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
         resolved_at =
           CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END,
         updated_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM production_review_mutations mutation
           WHERE mutation.id = ?
             AND mutation.entity_type = 'comment'
             AND mutation.entity_id = production_review_comments.id
             AND mutation.target_revision = ?
             AND mutation.payload_sha256 = ?
         )`
    ).bind(
      resolutionStatus,
      assignedToAdminUserId,
      targetRevision,
      resolutionStatus,
      authorized.authorization.identity.id,
      resolutionStatus,
      authorized.authorization.identity.id,
      authorized.comment.id,
      baseRevision,
      mutationId,
      targetRevision,
      payloadSha256
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'production_review.comment_state_changed', 'episode', ?, ?
       FROM production_review_mutations
       WHERE id = ? AND entity_type = 'comment' AND entity_id = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      authorized.review.episode_id,
      JSON.stringify({
        reviewId: authorized.review.id,
        commentId: authorized.comment.id,
        revision: targetRevision,
        resolutionStatus,
        assigned: assignedToAdminUserId !== null
      }),
      mutationId,
      authorized.comment.id
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    const concurrentReplay = await findMutation(env.DB, mutationId);
    if (
      concurrentReplay?.entity_type === "comment"
      && concurrentReplay.entity_id === authorized.comment.id
      && concurrentReplay.base_revision === baseRevision
      && concurrentReplay.payload_sha256 === payloadSha256
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        {
          ...(await presentEpisodeReviews(
            env.DB,
            authorized.review.episode_id,
            authorized.durationSeconds
          )),
          idempotent: true
        }
      );
    }
    return conflict(request, env, "review_comment_revision_conflict", {
      currentRevision: await currentEntityRevision(
        env.DB,
        "production_review_comments",
        authorized.comment.id
      )
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    ...(await presentEpisodeReviews(
      env.DB,
      authorized.review.episode_id,
      authorized.durationSeconds
    )),
    idempotent: false
  });
}

async function presentEpisodeReviews(
  db: D1Database,
  episodeId: string,
  durationSeconds: number | null
): Promise<Record<string, unknown>> {
  const [targets, reviewRows] = await Promise.all([
    loadCurrentReviewTargets(db, episodeId),
    db.prepare(
      `SELECT
         id, episode_id, target_type, target_id, target_revision,
         target_digest, status, revision, assigned_to_admin_user_id,
         approved_by_admin_user_id, approved_at,
         created_by_admin_user_id, updated_by_admin_user_id,
         created_at, updated_at
       FROM production_reviews
       WHERE episode_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 100`
    ).bind(episodeId).all<ReviewRow>()
  ]);
  const reviews = reviewRows.results;
  const comments = reviews.length > 0
    ? await db.prepare(
        `SELECT
           id, review_id, starts_at_ms, ends_at_ms, body_text, blocker,
           resolution_status, revision, assigned_to_admin_user_id,
           created_by_admin_user_id, updated_by_admin_user_id,
           resolved_by_admin_user_id, resolved_at, created_at, updated_at
         FROM production_review_comments
         WHERE review_id IN (${reviews.map(() => "?").join(",")})
         ORDER BY created_at, id
         LIMIT ${MAXIMUM_REVIEW_COMMENTS + 1}`
      ).bind(...reviews.map(({ id }) => id)).all<CommentRow>()
    : { results: [] as CommentRow[] };
  const truncated = comments.results.length > MAXIMUM_REVIEW_COMMENTS;
  const boundedComments = comments.results.slice(0, MAXIMUM_REVIEW_COMMENTS);
  const commentsByReview = new Map<string, CommentRow[]>();
  for (const comment of boundedComments) {
    const current = commentsByReview.get(comment.review_id) ?? [];
    current.push(comment);
    commentsByReview.set(comment.review_id, current);
  }
  const currentTargets = new Map(
    targets.map((target) => [targetKey(target), target])
  );
  const presented = reviews.map((review) => {
    const exactTarget = currentTargets.get(targetKey({
      type: review.target_type,
      id: review.target_id,
      revision: review.target_revision,
      digest: review.target_digest,
      label: ""
    }));
    return {
      id: review.id,
      targetType: review.target_type,
      targetId: review.target_id,
      targetRevision: review.target_revision,
      targetLabel: exactTarget?.label ?? historicalTargetLabel(review),
      isCurrent: Boolean(exactTarget),
      status: review.status,
      revision: review.revision,
      assignedToAdminUserId: review.assigned_to_admin_user_id,
      approvedByAdminUserId: review.approved_by_admin_user_id,
      approvedAt: review.approved_at,
      createdByAdminUserId: review.created_by_admin_user_id,
      updatedByAdminUserId: review.updated_by_admin_user_id,
      createdAt: review.created_at,
      updatedAt: review.updated_at,
      comments: (commentsByReview.get(review.id) ?? []).map(
        presentComment
      )
    };
  });
  const currentReviews = presented.filter(({ isCurrent }) => isCurrent);
  const currentReviewIds = new Set(currentReviews.map(({ id }) => id));
  const readiness = summarizeProductionReviewReadiness(
    targets,
    currentReviews.map((review) => ({
      id: review.id,
      status: review.status
    })),
    boundedComments
      .filter((comment) => currentReviewIds.has(comment.review_id))
      .map((comment) => ({
        reviewId: comment.review_id,
        blocker: comment.blocker === 1,
        resolutionStatus: comment.resolution_status
      })),
    truncated
  );
  return {
    episodeId,
    durationSeconds,
    targetOptions: targets.map((target) => ({
      type: target.type,
      id: target.id,
      revision: target.revision,
      label: target.label
    })),
    reviews: presented,
    truncated,
    readiness
  };
}

export async function getProductionReviewReadiness(
  db: D1Database,
  episodeId: string
): Promise<ProductionReviewReadiness> {
  const [targets, reviewRows] = await Promise.all([
    loadCurrentReviewTargets(db, episodeId),
    db.prepare(
      `SELECT
         id, episode_id, target_type, target_id, target_revision,
         target_digest, status, revision, assigned_to_admin_user_id,
         approved_by_admin_user_id, approved_at,
         created_by_admin_user_id, updated_by_admin_user_id,
         created_at, updated_at
       FROM production_reviews
       WHERE episode_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 101`
    ).bind(episodeId).all<ReviewRow>()
  ]);
  const evidenceTruncated = reviewRows.results.length > 100;
  const currentTargets = new Set(targets.map(targetKey));
  const currentReviews = reviewRows.results.slice(0, 100).filter((review) =>
    currentTargets.has(targetKey({
      type: review.target_type,
      id: review.target_id,
      revision: review.target_revision,
      digest: review.target_digest,
      label: ""
    }))
  );
  const commentRows = currentReviews.length === 0
    ? { results: [] as Array<{
        review_id: string;
        blocker: number;
        resolution_status: string;
      }> }
    : await db.prepare(
        `SELECT review_id, blocker, resolution_status
         FROM production_review_comments
         WHERE review_id IN (${currentReviews.map(() => "?").join(",")})
         LIMIT ${MAXIMUM_REVIEW_COMMENTS + 1}`
      ).bind(...currentReviews.map(({ id }) => id)).all<{
        review_id: string;
        blocker: number;
        resolution_status: string;
      }>();
  return summarizeProductionReviewReadiness(
    targets,
    currentReviews,
    commentRows.results.slice(0, MAXIMUM_REVIEW_COMMENTS).map((comment) => ({
      reviewId: comment.review_id,
      blocker: comment.blocker === 1,
      resolutionStatus: comment.resolution_status
    })),
    evidenceTruncated
      || commentRows.results.length > MAXIMUM_REVIEW_COMMENTS
  );
}

export function summarizeProductionReviewReadiness(
  targets: Array<Pick<ReviewTarget, "type" | "id" | "revision" | "digest">>,
  currentReviews: Array<{ id: string; status: string }>,
  comments: Array<{
    reviewId: string;
    blocker: boolean;
    resolutionStatus: string;
  }>,
  evidenceTruncated = false
): ProductionReviewReadiness {
  const currentReviewIds = new Set(currentReviews.map(({ id }) => id));
  const openBlockerCount = comments.filter((comment) =>
    currentReviewIds.has(comment.reviewId)
    && comment.blocker
    && comment.resolutionStatus === "open"
  ).length;
  const approvedCurrentReviewCount = currentReviews.filter(
    ({ status }) => status === "approved"
  ).length;
  const unreviewedCurrentTargetCount = Math.max(
    0,
    targets.length - currentReviews.length
  );
  return {
    currentTargetCount: targets.length,
    currentReviewCount: currentReviews.length,
    approvedCurrentReviewCount,
    unreviewedCurrentTargetCount,
    openBlockerCount,
    evidenceTruncated,
    reviewReady: targets.length > 0
      && unreviewedCurrentTargetCount === 0
      && openBlockerCount === 0
      && !evidenceTruncated
      && approvedCurrentReviewCount === targets.length,
    publishingEnforced: false
  };
}

function presentComment(comment: CommentRow): Record<string, unknown> {
  return {
    id: comment.id,
    startsAtMs: comment.starts_at_ms,
    endsAtMs: comment.ends_at_ms,
    bodyText: comment.body_text,
    blocker: comment.blocker === 1,
    resolutionStatus: comment.resolution_status,
    revision: comment.revision,
    assignedToAdminUserId: comment.assigned_to_admin_user_id,
    createdByAdminUserId: comment.created_by_admin_user_id,
    updatedByAdminUserId: comment.updated_by_admin_user_id,
    resolvedByAdminUserId: comment.resolved_by_admin_user_id,
    resolvedAt: comment.resolved_at,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at
  };
}

async function loadCurrentReviewTargets(
  db: D1Database,
  episodeId: string
): Promise<ReviewTarget[]> {
  const [episode, transcripts, chapters, clips, adPlans] = await Promise.all([
    db.prepare(
      `SELECT
         id, publication_revision, audio_etag, media_status
       FROM episodes
       WHERE id = ?`
    ).bind(episodeId).first<{
      id: string;
      publication_revision: number;
      audio_etag: string | null;
      media_status: string;
    }>(),
    db.prepare(
      `SELECT id, language, revision, content_sha256
       FROM transcripts
       WHERE episode_id = ? AND revision > 0 AND content_sha256 IS NOT NULL
       ORDER BY language`
    ).bind(episodeId).all<{
      id: string;
      language: string;
      revision: number;
      content_sha256: string;
    }>(),
    db.prepare(
      `SELECT episode_id, revision, content_sha256
       FROM episode_chapter_sets
       WHERE episode_id = ? AND revision > 0 AND content_sha256 IS NOT NULL`
    ).bind(episodeId).first<{
      episode_id: string;
      revision: number;
      content_sha256: string;
    }>(),
    db.prepare(
      `SELECT id, title, revision, recipe_sha256
       FROM clips
       WHERE episode_id = ? AND revision > 0 AND recipe_sha256 IS NOT NULL
       ORDER BY updated_at DESC, id
       LIMIT 50`
    ).bind(episodeId).all<{
      id: string;
      title: string;
      revision: number;
      recipe_sha256: string;
    }>(),
    db.prepare(
      `SELECT id, revision, processor_manifest_sha256
       FROM episode_ad_plans
       WHERE episode_id = ? AND processor_manifest_sha256 IS NOT NULL
       ORDER BY revision DESC
       LIMIT 1`
    ).bind(episodeId).all<{
      id: string;
      revision: number;
      processor_manifest_sha256: string;
    }>()
  ]);
  const targets: ReviewTarget[] = [];
  if (
    episode
    && episode.audio_etag
    && episode.media_status === "ready"
  ) {
    targets.push({
      type: "source_audio",
      id: episode.id,
      revision: episode.publication_revision,
      digest: boundedDigest(episode.audio_etag),
      label: "Working audio"
    });
  }
  targets.push(...transcripts.results.map((transcript) => ({
    type: "transcript" as const,
    id: transcript.id,
    revision: transcript.revision,
    digest: transcript.content_sha256,
    label: `Transcript · ${transcript.language.toUpperCase()}`
  })));
  if (chapters) {
    targets.push({
      type: "chapters",
      id: chapters.episode_id,
      revision: chapters.revision,
      digest: chapters.content_sha256,
      label: "Chapters"
    });
  }
  targets.push(...clips.results.map((clip) => ({
    type: "clip" as const,
    id: clip.id,
    revision: clip.revision,
    digest: clip.recipe_sha256,
    label: `Clip · ${clip.title}`
  })));
  targets.push(...adPlans.results.map((plan) => ({
    type: "ad_plan" as const,
    id: plan.id,
    revision: plan.revision,
    digest: plan.processor_manifest_sha256,
    label: `Ad plan · revision ${plan.revision}`
  })));
  return targets;
}

async function authorizeReview(
  request: Request,
  env: PodcastEnv,
  reviewIdValue: string,
  roles: AdminRole[],
  requireCsrf: boolean
): Promise<ReviewAuthorization | Response> {
  const reviewId = validIdentifier(reviewIdValue, "reviewId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: roles,
    requireCsrf
  });
  if (!auth.ok) return auth.response;
  const review = await env.DB.prepare(
    `SELECT
       review.id, review.episode_id, review.target_type, review.target_id,
       review.target_revision, review.target_digest, review.status,
       review.revision, review.assigned_to_admin_user_id,
       review.approved_by_admin_user_id, review.approved_at,
       review.created_by_admin_user_id, review.updated_by_admin_user_id,
       review.created_at, review.updated_at, episode.show_id,
       episode.duration_seconds
     FROM production_reviews review
     JOIN episodes episode ON episode.id = review.episode_id
     WHERE review.id = ?`
  ).bind(reviewId).first<ReviewRow & {
    show_id: string;
    duration_seconds: number | null;
  }>();
  if (
    !review
    || !hasAdminRoleForShow(auth.authorization.identity, roles, review.show_id)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "review_not_found" },
      { status: 404 }
    );
  }
  return {
    authorization: auth.authorization,
    review,
    showId: review.show_id,
    durationSeconds: review.duration_seconds
  };
}

async function authorizeComment(
  request: Request,
  env: PodcastEnv,
  commentIdValue: string,
  roles: AdminRole[],
  requireCsrf: boolean
): Promise<CommentAuthorization | Response> {
  const commentId = validIdentifier(commentIdValue, "commentId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: roles,
    requireCsrf
  });
  if (!auth.ok) return auth.response;
  const row = await env.DB.prepare(
    `SELECT
       comment.id AS comment_id, comment.review_id,
       comment.starts_at_ms, comment.ends_at_ms, comment.body_text,
       comment.blocker, comment.resolution_status,
       comment.revision AS comment_revision,
       comment.assigned_to_admin_user_id AS comment_assigned_to,
       comment.created_by_admin_user_id AS comment_created_by,
       comment.updated_by_admin_user_id AS comment_updated_by,
       comment.resolved_by_admin_user_id, comment.resolved_at,
       comment.created_at AS comment_created_at,
       comment.updated_at AS comment_updated_at,
       review.id, review.episode_id, review.target_type, review.target_id,
       review.target_revision, review.target_digest, review.status,
       review.revision, review.assigned_to_admin_user_id,
       review.approved_by_admin_user_id, review.approved_at,
       review.created_by_admin_user_id, review.updated_by_admin_user_id,
       review.created_at, review.updated_at, episode.show_id,
       episode.duration_seconds
     FROM production_review_comments comment
     JOIN production_reviews review ON review.id = comment.review_id
     JOIN episodes episode ON episode.id = review.episode_id
     WHERE comment.id = ?`
  ).bind(commentId).first<Record<string, unknown>>();
  const showId = String(row?.show_id ?? "");
  if (
    !row
    || !hasAdminRoleForShow(auth.authorization.identity, roles, showId)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "review_comment_not_found" },
      { status: 404 }
    );
  }
  const review: ReviewRow = {
    id: String(row.id),
    episode_id: String(row.episode_id),
    target_type: row.target_type as ReviewTargetType,
    target_id: String(row.target_id),
    target_revision: Number(row.target_revision),
    target_digest: String(row.target_digest),
    status: String(row.status),
    revision: Number(row.revision),
    assigned_to_admin_user_id:
      nullableString(row.assigned_to_admin_user_id),
    approved_by_admin_user_id:
      nullableString(row.approved_by_admin_user_id),
    approved_at: nullableString(row.approved_at),
    created_by_admin_user_id:
      nullableString(row.created_by_admin_user_id),
    updated_by_admin_user_id:
      nullableString(row.updated_by_admin_user_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
  const comment: CommentRow = {
    id: String(row.comment_id),
    review_id: String(row.review_id),
    starts_at_ms: nullableNumber(row.starts_at_ms),
    ends_at_ms: nullableNumber(row.ends_at_ms),
    body_text: String(row.body_text),
    blocker: Number(row.blocker),
    resolution_status: String(row.resolution_status),
    revision: Number(row.comment_revision),
    assigned_to_admin_user_id: nullableString(row.comment_assigned_to),
    created_by_admin_user_id: nullableString(row.comment_created_by),
    updated_by_admin_user_id: nullableString(row.comment_updated_by),
    resolved_by_admin_user_id:
      nullableString(row.resolved_by_admin_user_id),
    resolved_at: nullableString(row.resolved_at),
    created_at: String(row.comment_created_at),
    updated_at: String(row.comment_updated_at)
  };
  return {
    authorization: auth.authorization,
    review,
    comment,
    showId,
    durationSeconds: nullableNumber(row.duration_seconds)
  };
}

async function ensureAssignableAdmin(
  db: D1Database,
  showId: string,
  adminUserId: string | null
): Promise<void> {
  if (adminUserId === null) return;
  const match = await db.prepare(
    `SELECT 1
     FROM admin_users user
     JOIN admin_user_roles role ON role.admin_user_id = user.id
     WHERE user.id = ?
       AND user.status = 'active'
       AND (
         role.role = 'super_admin'
         OR role.show_id IS NULL
         OR role.show_id = ?
       )
     LIMIT 1`
  ).bind(adminUserId, showId).first<{ 1: number }>();
  if (!match) {
    throw new RequestValidationError(
      "assignedToAdminUserId is not an active show team member"
    );
  }
}

export function normalizeReviewComment(
  body: Record<string, unknown>,
  durationSeconds: number | null
): {
  startsAtMs: number | null;
  endsAtMs: number | null;
  bodyText: string;
  blocker: boolean;
  assignedToAdminUserId: string | null;
} {
  const startsAtMs = optionalMillisecond(body.startsAtMs, "startsAtMs");
  const endsAtMs = optionalMillisecond(body.endsAtMs, "endsAtMs");
  if (startsAtMs === null && endsAtMs !== null) {
    throw new RequestValidationError(
      "endsAtMs requires a startsAtMs value"
    );
  }
  if (
    startsAtMs !== null
    && endsAtMs !== null
    && endsAtMs <= startsAtMs
  ) {
    throw new RequestValidationError("endsAtMs must be after startsAtMs");
  }
  const durationMs = durationSeconds === null
    ? null
    : durationSeconds * 1_000;
  if (
    durationMs !== null
    && (
      (startsAtMs !== null && startsAtMs >= durationMs)
      || (endsAtMs !== null && endsAtMs > durationMs)
    )
  ) {
    throw new RequestValidationError(
      "The review range is outside the episode duration"
    );
  }
  if ("blocker" in body && typeof body.blocker !== "boolean") {
    throw new RequestValidationError("blocker must be a boolean");
  }
  return {
    startsAtMs,
    endsAtMs,
    bodyText: safeCommentText(body.bodyText),
    blocker: body.blocker === true,
    assignedToAdminUserId: optionalIdentifier(
      body.assignedToAdminUserId,
      "assignedToAdminUserId"
    )
  };
}

function safeCommentText(value: unknown): string {
  const text = requiredText(value, "bodyText", 4_000)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
  if (
    !text
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(
      text
    )
  ) {
    throw new RequestValidationError(
      "bodyText contains unsafe control characters"
    );
  }
  return text;
}

function reviewTargetType(value: unknown): ReviewTargetType {
  const type = String(value ?? "");
  if (!TARGET_TYPES.has(type)) {
    throw new RequestValidationError("targetType is invalid");
  }
  return type as ReviewTargetType;
}

function reviewStatus(value: unknown): string {
  const status = String(value ?? "");
  if (!REVIEW_STATUSES.has(status)) {
    throw new RequestValidationError("status is invalid");
  }
  return status;
}

function resolutionState(value: unknown): string {
  const status = String(value ?? "");
  if (!RESOLUTION_STATUSES.has(status)) {
    throw new RequestValidationError("resolutionStatus is invalid");
  }
  return status;
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return validIdentifier(value, field);
}

function optionalMillisecond(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < 0
    || number > 86_400_000
  ) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RequestValidationError(`${field} must be a non-negative integer`);
  }
  return number;
}

function boundedDigest(value: string): string {
  const digest = value.normalize("NFKC").trim();
  if (
    !digest
    || digest.length > 256
    || /[\u0000-\u001f\u007f]/.test(digest)
  ) {
    throw new RequestValidationError("The review target digest is invalid");
  }
  return digest;
}

async function deterministicReviewId(
  episodeId: string,
  target: ReviewTarget
): Promise<string> {
  const digest = await sha256Hex([
    "production-review:v1",
    episodeId,
    target.type,
    target.id,
    target.revision,
    target.digest
  ].join(":"));
  return `review_${digest.slice(0, 32)}`;
}

async function deterministicAuditId(
  purpose: string,
  operationId: string
): Promise<string> {
  const digest = await sha256Hex(`${purpose}:v1:${operationId}`);
  return `audit_${digest.slice(0, 32)}`;
}

function targetKey(target: ReviewTarget): string {
  return [
    target.type,
    target.id,
    target.revision,
    target.digest
  ].join("\u001f");
}

function historicalTargetLabel(review: ReviewRow): string {
  const names: Record<ReviewTargetType, string> = {
    source_audio: "Working audio",
    transcript: "Transcript",
    chapters: "Chapters",
    clip: "Clip",
    ad_plan: "Ad plan"
  };
  return `${names[review.target_type]} · revision ${review.target_revision}`;
}

async function findMutation(
  db: D1Database,
  mutationId: string
): Promise<{
  entity_type: string;
  entity_id: string;
  base_revision: number;
  payload_sha256: string;
} | null> {
  return db.prepare(
    `SELECT entity_type, entity_id, base_revision, payload_sha256
     FROM production_review_mutations
     WHERE id = ?`
  ).bind(mutationId).first();
}

async function currentEntityRevision(
  db: D1Database,
  table: "production_reviews" | "production_review_comments",
  entityId: string
): Promise<number | null> {
  const row = await db.prepare(
    `SELECT revision FROM ${table} WHERE id = ?`
  ).bind(entityId).first<{ revision: number }>();
  return row?.revision ?? null;
}

function conflict(
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

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
