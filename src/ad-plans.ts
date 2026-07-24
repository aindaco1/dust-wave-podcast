import {
  sha256Hex
} from "@dustwave/worker-core/crypto";

import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import {
  prepareAdminAudit,
  recordAdminAudit
} from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { DYNAMIC_AD_MP3_PROFILE } from "./mp3-profile";
import { readSignedJsonBody } from "./signed-callback";
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
const REVIEW_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const PROCESSOR_MAXIMUM_BODY_BYTES = 200_000;
const POSITION_ORDER = { pre: 0, mid: 1, post: 2 } as const;

type EpisodeSourceRow = {
  id: string;
  show_id: string;
  duration_seconds: number | null;
  audio_key: string | null;
  audio_bytes: number | null;
  audio_etag: string | null;
  audio_mime_type: string | null;
  media_status: string;
};

type AdPlanRow = {
  id: string;
  episode_id: string;
  show_id: string;
  revision: number;
  status: AdPlanStatus;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_audio_mime_type: string;
  stream_profile: string;
  marker_manifest_json: string;
  segment_manifest_json: string | null;
  processor_report_json: string | null;
  processor_manifest_sha256: string | null;
  processor_version: string | null;
  submitted_at: string;
  processor_completed_at: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
};

type AdPlanStatus =
  | "pending_processor"
  | "needs_review"
  | "approved"
  | "rejected"
  | "failed"
  | "superseded";

type MarkerManifest = {
  position: keyof typeof POSITION_ORDER;
  startsAtMs: number | null;
};

type SegmentManifest = {
  id: string;
  sequence: number;
  objectKey: string;
  objectBytes: number;
  sourceOffset: 0;
  byteLength: number;
  audioMimeType: "audio/mpeg";
  streamProfile: typeof DYNAMIC_AD_MP3_PROFILE;
  sha256: string;
  durationMs: number;
  frameCount: number;
};

export async function getAdminEpisodeAdPlan(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await requireEpisodeAccess(
    request,
    env,
    episodeIdValue,
    READ_ROLES,
    false
  );
  if (!access.ok) return access.response;
  const [plan, markers, segments] = await Promise.all([
    loadLatestPlan(env.DB, access.episode.id),
    env.DB.prepare(
      `SELECT position, starts_at_ms, approved_at
       FROM episode_ad_markers
       WHERE episode_id = ? AND enabled = 1
       ORDER BY
         CASE position WHEN 'pre' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END`
    ).bind(access.episode.id).all<{
      position: string;
      starts_at_ms: number | null;
      approved_at: string | null;
    }>(),
    env.DB.prepare(
      `SELECT
         sequence, object_bytes, byte_length, stream_profile,
         validation_status, duration_ms, frame_count, validated_at
       FROM episode_audio_segments
       WHERE episode_id = ?
       ORDER BY sequence`
    ).bind(access.episode.id).all<Record<string, unknown>>()
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: access.episode.id,
    source: presentSource(access.episode),
    latestPlan: plan ? presentPlan(plan) : null,
    processorManifest: plan && access.episode.duration_seconds
      ? buildProcessorManifest(
          env,
          new URL(request.url).origin,
          {
            planId: plan.id,
            episodeId: plan.episode_id,
            showId: plan.show_id,
            durationMs: access.episode.duration_seconds * 1_000,
            streamProfile: plan.stream_profile,
            markers: parseMarkers(plan.marker_manifest_json),
            source: {
              objectKey: plan.source_object_key,
              objectBytes: plan.source_object_bytes,
              etag: plan.source_object_etag
            }
          }
        )
      : null,
    active: {
      markers: markers.results.map((marker) => ({
        position: marker.position,
        startsAtMs: marker.starts_at_ms,
        approvedAt: marker.approved_at
      })),
      segments: segments.results.map((segment) => ({
        sequence: segment.sequence,
        bytes: segment.byte_length,
        objectBytes: segment.object_bytes,
        streamProfile: segment.stream_profile,
        validationStatus: segment.validation_status,
        durationMs: segment.duration_ms,
        frameCount: segment.frame_count,
        validatedAt: segment.validated_at
      }))
    }
  });
}

export async function submitAdminEpisodeAdPlan(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await requireEpisodeAccess(
    request,
    env,
    episodeIdValue,
    REVIEW_ROLES,
    true
  );
  if (!access.ok) return access.response;
  const sourceError = sourceReadinessError(access.episode);
  if (sourceError) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: sourceError },
      { status: 409 }
    );
  }
  const sourceObject = await env.MEDIA_BUCKET.head(
    access.episode.audio_key as string
  );
  if (
    !sourceObject
    || sourceObject.size !== access.episode.audio_bytes
    || sourceObject.httpEtag !== access.episode.audio_etag
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_delivery_audio_object_mismatch" },
      { status: 409 }
    );
  }
  const body = await readJsonObject(request, 50_000);
  const streamProfile = requiredText(
    body.streamProfile ?? DYNAMIC_AD_MP3_PROFILE,
    "streamProfile",
    200
  );
  if (streamProfile !== DYNAMIC_AD_MP3_PROFILE) {
    throw new RequestValidationError(
      `streamProfile must be ${DYNAMIC_AD_MP3_PROFILE}`
    );
  }
  const markers = validateMarkerManifest(
    body.markers,
    access.episode.duration_seconds as number
  );
  const latest = await env.DB.prepare(
    `SELECT COALESCE(MAX(revision), 0) AS revision
     FROM episode_ad_plans
     WHERE episode_id = ?`
  ).bind(access.episode.id).first<{ revision: number }>();
  const revision = Number(latest?.revision ?? 0) + 1;
  const planId = `adplan_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    `INSERT INTO episode_ad_plans (
       id, episode_id, revision, source_object_key, source_object_bytes,
       source_object_etag, source_audio_mime_type, stream_profile,
       marker_manifest_json, submitted_by_admin_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, ?, ?)`
  ).bind(
    planId,
    access.episode.id,
    revision,
    access.episode.audio_key,
    access.episode.audio_bytes,
    access.episode.audio_etag,
    streamProfile,
    JSON.stringify(markers),
    access.authorization.identity.id
  ).run();
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "episode_ad_plan.submitted",
    targetType: "episode_ad_plan",
    targetId: planId,
    metadata: {
      episodeId: access.episode.id,
      showId: access.episode.show_id,
      revision,
      markerCount: markers.length,
      sourceBytes: access.episode.audio_bytes,
      streamProfile
    }
  });
  const processorManifest = buildProcessorManifest(
    env,
    new URL(request.url).origin,
    {
      planId,
      episodeId: access.episode.id,
      showId: access.episode.show_id,
      durationMs: (access.episode.duration_seconds as number) * 1_000,
      streamProfile,
      markers,
      source: {
        objectKey: access.episode.audio_key as string,
        objectBytes: access.episode.audio_bytes as number,
        etag: access.episode.audio_etag as string
      }
    }
  );
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      planId,
      episodeId: access.episode.id,
      revision,
      status: "pending_processor",
      outputPrefix: processorOutputPrefix(env, access.episode, planId),
      processorCallbackPath:
        `/v1/processor/ad-plans/${planId}/complete`,
      processorManifest
    },
    { status: 202 }
  );
}

export async function completeEpisodeAdPlanProcessing(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const planId = validIdentifier(planIdValue, "planId");
  const signed = await readSignedProcessorBody(request, env);
  if (!signed.ok) return signed.response;
  const plan = await loadPlan(env.DB, planId);
  if (!plan) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_plan_not_found" },
      { status: 404 }
    );
  }
  if (!["pending_processor", "failed", "needs_review"].includes(plan.status)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_plan_not_processable" },
      { status: 409 }
    );
  }
  const processorVersion = requiredText(
    signed.body.processorVersion,
    "processorVersion",
    200
  );
  validateProcessorSource(signed.body.source, plan);
  const markers = parseMarkers(plan.marker_manifest_json);
  const episodeDurationMs = await loadEpisodeDurationMs(env.DB, plan.episode_id);
  const segments = validateSegmentManifest(
    signed.body.segments,
    plan,
    markers,
    episodeDurationMs,
    processorOutputPrefix(
      env,
      {
        id: plan.episode_id,
        show_id: plan.show_id
      },
      plan.id
    )
  );
  await verifySegmentObjects(env.MEDIA_BUCKET, segments);
  const manifestSha256 = await sha256Hex(JSON.stringify(segments));
  if (
    plan.status === "needs_review"
    && plan.processor_manifest_sha256 === manifestSha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      planId,
      status: "needs_review",
      idempotent: true,
      manifestSha256
    });
  }
  const report = processorReport(signed.body.report);
  await env.DB.prepare(
    `UPDATE episode_ad_plans
     SET
       status = 'needs_review',
       segment_manifest_json = ?,
       processor_report_json = ?,
       processor_manifest_sha256 = ?,
       processor_version = ?,
       processor_completed_at = datetime('now'),
       rejection_reason = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    JSON.stringify(segments),
    JSON.stringify(report),
    manifestSha256,
    processorVersion,
    planId
  ).run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    planId,
    status: "needs_review",
    idempotent: false,
    segmentCount: segments.length,
    manifestSha256
  });
}

export async function approveAdminEpisodeAdPlan(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const access = await requirePlanAccess(
    request,
    env,
    planIdValue,
    REVIEW_ROLES
  );
  if (!access.ok) return access.response;
  if (access.plan.status === "approved") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      planId: access.plan.id,
      status: "approved",
      idempotent: true
    });
  }
  if (
    access.plan.status !== "needs_review"
    || !access.plan.segment_manifest_json
    || !access.plan.processor_manifest_sha256
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_plan_not_ready" },
      { status: 409 }
    );
  }
  const episode = await loadEpisodeSource(env.DB, access.plan.episode_id);
  if (!episode || !sourceMatchesPlan(episode, access.plan)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_plan_source_changed" },
      { status: 409 }
    );
  }
  const markers = parseMarkers(access.plan.marker_manifest_json);
  const segments = parseSegments(access.plan.segment_manifest_json);
  if (
    await sha256Hex(JSON.stringify(segments))
      !== access.plan.processor_manifest_sha256
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_plan_manifest_changed" },
      { status: 409 }
    );
  }
  await verifySegmentObjects(env.MEDIA_BUCKET, segments);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE episode_ad_plans
       SET
         status = 'superseded',
         updated_at = datetime('now')
       WHERE episode_id = ? AND status = 'approved' AND id != ?`
    ).bind(episode.id, access.plan.id),
    env.DB.prepare(
      `DELETE FROM episode_ad_markers WHERE episode_id = ?`
    ).bind(episode.id),
    env.DB.prepare(
      `DELETE FROM episode_audio_segments WHERE episode_id = ?`
    ).bind(episode.id)
  ];
  for (const marker of markers) {
    statements.push(env.DB.prepare(
      `INSERT INTO episode_ad_markers (
         id, episode_id, plan_id, position, starts_at_ms, enabled,
         approved_by_admin_user_id, approved_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(
      `marker_${crypto.randomUUID().replace(/-/g, "")}`,
      episode.id,
      access.plan.id,
      marker.position,
      marker.startsAtMs,
      access.authorization.identity.id,
      now
    ));
  }
  for (const segment of segments) {
    statements.push(env.DB.prepare(
      `INSERT INTO episode_audio_segments (
         id, episode_id, plan_id, sequence, object_key, object_bytes,
         source_offset, byte_length, audio_mime_type, stream_profile,
         sha256, validation_status, validated_at, source_etag,
         duration_ms, frame_count
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'audio/mpeg', ?, ?, 'ready', ?, ?, ?, ?)`
    ).bind(
      segment.id,
      episode.id,
      access.plan.id,
      segment.sequence,
      segment.objectKey,
      segment.objectBytes,
      segment.byteLength,
      segment.streamProfile,
      segment.sha256,
      now,
      access.plan.source_object_etag,
      segment.durationMs,
      segment.frameCount
    ));
  }
  statements.push(env.DB.prepare(
    `UPDATE episode_ad_plans
     SET
       status = 'approved',
       reviewed_by_admin_user_id = ?,
       reviewed_at = ?,
       rejection_reason = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    access.authorization.identity.id,
    now,
    access.plan.id
  ));
  statements.push(prepareAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "episode_ad_plan.approved",
    targetType: "episode_ad_plan",
    targetId: access.plan.id,
    metadata: {
      episodeId: episode.id,
      showId: episode.show_id,
      revision: access.plan.revision,
      markerCount: markers.length,
      segmentCount: segments.length,
      manifestSha256: access.plan.processor_manifest_sha256
    }
  }));
  await env.DB.batch(statements);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    planId: access.plan.id,
    status: "approved",
    idempotent: false,
    markerCount: markers.length,
    segmentCount: segments.length,
    runtimeEnabled: false
  });
}

export async function rejectAdminEpisodeAdPlan(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const access = await requirePlanAccess(
    request,
    env,
    planIdValue,
    REVIEW_ROLES
  );
  if (!access.ok) return access.response;
  if (access.plan.status === "approved") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "approved_ad_plan_cannot_be_rejected" },
      { status: 409 }
    );
  }
  const body = await readJsonObject(request, 20_000);
  const reason = requiredText(body.reason, "reason", 1_000);
  await env.DB.prepare(
    `UPDATE episode_ad_plans
     SET
       status = 'rejected',
       reviewed_by_admin_user_id = ?,
       reviewed_at = datetime('now'),
       rejection_reason = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    access.authorization.identity.id,
    reason,
    access.plan.id
  ).run();
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "episode_ad_plan.rejected",
    targetType: "episode_ad_plan",
    targetId: access.plan.id,
    metadata: {
      episodeId: access.plan.episode_id,
      showId: access.plan.show_id,
      revision: access.plan.revision,
      reason
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    planId: access.plan.id,
    status: "rejected"
  });
}

async function requireEpisodeAccess(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  allowedRoles: AdminRole[],
  requireCsrf: boolean
): Promise<
  | {
      ok: true;
      authorization: AdminAuthorization;
      episode: EpisodeSourceRow;
    }
  | { ok: false; response: Response }
> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const auth = await requireAdmin(request, env, {
    allowedRoles,
    requireCsrf
  });
  if (!auth.ok) return auth;
  const episode = await loadEpisodeSource(env.DB, episodeId);
  if (!episode) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "episode_not_found" },
        { status: 404 }
      )
    };
  }
  if (
    !hasAdminRoleForShow(
      auth.authorization.identity,
      allowedRoles,
      episode.show_id
    )
  ) {
    return forbidden(request, env);
  }
  return {
    ok: true,
    authorization: auth.authorization,
    episode
  };
}

async function requirePlanAccess(
  request: Request,
  env: PodcastEnv,
  planIdValue: string,
  allowedRoles: AdminRole[]
): Promise<
  | {
      ok: true;
      authorization: AdminAuthorization;
      plan: AdPlanRow;
    }
  | { ok: false; response: Response }
> {
  const planId = validIdentifier(planIdValue, "planId");
  const auth = await requireAdmin(request, env, {
    allowedRoles,
    requireCsrf: true
  });
  if (!auth.ok) return auth;
  const plan = await loadPlan(env.DB, planId);
  if (!plan) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "ad_plan_not_found" },
        { status: 404 }
      )
    };
  }
  if (
    !hasAdminRoleForShow(
      auth.authorization.identity,
      allowedRoles,
      plan.show_id
    )
  ) {
    return forbidden(request, env);
  }
  return { ok: true, authorization: auth.authorization, plan };
}

async function loadEpisodeSource(
  db: D1Database,
  episodeId: string
): Promise<EpisodeSourceRow | null> {
  return db.prepare(
    `SELECT
       id, show_id, duration_seconds, audio_key, audio_bytes, audio_etag,
       audio_mime_type, media_status
     FROM episodes
     WHERE id = ?`
  ).bind(episodeId).first<EpisodeSourceRow>();
}

async function loadEpisodeDurationMs(
  db: D1Database,
  episodeId: string
): Promise<number> {
  const episode = await db.prepare(
    `SELECT duration_seconds FROM episodes WHERE id = ?`
  ).bind(episodeId).first<{ duration_seconds: number | null }>();
  if (!episode?.duration_seconds) {
    throw new RequestValidationError(
      "Episode duration is required before processing ad segments",
      "episode_duration_required",
      409
    );
  }
  return episode.duration_seconds * 1_000;
}

async function loadPlan(
  db: D1Database,
  planId: string
): Promise<AdPlanRow | null> {
  return db.prepare(
    `SELECT p.*, e.show_id
     FROM episode_ad_plans p
     JOIN episodes e ON e.id = p.episode_id
     WHERE p.id = ?`
  ).bind(planId).first<AdPlanRow>();
}

async function loadLatestPlan(
  db: D1Database,
  episodeId: string
): Promise<AdPlanRow | null> {
  return db.prepare(
    `SELECT p.*, e.show_id
     FROM episode_ad_plans p
     JOIN episodes e ON e.id = p.episode_id
     WHERE p.episode_id = ?
     ORDER BY p.revision DESC
     LIMIT 1`
  ).bind(episodeId).first<AdPlanRow>();
}

function sourceReadinessError(episode: EpisodeSourceRow): string | null {
  if (
    episode.media_status !== "ready"
    || !episode.audio_key
    || !episode.audio_bytes
    || !episode.audio_etag
  ) {
    return "episode_delivery_audio_not_ready";
  }
  if (episode.audio_mime_type !== "audio/mpeg") {
    return "episode_delivery_audio_must_be_mp3";
  }
  if (!episode.duration_seconds) return "episode_duration_required";
  return null;
}

function sourceMatchesPlan(
  episode: EpisodeSourceRow,
  plan: AdPlanRow
): boolean {
  return episode.media_status === "ready"
    && episode.audio_key === plan.source_object_key
    && episode.audio_bytes === plan.source_object_bytes
    && episode.audio_etag === plan.source_object_etag
    && episode.audio_mime_type === plan.source_audio_mime_type;
}

function validateMarkerManifest(
  value: unknown,
  durationSeconds: number
): MarkerManifest[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new RequestValidationError("markers must contain 1-3 positions");
  }
  const positions = new Set<string>();
  const markers = value.map((entry): MarkerManifest => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RequestValidationError("Every marker must be an object");
    }
    const record = entry as Record<string, unknown>;
    const position = requiredText(
      record.position,
      "marker.position",
      10
    ) as MarkerManifest["position"];
    if (!(position in POSITION_ORDER) || positions.has(position)) {
      throw new RequestValidationError(
        "Marker positions must be unique pre, mid, or post values"
      );
    }
    positions.add(position);
    if (position !== "mid") {
      if (
        record.startsAtMs !== undefined
        && record.startsAtMs !== null
        && record.startsAtMs !== ""
      ) {
        throw new RequestValidationError(
          "Only a mid-roll marker can have startsAtMs"
        );
      }
      return { position, startsAtMs: null };
    }
    const startsAtMs = Number(record.startsAtMs);
    if (
      !Number.isSafeInteger(startsAtMs)
      || startsAtMs <= 0
      || startsAtMs >= durationSeconds * 1_000
    ) {
      throw new RequestValidationError(
        "Mid-roll startsAtMs must be inside the episode duration"
      );
    }
    return { position, startsAtMs };
  });
  return markers.sort(
    (left, right) =>
      POSITION_ORDER[left.position] - POSITION_ORDER[right.position]
  );
}

function validateProcessorSource(
  value: unknown,
  plan: AdPlanRow
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("source evidence is required");
  }
  const source = value as Record<string, unknown>;
  if (
    source.objectKey !== plan.source_object_key
    || Number(source.objectBytes) !== plan.source_object_bytes
    || source.etag !== plan.source_object_etag
  ) {
    throw new RequestValidationError(
      "Processor source evidence does not match the submitted plan",
      "ad_plan_source_mismatch",
      409
    );
  }
}

function validateSegmentManifest(
  value: unknown,
  plan: AdPlanRow,
  markers: MarkerManifest[],
  episodeDurationMs: number,
  outputPrefix: string
): SegmentManifest[] {
  const midMarkers = markers.filter(({ position }) => position === "mid");
  const expectedCount = midMarkers.length + 1;
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new RequestValidationError(
      `segments must contain exactly ${expectedCount} program objects`
    );
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const segments = value.map((entry, index): SegmentManifest => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RequestValidationError("Every segment must be an object");
    }
    const record = entry as Record<string, unknown>;
    const id = validIdentifier(record.id, "segment.id");
    const sequence = nonNegativeInteger(record.sequence, "segment.sequence");
    const objectKey = requiredText(record.objectKey, "segment.objectKey", 1_000);
    const objectBytes = positiveBoundedInteger(
      record.objectBytes,
      "segment.objectBytes",
      20 * 1024 * 1024 * 1024
    );
    const sourceOffset = nonNegativeInteger(
      record.sourceOffset ?? 0,
      "segment.sourceOffset"
    );
    const byteLength = positiveBoundedInteger(
      record.byteLength,
      "segment.byteLength",
      objectBytes
    );
    const audioMimeType = requiredText(
      record.audioMimeType,
      "segment.audioMimeType",
      100
    );
    const streamProfile = requiredText(
      record.streamProfile,
      "segment.streamProfile",
      200
    );
    const digest = requiredText(record.sha256, "segment.sha256", 64);
    const durationMs = positiveBoundedInteger(
      record.durationMs,
      "segment.durationMs",
      24 * 60 * 60 * 1_000
    );
    const frameCount = positiveBoundedInteger(
      record.frameCount,
      "segment.frameCount",
      10_000_000
    );
    if (sequence !== index) {
      throw new RequestValidationError(
        "Segment sequences must be contiguous from zero"
      );
    }
    if (ids.has(id) || keys.has(objectKey)) {
      throw new RequestValidationError(
        "Segment IDs and object keys must be unique"
      );
    }
    ids.add(id);
    keys.add(objectKey);
    if (!objectKey.startsWith(`${outputPrefix}/`)) {
      throw new RequestValidationError(
        "Segment object is outside the plan output prefix"
      );
    }
    if (
      sourceOffset !== 0
      || byteLength !== objectBytes
      || audioMimeType !== "audio/mpeg"
      || streamProfile !== plan.stream_profile
      || streamProfile !== DYNAMIC_AD_MP3_PROFILE
    ) {
      throw new RequestValidationError(
        "Program segments must be complete MP3 objects on the plan stream profile"
      );
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new RequestValidationError(
        "segment.sha256 must be a lowercase hexadecimal digest"
      );
    }
    const expectedDurationMs = Math.round(
      (frameCount * 1_152 * 1_000) / 44_100
    );
    if (durationMs !== expectedDurationMs) {
      throw new RequestValidationError(
        "Segment duration does not match its MPEG frame count"
      );
    }
    if (
      objectBytes < frameCount * 417
      || objectBytes > frameCount * 418
    ) {
      throw new RequestValidationError(
        "Segment bytes do not match 128 kbps frame bounds"
      );
    }
    return {
      id,
      sequence,
      objectKey,
      objectBytes,
      sourceOffset: 0,
      byteLength,
      audioMimeType: "audio/mpeg",
      streamProfile: DYNAMIC_AD_MP3_PROFILE,
      sha256: digest,
      durationMs,
      frameCount
    };
  });
  const totalDurationMs = segments.reduce(
    (total, segment) => total + segment.durationMs,
    0
  );
  if (Math.abs(totalDurationMs - episodeDurationMs) > 1_500) {
    throw new RequestValidationError(
      "Program segment duration differs from the episode by more than 1.5 seconds"
    );
  }
  if (midMarkers.length === 1) {
    if (
      Math.abs(
        segments[0].durationMs - (midMarkers[0].startsAtMs as number)
      ) > 1_500
    ) {
      throw new RequestValidationError(
        "The mid-roll marker does not match the program segment boundary"
      );
    }
  }
  return segments;
}

async function verifySegmentObjects(
  bucket: R2Bucket,
  segments: SegmentManifest[]
): Promise<void> {
  const objects = await Promise.all(
    segments.map((segment) => bucket.head(segment.objectKey))
  );
  for (let index = 0; index < segments.length; index += 1) {
    if (!objects[index] || objects[index]?.size !== segments[index].objectBytes) {
      throw new RequestValidationError(
        `Program segment ${segments[index].sequence} is unavailable or has the wrong size`,
        "program_segment_object_mismatch",
        409
      );
    }
  }
}

async function readSignedProcessorBody(
  request: Request,
  env: PodcastEnv
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: PROCESSOR_MAXIMUM_BODY_BYTES,
    bodyName: "Processor evidence",
    invalidBodyCode: "invalid_processor_body"
  });
  if (!signed.ok) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        {
          error: signed.reason === "secret_missing"
            ? "not_found"
            : "invalid_processor_signature"
        },
        { status: signed.reason === "secret_missing" ? 404 : 401 }
      )
    };
  }
  return signed;
}

function processorReport(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("report must be a JSON object");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 50_000) {
    throw new RequestValidationError("report is too large");
  }
  return value as Record<string, unknown>;
}

function parseMarkers(value: string): MarkerManifest[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Stored marker manifest is invalid");
  }
  return parsed as MarkerManifest[];
}

function parseSegments(value: string): SegmentManifest[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Stored segment manifest is invalid");
  }
  return parsed as SegmentManifest[];
}

function processorOutputPrefix(
  env: PodcastEnv,
  episode: Pick<EpisodeSourceRow, "id" | "show_id">,
  planId: string
): string {
  return [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    episode.show_id,
    episode.id,
    "ad-plans",
    planId
  ].join("/");
}

function buildProcessorManifest(
  env: PodcastEnv,
  requestOrigin: string,
  plan: {
    planId: string;
    episodeId: string;
    showId: string;
    durationMs: number;
    streamProfile: string;
    markers: MarkerManifest[];
    source: {
      objectKey: string;
      objectBytes: number;
      etag: string;
    };
  }
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    planId: plan.planId,
    episodeId: plan.episodeId,
    showId: plan.showId,
    durationMs: plan.durationMs,
    streamProfile: plan.streamProfile,
    markers: plan.markers,
    source: {
      bucketName: env.MEDIA_BUCKET_NAME,
      ...plan.source
    },
    outputPrefix: processorOutputPrefix(
      env,
      { id: plan.episodeId, show_id: plan.showId },
      plan.planId
    ),
    callbackUrl:
      `${requestOrigin}/v1/processor/ad-plans/${plan.planId}/complete`
  };
}

function presentSource(episode: EpisodeSourceRow): Record<string, unknown> {
  return {
    ready: sourceReadinessError(episode) === null,
    bytes: episode.audio_bytes,
    etag: episode.audio_etag,
    mimeType: episode.audio_mime_type,
    durationSeconds: episode.duration_seconds
  };
}

function presentPlan(plan: AdPlanRow): Record<string, unknown> {
  const markers = parseMarkers(plan.marker_manifest_json);
  const segments = plan.segment_manifest_json
    ? parseSegments(plan.segment_manifest_json)
    : [];
  return {
    id: plan.id,
    revision: plan.revision,
    status: plan.status,
    streamProfile: plan.stream_profile,
    markers,
    segmentCount: segments.length,
    processorVersion: plan.processor_version,
    processorManifestSha256: plan.processor_manifest_sha256,
    submittedAt: plan.submitted_at,
    processorCompletedAt: plan.processor_completed_at,
    reviewedAt: plan.reviewed_at,
    rejectionReason: plan.rejection_reason
  };
}

function positiveBoundedInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  const result = Number(value);
  if (
    !Number.isSafeInteger(result)
    || result <= 0
    || result > maximum
  ) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RequestValidationError(
      `${field} must be a non-negative integer`
    );
  }
  return result;
}

function forbidden(
  request: Request,
  env: PodcastEnv
): { ok: false; response: Response } {
  return {
    ok: false,
    response: privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "forbidden" },
      { status: 403 }
    )
  };
}
