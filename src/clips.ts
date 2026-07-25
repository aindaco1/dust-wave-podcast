import { sha256Hex } from "@dustwave/worker-core/crypto";

import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import {
  privateCorsHeaders,
  privateJson
} from "./http";
import {
  requestedMediaRange,
  safeDownloadFilename
} from "./media-range";
import {
  readSignedJsonBody,
  verifySignedText
} from "./signed-callback";
import {
  normalizeTranscriptCues,
  type TranscriptCue
} from "./transcripts";
import {
  boundedPageSize,
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
const CLIP_LIBRARY_PAGE_SIZE = 24;
const CLIP_RENDER_STATUSES = new Set([
  "queued",
  "rendering",
  "ready",
  "failed"
]);
const ASPECT_DIMENSIONS = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 }
} as const;
const TEMPLATE_IDS = new Set(["captioned-waveform-v1"]);
const MINIMUM_CLIP_DURATION_MS = 1_000;
const MAXIMUM_CLIP_DURATION_MS = 180_000;
const PROCESSOR_MAXIMUM_BODY_BYTES = 100_000;
const MAXIMUM_OUTPUT_BYTES = 95 * 1024 * 1024;
const PROCESSOR_UPLOAD_PAYLOAD_HEADER =
  "x-podcast-processor-upload-payload";

type AspectRatio = keyof typeof ASPECT_DIMENSIONS;
type BoundaryMode = "segment" | "word";

type ClipProcessorManifestBody = Record<string, unknown> & {
  source: {
    bucketName: string;
    objectKey: string;
    objectBytes: number;
    etag: string;
    mimeType: "audio/mpeg";
  };
};

type ClipRecipe = {
  schemaVersion: 1;
  title: string;
  aspectRatio: AspectRatio;
  templateId: "captioned-waveform-v1";
  captionLanguage: "en" | "es";
  boundaryMode: BoundaryMode;
  startsAtMs: number;
  endsAtMs: number;
  startCueId: string;
  endCueId: string;
  startWordId: string | null;
  endWordId: string | null;
  transcriptId: string;
  transcriptRevision: number;
  transcriptSha256: string;
  alignmentRevisionId: string | null;
  captionStyle: "high-contrast-v1";
  safeArea: {
    topPercent: 8;
    rightPercent: 8;
    bottomPercent: 18;
    leftPercent: 8;
  };
};

type ClipRow = {
  id: string;
  episode_id: string;
  episode_title: string;
  episode_slug: string;
  show_id: string;
  title: string;
  starts_at_ms: number;
  ends_at_ms: number;
  aspect_ratio: AspectRatio;
  status: string;
  output_key: string | null;
  revision: number;
  transcript_id: string | null;
  transcript_revision: number | null;
  transcript_sha256: string | null;
  alignment_revision_id: string | null;
  boundary_mode: BoundaryMode | null;
  caption_language: string | null;
  template_id: string | null;
  recipe_json: string;
  recipe_sha256: string | null;
  source_object_key: string | null;
  source_object_bytes: number | null;
  source_object_etag: string | null;
  created_at: string;
  updated_at: string;
  render_id: string | null;
  render_clip_revision: number | null;
  render_status: string | null;
  render_output_bytes: number | null;
  render_output_sha256: string | null;
  render_output_mime_type: string | null;
  render_output_width: number | null;
  render_output_height: number | null;
  render_output_duration_ms: number | null;
  render_processor_version: string | null;
  render_failure_code: string | null;
  render_requested_at: string | null;
  render_completed_at: string | null;
};

type ClipRevisionRow = {
  clip_id: string;
  episode_id: string;
  show_id: string;
  clip_revision: number;
  recipe_json: string;
  recipe_sha256: string;
  transcript_id: string;
  transcript_revision: number;
  transcript_sha256: string;
  alignment_revision_id: string | null;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  transcript_content_json: string;
  transcript_status: string;
  current_transcript_revision: number;
  current_transcript_sha256: string | null;
  audio_key: string | null;
  audio_bytes: number | null;
  audio_etag: string | null;
  audio_mime_type: string | null;
  media_status: string;
};

type ClipRenderRow = {
  id: string;
  clip_id: string;
  clip_revision: number;
  recipe_sha256: string;
  processor_manifest_sha256: string;
  output_object_key: string;
  status: string;
  output_object_bytes: number | null;
  output_sha256: string | null;
  output_mime_type: string | null;
  output_width: number | null;
  output_height: number | null;
  output_duration_ms: number | null;
  processor_version: string | null;
  failure_code: string | null;
  requested_at: string;
  completed_at: string | null;
};

type ClipRenderMediaRow = ClipRenderRow & {
  show_id: string;
  clip_title: string;
};

type ApprovedTranscriptRow = {
  id: string;
  language: "en" | "es";
  content_json: string;
  content_sha256: string;
  revision: number;
};

type ClipAuthorization = {
  authorization: AdminAuthorization;
  clip: ClipRow;
};

export async function listAdminEpisodeClips(
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
  const clips = await env.DB
    .prepare(clipSelect("WHERE c.episode_id = ? ORDER BY c.updated_at DESC"))
    .bind(access.episode.id)
    .all<ClipRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: access.episode.id,
    durationSeconds: access.episode.durationSeconds,
    limits: {
      minimumDurationMs: MINIMUM_CLIP_DURATION_MS,
      maximumDurationMs: MAXIMUM_CLIP_DURATION_MS,
      templateIds: [...TEMPLATE_IDS],
      aspectRatios: Object.keys(ASPECT_DIMENSIONS)
    },
    clips: clips.results.map(presentClip)
  });
}

export async function listAdminShowClips(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const url = new URL(request.url);
  const limit = boundedPageSize(
    url.searchParams.get("limit"),
    CLIP_LIBRARY_PAGE_SIZE
  );
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue
    ? validIdentifier(cursorValue, "cursor")
    : null;
  const episodeValue = url.searchParams.get("episodeId");
  const episodeId = episodeValue
    ? validIdentifier(episodeValue, "episodeId")
    : null;
  const aspectValue = url.searchParams.get("aspectRatio");
  const aspectRatio = aspectValue
    ? validClipAspectRatio(aspectValue)
    : null;
  const renderStatus = validClipRenderStatus(
    url.searchParams.get("renderStatus")
  );
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;

  const cursorRow = cursor
    ? await env.DB.prepare(
      `SELECT c.id, c.updated_at
       FROM clips c
       JOIN episodes e ON e.id = c.episode_id
       WHERE c.id = ? AND e.show_id = ?`
    ).bind(cursor, showId).first<{ id: string; updated_at: string }>()
    : null;
  if (cursor && !cursorRow) {
    throw new RequestValidationError("cursor is invalid");
  }

  const clauses = ["e.show_id = ?"];
  const bindings: unknown[] = [showId];
  if (episodeId) {
    clauses.push("c.episode_id = ?");
    bindings.push(episodeId);
  }
  if (aspectRatio) {
    clauses.push("c.aspect_ratio = ?");
    bindings.push(aspectRatio);
  }
  if (renderStatus) {
    clauses.push("r.status = ?", "r.clip_revision = c.revision");
    bindings.push(renderStatus);
  }
  if (cursorRow) {
    clauses.push(
      "(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))"
    );
    bindings.push(
      cursorRow.updated_at,
      cursorRow.updated_at,
      cursorRow.id
    );
  }
  const page = await env.DB.prepare(
    clipSelect(
      `WHERE ${clauses.join(" AND ")}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`
    )
  ).bind(...bindings, limit + 1).all<ClipRow>();
  const hasMore = page.results.length > limit;
  const rows = page.results.slice(0, limit);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    clips: rows.map(presentClip),
    pagination: {
      limit,
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null
    },
    filters: {
      episodeId,
      aspectRatio,
      renderStatus: renderStatus ?? "all"
    }
  });
}

export async function saveAdminEpisodeClip(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  clipIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const sourceError = clipSourceReadinessError(access.episode);
  if (sourceError) return clipConflict(request, env, sourceError);
  const sourceObject = await env.MEDIA_BUCKET.head(access.episode.audioKey as string);
  if (
    !sourceObject
    || sourceObject.size !== access.episode.audioBytes
    || sourceObject.httpEtag !== access.episode.audioEtag
  ) {
    return clipConflict(request, env, "clip_source_object_mismatch");
  }

  const clipId = validIdentifier(clipIdValue, "clipId");
  const body = await readJsonObject(request, 100_000);
  const mutationId = validIdentifier(body.mutationId, "mutationId");
  const baseRevision = nonNegativeInteger(body.baseRevision, "baseRevision");
  const transcript = await loadApprovedTranscript(
    env.DB,
    access.episode.id,
    validLanguage(body.captionLanguage)
  );
  if (!transcript) {
    return clipConflict(request, env, "clip_approved_transcript_required");
  }
  const recipe = await buildClipRecipe(
    env.DB,
    access.episode.durationSeconds as number,
    transcript,
    body
  );
  const recipeJson = JSON.stringify(recipe);
  const recipeSha256 = await sha256Hex(recipeJson);

  const replay = await env.DB
    .prepare(
      `SELECT clip_id, base_revision, target_revision, recipe_sha256
       FROM clip_mutations
       WHERE id = ?`
    )
    .bind(mutationId)
    .first<{
      clip_id: string;
      base_revision: number;
      target_revision: number;
      recipe_sha256: string;
    }>();
  if (replay) {
    if (
      replay.clip_id !== clipId
      || replay.base_revision !== baseRevision
      || replay.recipe_sha256 !== recipeSha256
    ) {
      return clipConflict(request, env, "clip_mutation_conflict");
    }
    const clip = await loadClip(env.DB, clipId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      clip: clip ? presentClip(clip) : null,
      idempotent: true
    });
  }

  const targetRevision = baseRevision + 1;
  const revisionId = `clip_revision_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO clips (
         id, episode_id, title, starts_at_ms, ends_at_ms, aspect_ratio,
         caption_html, status, revision, created_by_admin_user_id
       )
       SELECT ?, ?, ?, ?, ?, ?, '', 'draft', 0, ?
       WHERE ? = 0`
    ).bind(
      clipId,
      access.episode.id,
      recipe.title,
      recipe.startsAtMs,
      recipe.endsAtMs,
      recipe.aspectRatio,
      access.authorization.identity.id,
      baseRevision
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO clip_mutations (
         id, clip_id, base_revision, target_revision, recipe_sha256,
         admin_user_id
       )
       SELECT ?, c.id, ?, ?, ?, ?
       FROM clips c
       WHERE c.id = ? AND c.episode_id = ? AND c.revision = ?`
    ).bind(
      mutationId,
      baseRevision,
      targetRevision,
      recipeSha256,
      access.authorization.identity.id,
      clipId,
      access.episode.id,
      baseRevision
    ),
    env.DB.prepare(
      `UPDATE clips
       SET
         title = ?,
         starts_at_ms = ?,
         ends_at_ms = ?,
         aspect_ratio = ?,
         status = 'draft',
         output_key = NULL,
         revision = ?,
         transcript_id = ?,
         transcript_revision = ?,
         transcript_sha256 = ?,
         alignment_revision_id = ?,
         boundary_mode = ?,
         caption_language = ?,
         template_id = ?,
         recipe_json = ?,
         recipe_sha256 = ?,
         source_object_key = ?,
         source_object_bytes = ?,
         source_object_etag = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND episode_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM clip_mutations mutation
           WHERE mutation.id = ?
             AND mutation.clip_id = clips.id
             AND mutation.target_revision = ?
             AND mutation.recipe_sha256 = ?
         )`
    ).bind(
      recipe.title,
      recipe.startsAtMs,
      recipe.endsAtMs,
      recipe.aspectRatio,
      targetRevision,
      recipe.transcriptId,
      recipe.transcriptRevision,
      recipe.transcriptSha256,
      recipe.alignmentRevisionId,
      recipe.boundaryMode,
      recipe.captionLanguage,
      recipe.templateId,
      recipeJson,
      recipeSha256,
      access.episode.audioKey,
      access.episode.audioBytes,
      access.episode.audioEtag,
      clipId,
      access.episode.id,
      baseRevision,
      mutationId,
      targetRevision,
      recipeSha256
    ),
    env.DB.prepare(
      `INSERT INTO clip_revisions (
         id, clip_id, revision, recipe_json, recipe_sha256, transcript_id,
         transcript_revision, transcript_sha256, alignment_revision_id,
         source_object_key, source_object_bytes, source_object_etag,
         created_by_admin_user_id
       )
       SELECT ?, c.id, c.revision, c.recipe_json, c.recipe_sha256,
              c.transcript_id, c.transcript_revision, c.transcript_sha256,
              c.alignment_revision_id, c.source_object_key,
              c.source_object_bytes, c.source_object_etag, ?
       FROM clips c
       JOIN clip_mutations mutation
         ON mutation.id = ? AND mutation.clip_id = c.id
       WHERE c.id = ?
         AND c.revision = ?
         AND c.recipe_sha256 = ?`
    ).bind(
      revisionId,
      access.authorization.identity.id,
      mutationId,
      clipId,
      targetRevision,
      recipeSha256
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'clip.revised', 'clip', ?, ?
       FROM clip_mutations
       WHERE id = ? AND clip_id = ?`
    ).bind(
      auditId,
      access.authorization.identity.id,
      clipId,
      JSON.stringify({
        episodeId: access.episode.id,
        showId: access.episode.showId,
        revision: targetRevision,
        recipeSha256,
        aspectRatio: recipe.aspectRatio,
        boundaryMode: recipe.boundaryMode,
        captionLanguage: recipe.captionLanguage,
        durationMs: recipe.endsAtMs - recipe.startsAtMs
      }),
      mutationId,
      clipId
    )
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    const current = await currentClipRevision(env.DB, clipId);
    return clipConflict(request, env, "clip_revision_conflict", {
      currentRevision: current
    });
  }
  const clip = await loadClip(env.DB, clipId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    clip: clip ? presentClip(clip) : null,
    idempotent: false
  });
}

export async function queueAdminClipRender(
  request: Request,
  env: PodcastEnv,
  clipIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const access = await authorizeClip(
    request,
    env,
    clipIdValue,
    EDIT_ROLES
  );
  if (access instanceof Response) return access;
  const body = await readJsonObject(request, 20_000);
  const renderId = validIdentifier(body.renderId, "renderId");
  const expectedRevision = positiveInteger(
    body.expectedRevision,
    "expectedRevision"
  );
  if (
    access.clip.revision !== expectedRevision
    || !access.clip.recipe_sha256
  ) {
    return clipConflict(request, env, "clip_revision_conflict", {
      currentRevision: access.clip.revision
    });
  }
  const priorById = await loadClipRender(env.DB, renderId);
  if (priorById) {
    if (
      priorById.clip_id !== access.clip.id
      || priorById.clip_revision !== expectedRevision
      || priorById.recipe_sha256 !== access.clip.recipe_sha256
    ) {
      return clipConflict(request, env, "clip_render_conflict");
    }
    const manifest = await buildClipProcessorManifest(
      env,
      renderId,
      access.clip.id,
      expectedRevision
    );
    if (manifest.sha256 !== priorById.processor_manifest_sha256) {
      return clipConflict(
        request,
        env,
        "clip_render_manifest_mismatch",
        {
          storedManifestSha256: priorById.processor_manifest_sha256,
          rebuiltManifestSha256: manifest.sha256
        }
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      render: presentRender(priorById),
      processorManifest: {
        ...manifest.body,
        manifestSha256: manifest.sha256
      },
      idempotent: true
    });
  }
  const existing = await env.DB
    .prepare(
      `SELECT id
       FROM clip_renders
       WHERE clip_id = ? AND clip_revision = ?`
    )
    .bind(access.clip.id, expectedRevision)
    .first<{ id: string }>();
  if (existing) {
    return clipConflict(request, env, "clip_render_exists");
  }

  const manifest = await buildClipProcessorManifest(
    env,
    renderId,
    access.clip.id,
    expectedRevision
  );
  const output = manifest.body.output as { objectKey: string };
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO clip_renders (
         id, clip_id, clip_revision, recipe_sha256,
         processor_manifest_sha256, output_object_key,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      renderId,
      access.clip.id,
      expectedRevision,
      access.clip.recipe_sha256,
      manifest.sha256,
      output.objectKey,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `UPDATE clips
       SET status = 'queued', updated_at = datetime('now')
       WHERE id = ? AND revision = ? AND recipe_sha256 = ?
         AND EXISTS (
           SELECT 1
           FROM clip_renders
           WHERE id = ? AND clip_id = clips.id
         )`
    ).bind(
      access.clip.id,
      expectedRevision,
      access.clip.recipe_sha256,
      renderId
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'clip.render_queued', 'clip_render', ?, ?
       FROM clip_renders
       WHERE id = ? AND clip_id = ?`
    ).bind(
      auditId,
      access.authorization.identity.id,
      renderId,
      JSON.stringify({
        clipId: access.clip.id,
        clipRevision: expectedRevision,
        recipeSha256: access.clip.recipe_sha256,
        processorManifestSha256: manifest.sha256
      }),
      renderId,
      access.clip.id
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return clipConflict(request, env, "clip_render_conflict");
  }
  const render = await loadClipRender(env.DB, renderId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      render: render ? presentRender(render) : null,
      processorManifest: {
        ...manifest.body,
        manifestSha256: manifest.sha256
      },
      idempotent: false
    },
    { status: 202 }
  );
}

export async function serveAdminClipRenderMedia(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  const renderId = validIdentifier(renderIdValue, "renderId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES
  });
  if (!auth.ok) return auth.response;
  const render = await loadClipRenderMedia(env.DB, renderId);
  if (
    !render
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      READ_ROLES,
      render.show_id
    )
    || render.status !== "ready"
    || render.output_mime_type !== "video/mp4"
    || !render.output_object_bytes
    || !render.output_sha256
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_render_not_found" },
      { status: 404 }
    );
  }
  const objectHead = await env.MEDIA_BUCKET.head(render.output_object_key);
  if (
    !objectHead
    || objectHead.size !== render.output_object_bytes
    || objectHead.httpMetadata?.contentType !== "video/mp4"
    || objectHead.checksums.toJSON().sha256 !== render.output_sha256
    || objectHead.customMetadata?.sha256 !== render.output_sha256
    || objectHead.customMetadata?.["render-manifest-sha256"]
      !== render.processor_manifest_sha256
  ) {
    return clipConflict(request, env, "clip_render_object_mismatch");
  }
  const headers = clipMediaHeaders(
    request,
    env,
    objectHead.httpEtag
  );
  if (new URL(request.url).searchParams.get("download") === "1") {
    headers.set(
      "content-disposition",
      `attachment; filename="${safeDownloadFilename(
        `${render.clip_title}-${render.id}.mp4`
      )}"`
    );
  } else {
    headers.set("content-disposition", "inline");
  }
  if (request.headers.get("if-none-match") === objectHead.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(render.output_object_bytes));
    return new Response(null, { headers });
  }
  const range = requestedMediaRange(
    request,
    render.output_object_bytes,
    objectHead.httpEtag
  );
  if (range === "invalid") {
    headers.set("content-range", `bytes */${render.output_object_bytes}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await env.MEDIA_BUCKET.get(render.output_object_key, {
    ...(range ? { range } : {}),
    onlyIf: new Headers({ "if-match": objectHead.httpEtag })
  });
  if (
    !object
    || !("body" in object)
    || object.size !== render.output_object_bytes
    || object.httpEtag !== objectHead.httpEtag
  ) {
    return clipConflict(request, env, "clip_render_object_mismatch");
  }
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-length", String(length));
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${render.output_object_bytes}`
    );
  } else {
    headers.set("content-length", String(render.output_object_bytes));
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers
  });
}

export async function getClipRenderProcessorManifest(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const renderId = validIdentifier(renderIdValue, "renderId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: 10_000,
    bodyName: "Clip processor manifest request",
    invalidBodyCode: "invalid_clip_processor_request"
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: signed.reason === "secret_missing"
          ? "not_found"
          : "invalid_processor_signature"
      },
      { status: signed.reason === "secret_missing" ? 404 : 401 }
    );
  }
  if (
    signed.body.renderId !== renderId
    || signed.body.action !== "manifest"
  ) {
    throw new RequestValidationError(
      "The manifest request does not match its URL or action"
    );
  }
  const render = await loadClipRender(env.DB, renderId);
  if (!render) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_render_not_found" },
      { status: 404 }
    );
  }
  const manifest = await buildClipProcessorManifest(
    env,
    render.id,
    render.clip_id,
    render.clip_revision
  );
  if (manifest.sha256 !== render.processor_manifest_sha256) {
    return clipConflict(
      request,
      env,
      "clip_render_manifest_mismatch",
      {
        storedManifestSha256: render.processor_manifest_sha256,
        rebuiltManifestSha256: manifest.sha256
      }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: {
      ...manifest.body,
      manifestSha256: manifest.sha256
    }
  });
}

export async function getClipRenderProcessorSource(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const renderId = validIdentifier(renderIdValue, "renderId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: 10_000,
    bodyName: "Clip processor source request",
    invalidBodyCode: "invalid_clip_processor_request"
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: signed.reason === "secret_missing"
          ? "not_found"
          : "invalid_processor_signature"
      },
      { status: signed.reason === "secret_missing" ? 404 : 401 }
    );
  }
  if (
    signed.body.renderId !== renderId
    || signed.body.action !== "source"
  ) {
    throw new RequestValidationError(
      "The source request does not match its URL or action"
    );
  }
  const render = await loadClipRender(env.DB, renderId);
  if (!render) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_render_not_found" },
      { status: 404 }
    );
  }
  const manifest = await buildClipProcessorManifest(
    env,
    render.id,
    render.clip_id,
    render.clip_revision
  );
  if (manifest.sha256 !== render.processor_manifest_sha256) {
    return clipConflict(
      request,
      env,
      "clip_render_manifest_mismatch",
      {
        storedManifestSha256: render.processor_manifest_sha256,
        rebuiltManifestSha256: manifest.sha256
      }
    );
  }
  const source = await env.MEDIA_BUCKET.get(
    manifest.body.source.objectKey,
    {
      onlyIf: new Headers({
        "if-match": manifest.body.source.etag
      })
    }
  );
  if (
    !source
    || !("body" in source)
    || source.size !== manifest.body.source.objectBytes
    || source.httpEtag !== manifest.body.source.etag
    || source.httpMetadata?.contentType !== "audio/mpeg"
  ) {
    return clipConflict(
      request,
      env,
      "clip_render_source_mismatch"
    );
  }
  const headers = new Headers();
  source.writeHttpMetadata(headers);
  headers.set("content-type", "audio/mpeg");
  headers.set("content-length", String(source.size));
  headers.set("etag", source.httpEtag);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(source.body, { status: 200, headers });
}

export async function uploadClipRenderProcessorOutput(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const renderId = validIdentifier(renderIdValue, "renderId");
  if (!env.MEDIA_PROCESSOR_CALLBACK_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const encodedPayload =
    request.headers.get(PROCESSOR_UPLOAD_PAYLOAD_HEADER) ?? "";
  if (
    !encodedPayload
    || encodedPayload.length > 2_000
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "invalid_processor_signature" },
      { status: 401 }
    );
  }
  const signed = await verifySignedText(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    message: encodedPayload
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "invalid_processor_signature" },
      { status: 401 }
    );
  }
  const payload = parseClipUploadPayload(encodedPayload);
  if (payload.renderId !== renderId) {
    throw new RequestValidationError(
      "The output upload does not match its URL"
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    request.headers.get("content-type") !== "video/mp4"
    || contentLength !== payload.objectBytes
    || !request.body
  ) {
    throw new RequestValidationError(
      "The output upload body does not match its signed payload"
    );
  }
  const render = await loadClipRender(env.DB, renderId);
  if (!render) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_render_not_found" },
      { status: 404 }
    );
  }
  if (payload.manifestSha256 !== render.processor_manifest_sha256) {
    return clipConflict(request, env, "clip_render_manifest_mismatch");
  }
  const stored = await env.MEDIA_BUCKET.put(
    render.output_object_key,
    request.body,
    {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: {
        sha256: payload.sha256,
        "render-manifest-sha256": payload.manifestSha256
      },
      sha256: payload.sha256
    }
  );
  if (
    !stored
    || stored.size !== payload.objectBytes
    || stored.httpMetadata?.contentType !== "video/mp4"
    || stored.checksums.toJSON().sha256 !== payload.sha256
    || stored.customMetadata?.sha256 !== payload.sha256
    || stored.customMetadata?.["render-manifest-sha256"]
      !== payload.manifestSha256
  ) {
    return clipConflict(request, env, "clip_render_object_mismatch");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    object: {
      objectKey: stored.key,
      objectBytes: stored.size,
      sha256: payload.sha256,
      mimeType: "video/mp4",
      manifestSha256: payload.manifestSha256
    },
    checksumVerified: true
  });
}

export async function completeClipRender(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const renderId = validIdentifier(renderIdValue, "renderId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: PROCESSOR_MAXIMUM_BODY_BYTES,
    bodyName: "Clip processor evidence",
    invalidBodyCode: "invalid_clip_processor_body"
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: signed.reason === "secret_missing"
          ? "not_found"
          : "invalid_processor_signature"
      },
      { status: signed.reason === "secret_missing" ? 404 : 401 }
    );
  }
  const render = await loadClipRender(env.DB, renderId);
  if (!render) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_render_not_found" },
      { status: 404 }
    );
  }
  if (signed.body.renderId !== renderId) {
    throw new RequestValidationError("renderId does not match the callback URL");
  }
  if (
    signed.body.manifestSha256 !== render.processor_manifest_sha256
  ) {
    return clipConflict(request, env, "clip_render_manifest_mismatch");
  }
  const revision = await loadClipRevision(
    env.DB,
    render.clip_id,
    render.clip_revision
  );
  if (!revision) {
    return clipConflict(request, env, "clip_revision_not_found");
  }
  const recipe = parseClipRecipe(revision.recipe_json);
  const processorVersion = plainText(
    signed.body.processorVersion,
    "processorVersion",
    200
  );
  const processorStatus = requiredText(
    signed.body.status,
    "status",
    20
  );
  if (processorStatus === "failed") {
    const failureCode = plainText(
      signed.body.failureCode,
      "failureCode",
      120
    );
    const report = processorReport(signed.body.report);
    if (
      render.status === "failed"
      && render.failure_code === failureCode
      && render.processor_version === processorVersion
    ) {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        render: presentRender(render),
        idempotent: true
      });
    }
    const failed = await env.DB.batch([
      env.DB.prepare(
        `UPDATE clip_renders
         SET
           status = 'failed',
           processor_version = ?,
           failure_code = ?,
           processor_report_json = ?,
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status IN ('queued', 'rendering', 'failed')`
      ).bind(
        processorVersion,
        failureCode,
        JSON.stringify(report),
        renderId
      ),
      env.DB.prepare(
        `UPDATE clips
         SET status = 'failed', updated_at = datetime('now')
         WHERE id = ? AND revision = ? AND recipe_sha256 = ?`
      ).bind(
        render.clip_id,
        render.clip_revision,
        render.recipe_sha256
      )
    ]);
    if (Number(failed[0]?.meta?.changes ?? 0) !== 1) {
      return clipConflict(request, env, "clip_render_conflict");
    }
    const failedRender = await loadClipRender(env.DB, renderId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      render: failedRender ? presentRender(failedRender) : null,
      currentClipUpdated: Number(failed[1]?.meta?.changes ?? 0) === 1,
      idempotent: false
    });
  }
  if (processorStatus !== "succeeded") {
    throw new RequestValidationError("status must be succeeded or failed");
  }
  const output = validateClipOutput(signed.body.output, render, recipe);
  const outputObject = await env.MEDIA_BUCKET.head(output.objectKey);
  if (
    !outputObject
    || outputObject.size !== output.objectBytes
    || outputObject.httpMetadata?.contentType !== "video/mp4"
    || outputObject.checksums.toJSON().sha256 !== output.sha256
    || outputObject.customMetadata?.sha256 !== output.sha256
    || outputObject.customMetadata?.["render-manifest-sha256"]
      !== render.processor_manifest_sha256
  ) {
    return clipConflict(request, env, "clip_render_object_mismatch");
  }
  if (
    render.status === "ready"
    && render.output_object_bytes === output.objectBytes
    && render.output_sha256 === output.sha256
    && render.output_mime_type === output.mimeType
    && render.output_width === output.width
    && render.output_height === output.height
    && render.output_duration_ms === output.durationMs
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      render: presentRender(render),
      idempotent: true
    });
  }
  if (!["queued", "rendering", "failed"].includes(render.status)) {
    return clipConflict(request, env, "clip_render_not_processable");
  }
  const report = processorReport(signed.body.report);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE clip_renders
       SET
         status = 'ready',
         output_object_bytes = ?,
         output_sha256 = ?,
         output_mime_type = ?,
         output_width = ?,
         output_height = ?,
         output_duration_ms = ?,
         processor_version = ?,
         failure_code = NULL,
         processor_report_json = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'rendering', 'failed')`
    ).bind(
      output.objectBytes,
      output.sha256,
      output.mimeType,
      output.width,
      output.height,
      output.durationMs,
      processorVersion,
      JSON.stringify(report),
      renderId
    ),
    env.DB.prepare(
      `UPDATE clips
       SET
         status = 'ready',
         output_key = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND recipe_sha256 = ?`
    ).bind(
      output.objectKey,
      render.clip_id,
      render.clip_revision,
      render.recipe_sha256
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return clipConflict(request, env, "clip_render_conflict");
  }
  const completed = await loadClipRender(env.DB, renderId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    render: completed ? presentRender(completed) : null,
    currentClipUpdated: Number(results[1]?.meta?.changes ?? 0) === 1,
    idempotent: false
  });
}

async function buildClipRecipe(
  db: D1Database,
  episodeDurationSeconds: number,
  transcript: ApprovedTranscriptRow,
  body: Record<string, unknown>
): Promise<ClipRecipe> {
  const title = plainText(body.title, "title", 160);
  const aspectRatio = requiredText(
    body.aspectRatio,
    "aspectRatio",
    4
  ) as AspectRatio;
  if (!Object.prototype.hasOwnProperty.call(
    ASPECT_DIMENSIONS,
    aspectRatio
  )) {
    throw new RequestValidationError("aspectRatio must be 9:16, 1:1, or 16:9");
  }
  const templateId = requiredText(
    body.templateId ?? "captioned-waveform-v1",
    "templateId",
    80
  );
  if (!TEMPLATE_IDS.has(templateId)) {
    throw new RequestValidationError("templateId is not supported");
  }
  const boundaryMode = requiredText(
    body.boundaryMode ?? "segment",
    "boundaryMode",
    20
  ) as BoundaryMode;
  if (boundaryMode !== "segment" && boundaryMode !== "word") {
    throw new RequestValidationError("boundaryMode must be segment or word");
  }
  const cues = parseApprovedTranscript(transcript);
  const startCueId = validIdentifier(body.startCueId, "startCueId");
  const endCueId = validIdentifier(body.endCueId, "endCueId");
  const selection = resolveSegmentClipSelection(
    cues,
    startCueId,
    endCueId,
    episodeDurationSeconds * 1_000
  );
  const { startCueIndex, endCueIndex } = selection;
  let { startsAtMs, endsAtMs } = selection;
  let alignmentRevisionId: string | null = null;
  let startWordId: string | null = null;
  let endWordId: string | null = null;
  if (boundaryMode === "word") {
    startWordId = validIdentifier(body.startWordId, "startWordId");
    endWordId = validIdentifier(body.endWordId, "endWordId");
    const aligned = await loadWordBoundary(
      db,
      transcript,
      startWordId,
      endWordId,
      startCueId,
      endCueId
    );
    if (!aligned) {
      throw new RequestValidationError(
        "Matching passed word alignment is required for word boundaries",
        "clip_word_alignment_not_ready",
        409
      );
    }
    alignmentRevisionId = aligned.alignmentRevisionId;
    startsAtMs = aligned.startsAtMs;
    endsAtMs = aligned.endsAtMs;
    if (
      startsAtMs < cues[startCueIndex].startsAtMs
      || startsAtMs >= cues[startCueIndex].endsAtMs
      || endsAtMs <= cues[endCueIndex].startsAtMs
      || endsAtMs > cues[endCueIndex].endsAtMs
    ) {
      throw new RequestValidationError(
        "Word boundaries must remain within the selected cue range"
      );
    }
  }
  validateClipDuration(
    startsAtMs,
    endsAtMs,
    episodeDurationSeconds * 1_000
  );
  return {
    schemaVersion: 1,
    title,
    aspectRatio,
    templateId: templateId as ClipRecipe["templateId"],
    captionLanguage: transcript.language,
    boundaryMode,
    startsAtMs,
    endsAtMs,
    startCueId,
    endCueId,
    startWordId,
    endWordId,
    transcriptId: transcript.id,
    transcriptRevision: transcript.revision,
    transcriptSha256: transcript.content_sha256,
    alignmentRevisionId,
    captionStyle: "high-contrast-v1",
    safeArea: {
      topPercent: 8,
      rightPercent: 8,
      bottomPercent: 18,
      leftPercent: 8
    }
  };
}

async function buildClipProcessorManifest(
  env: PodcastEnv,
  renderId: string,
  clipId: string,
  clipRevision: number
): Promise<{
  body: ClipProcessorManifestBody;
  sha256: string;
}> {
  const revision = await loadClipRevision(
    env.DB,
    clipId,
    clipRevision
  );
  if (!revision) {
    throw new RequestValidationError(
      "Clip revision is unavailable",
      "clip_revision_not_found",
      404
    );
  }
  const recipe = parseClipRecipe(revision.recipe_json);
  if (
    revision.transcript_status !== "approved"
    || revision.current_transcript_revision !== revision.transcript_revision
    || revision.current_transcript_sha256 !== revision.transcript_sha256
  ) {
    throw new RequestValidationError(
      "The approved transcript changed after this clip revision",
      "clip_transcript_changed",
      409
    );
  }
  if (
    revision.media_status !== "ready"
    || revision.audio_key !== revision.source_object_key
    || revision.audio_bytes !== revision.source_object_bytes
    || revision.audio_etag !== revision.source_object_etag
    || revision.audio_mime_type !== "audio/mpeg"
  ) {
    throw new RequestValidationError(
      "The source audio changed after this clip revision",
      "clip_source_changed",
      409
    );
  }
  if (
    recipe.boundaryMode === "word"
    && !await alignmentStillPassed(
      env.DB,
      recipe.alignmentRevisionId,
      recipe.transcriptId,
      recipe.transcriptSha256
    )
  ) {
    throw new RequestValidationError(
      "The clip word alignment is no longer passed",
      "clip_word_alignment_not_ready",
      409
    );
  }
  const sourceObject = await env.MEDIA_BUCKET.head(revision.source_object_key);
  if (
    !sourceObject
    || sourceObject.size !== revision.source_object_bytes
    || sourceObject.httpEtag !== revision.source_object_etag
  ) {
    throw new RequestValidationError(
      "The clip source object no longer matches",
      "clip_source_object_mismatch",
      409
    );
  }
  const transcript = parseTranscriptRevision(
    revision.transcript_content_json,
    recipe.captionLanguage
  );
  const captionCues = transcript
    .filter((cue) =>
      cue.endsAtMs > recipe.startsAtMs
      && cue.startsAtMs < recipe.endsAtMs
    )
    .map((cue) => ({
      id: cue.id,
      startsAtMs: Math.max(0, cue.startsAtMs - recipe.startsAtMs),
      endsAtMs: Math.min(
        recipe.endsAtMs,
        cue.endsAtMs
      ) - recipe.startsAtMs,
      speakerLabel: cue.speakerConfirmed ? cue.speakerLabel : "",
      textMarkdown: cue.textMarkdown
    }));
  if (!captionCues.length) {
    throw new RequestValidationError(
      "The clip range has no approved caption cues",
      "clip_caption_range_empty",
      409
    );
  }
  const dimensions = ASPECT_DIMENSIONS[recipe.aspectRatio];
  const outputObjectKey = clipOutputKey(
    env,
    revision.show_id,
    revision.episode_id,
    clipId,
    clipRevision,
    renderId
  );
  const body: ClipProcessorManifestBody = {
    schemaVersion: "clip-render-v1",
    renderId,
    clipId,
    clipRevision,
    episodeId: revision.episode_id,
    showId: revision.show_id,
    recipeSha256: revision.recipe_sha256,
    source: {
      bucketName: env.MEDIA_BUCKET_NAME,
      objectKey: revision.source_object_key,
      objectBytes: revision.source_object_bytes,
      etag: revision.source_object_etag,
      mimeType: "audio/mpeg"
    },
    recipe: {
      ...recipe,
      durationMs: recipe.endsAtMs - recipe.startsAtMs,
      outputWidth: dimensions.width,
      outputHeight: dimensions.height
    },
    captions: {
      format: "timed-text-v1",
      language: recipe.captionLanguage,
      cues: captionCues
    },
    output: {
      bucketName: env.MEDIA_BUCKET_NAME,
      objectKey: outputObjectKey,
      mimeType: "video/mp4",
      requiredCustomMetadata: [
        "sha256",
        "render-manifest-sha256"
      ]
    },
    callbackUrl:
      `${new URL(env.FEED_ORIGIN).origin}`
      + `/v1/processor/clip-renders/${renderId}/complete`
  };
  return {
    body,
    sha256: await sha256Hex(JSON.stringify(body))
  };
}

async function authorizeClip(
  request: Request,
  env: PodcastEnv,
  clipIdValue: string,
  roles: AdminRole[]
): Promise<ClipAuthorization | Response> {
  const clipId = validIdentifier(clipIdValue, "clipId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: roles,
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const clip = await loadClip(env.DB, clipId);
  if (
    !clip
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      roles,
      clip.show_id
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "clip_not_found" },
      { status: 404 }
    );
  }
  return {
    authorization: auth.authorization,
    clip
  };
}

function clipSelect(where: string): string {
  return `SELECT
      c.id, c.episode_id, e.title AS episode_title,
      e.slug AS episode_slug, e.show_id, c.title, c.starts_at_ms, c.ends_at_ms,
      c.aspect_ratio, c.status, c.output_key, c.revision, c.transcript_id,
      c.transcript_revision, c.transcript_sha256, c.alignment_revision_id,
      c.boundary_mode, c.caption_language, c.template_id, c.recipe_json,
      c.recipe_sha256, c.source_object_key, c.source_object_bytes,
      c.source_object_etag, c.created_at, c.updated_at,
      r.id AS render_id, r.clip_revision AS render_clip_revision,
      r.status AS render_status,
      r.output_object_bytes AS render_output_bytes,
      r.output_sha256 AS render_output_sha256,
      r.output_mime_type AS render_output_mime_type,
      r.output_width AS render_output_width,
      r.output_height AS render_output_height,
      r.output_duration_ms AS render_output_duration_ms,
      r.processor_version AS render_processor_version,
      r.failure_code AS render_failure_code,
      r.requested_at AS render_requested_at,
      r.completed_at AS render_completed_at
    FROM clips c
    JOIN episodes e ON e.id = c.episode_id
    LEFT JOIN clip_renders r
      ON r.id = (
        SELECT candidate.id
        FROM clip_renders candidate
        WHERE candidate.clip_id = c.id
        ORDER BY candidate.clip_revision DESC, candidate.requested_at DESC
        LIMIT 1
      )
    ${where}`;
}

async function loadClip(
  db: D1Database,
  clipId: string
): Promise<ClipRow | null> {
  return db
    .prepare(clipSelect("WHERE c.id = ?"))
    .bind(clipId)
    .first<ClipRow>();
}

async function loadClipRevision(
  db: D1Database,
  clipId: string,
  revision: number
): Promise<ClipRevisionRow | null> {
  return db.prepare(
    `SELECT
       cr.clip_id, c.episode_id, e.show_id, cr.revision AS clip_revision,
       cr.recipe_json, cr.recipe_sha256, cr.transcript_id,
       cr.transcript_revision, cr.transcript_sha256,
       cr.alignment_revision_id, cr.source_object_key,
       cr.source_object_bytes, cr.source_object_etag,
       tr.content_json AS transcript_content_json,
       t.status AS transcript_status,
       t.revision AS current_transcript_revision,
       t.content_sha256 AS current_transcript_sha256,
       e.audio_key, e.audio_bytes, e.audio_etag, e.audio_mime_type,
       e.media_status
     FROM clip_revisions cr
     JOIN clips c ON c.id = cr.clip_id
     JOIN episodes e ON e.id = c.episode_id
     JOIN transcripts t ON t.id = cr.transcript_id
     JOIN transcript_revisions tr
       ON tr.transcript_id = cr.transcript_id
      AND tr.revision = cr.transcript_revision
      AND tr.content_sha256 = cr.transcript_sha256
     WHERE cr.clip_id = ? AND cr.revision = ?`
  ).bind(clipId, revision).first<ClipRevisionRow>();
}

async function loadClipRender(
  db: D1Database,
  renderId: string
): Promise<ClipRenderRow | null> {
  return db.prepare(
    `SELECT
       id, clip_id, clip_revision, recipe_sha256,
       processor_manifest_sha256, output_object_key, status,
       output_object_bytes, output_sha256, output_mime_type, output_width,
       output_height, output_duration_ms, processor_version, requested_at,
       failure_code, completed_at
     FROM clip_renders
     WHERE id = ?`
  ).bind(renderId).first<ClipRenderRow>();
}

async function loadClipRenderMedia(
  db: D1Database,
  renderId: string
): Promise<ClipRenderMediaRow | null> {
  return db.prepare(
    `SELECT
       r.id, r.clip_id, r.clip_revision, r.recipe_sha256,
       r.processor_manifest_sha256, r.output_object_key, r.status,
       r.output_object_bytes, r.output_sha256, r.output_mime_type,
       r.output_width, r.output_height, r.output_duration_ms,
       r.processor_version, r.failure_code, r.requested_at, r.completed_at,
       e.show_id, c.title AS clip_title
     FROM clip_renders r
     JOIN clips c ON c.id = r.clip_id
     JOIN episodes e ON e.id = c.episode_id
     WHERE r.id = ?`
  ).bind(renderId).first<ClipRenderMediaRow>();
}

function clipMediaHeaders(
  request: Request,
  env: PodcastEnv,
  etag: string
): Headers {
  const headers = new Headers({
    ...privateCorsHeaders(request, env.ALLOWED_ORIGINS),
    "content-type": "video/mp4",
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

async function loadApprovedTranscript(
  db: D1Database,
  episodeId: string,
  language: "en" | "es"
): Promise<ApprovedTranscriptRow | null> {
  return db.prepare(
    `SELECT id, language, content_json, content_sha256, revision
     FROM transcripts
     WHERE episode_id = ?
       AND language = ?
       AND status = 'approved'
       AND approved_revision = revision
       AND revision > 0
       AND content_sha256 IS NOT NULL`
  ).bind(episodeId, language).first<ApprovedTranscriptRow>();
}

async function loadWordBoundary(
  db: D1Database,
  transcript: ApprovedTranscriptRow,
  startWordId: string,
  endWordId: string,
  startCueId: string,
  endCueId: string
): Promise<{
  alignmentRevisionId: string;
  startsAtMs: number;
  endsAtMs: number;
} | null> {
  const alignment = await db.prepare(
    `SELECT id
     FROM transcript_alignment_revisions
     WHERE transcript_id = ?
       AND transcript_revision_sha256 = ?
       AND language = ?
       AND status = 'passed'
     ORDER BY completed_at DESC, created_at DESC
     LIMIT 1`
  ).bind(
    transcript.id,
    transcript.content_sha256,
    transcript.language
  ).first<{ id: string }>();
  if (!alignment) return null;
  const words = await db.prepare(
    `SELECT
       id, cue_id, position, starts_at_ms, ends_at_ms, timing_status,
       timing_origin
     FROM transcript_words
     WHERE alignment_revision_id = ?
       AND id IN (?, ?)`
  ).bind(
    alignment.id,
    startWordId,
    endWordId
  ).all<{
    id: string;
    cue_id: string | null;
    position: number;
    starts_at_ms: number | null;
    ends_at_ms: number | null;
    timing_status: string;
    timing_origin: string | null;
  }>();
  const start = words.results.find(({ id }) => id === startWordId);
  const end = words.results.find(({ id }) => id === endWordId);
  if (
    !start
    || !end
    || start.position > end.position
    || start.cue_id !== startCueId
    || end.cue_id !== endCueId
    || start.starts_at_ms === null
    || end.ends_at_ms === null
    || start.starts_at_ms >= end.ends_at_ms
    || !["aligned", "editor_adjusted"].includes(start.timing_status)
    || !["aligned", "editor_adjusted"].includes(end.timing_status)
    || !["forced_alignment", "model", "editor"].includes(
      start.timing_origin ?? ""
    )
    || !["forced_alignment", "model", "editor"].includes(
      end.timing_origin ?? ""
    )
  ) {
    return null;
  }
  return {
    alignmentRevisionId: alignment.id,
    startsAtMs: start.starts_at_ms,
    endsAtMs: end.ends_at_ms
  };
}

async function alignmentStillPassed(
  db: D1Database,
  alignmentRevisionId: string | null,
  transcriptId: string,
  transcriptSha256: string
): Promise<boolean> {
  if (!alignmentRevisionId) return false;
  const row = await db.prepare(
    `SELECT 1 AS ready
     FROM transcript_alignment_revisions
     WHERE id = ?
       AND transcript_id = ?
       AND transcript_revision_sha256 = ?
       AND status = 'passed'`
  ).bind(
    alignmentRevisionId,
    transcriptId,
    transcriptSha256
  ).first<{ ready: number }>();
  return row?.ready === 1;
}

function parseApprovedTranscript(
  transcript: ApprovedTranscriptRow
): TranscriptCue[] {
  return parseTranscriptRevision(
    transcript.content_json,
    transcript.language
  );
}

function parseTranscriptRevision(
  contentJson: string,
  language: string
): TranscriptCue[] {
  let value: unknown;
  try {
    value = JSON.parse(contentJson);
  } catch {
    throw new RequestValidationError(
      "Stored transcript revision is invalid",
      "clip_transcript_invalid",
      409
    );
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== 1
    || (value as Record<string, unknown>).language !== language
  ) {
    throw new RequestValidationError(
      "Stored transcript revision is invalid",
      "clip_transcript_invalid",
      409
    );
  }
  return normalizeTranscriptCues(
    (value as Record<string, unknown>).cues
  );
}

function parseClipRecipe(value: string): ClipRecipe {
  const parsed = JSON.parse(value) as ClipRecipe;
  if (
    parsed.schemaVersion !== 1
    || !Object.prototype.hasOwnProperty.call(
      ASPECT_DIMENSIONS,
      parsed.aspectRatio
    )
    || parsed.templateId !== "captioned-waveform-v1"
    || !["segment", "word"].includes(parsed.boundaryMode)
  ) {
    throw new Error("Stored clip recipe is invalid");
  }
  return parsed;
}

function presentClip(row: ClipRow): Record<string, unknown> {
  let recipe: ClipRecipe | null = null;
  try {
    recipe = row.recipe_sha256 ? parseClipRecipe(row.recipe_json) : null;
  } catch {
    recipe = null;
  }
  return {
    id: row.id,
    episodeId: row.episode_id,
    episodeTitle: row.episode_title,
    episodeSlug: row.episode_slug,
    title: row.title,
    startsAtMs: row.starts_at_ms,
    endsAtMs: row.ends_at_ms,
    durationMs: row.ends_at_ms - row.starts_at_ms,
    aspectRatio: row.aspect_ratio,
    status: row.status,
    revision: row.revision,
    transcriptId: row.transcript_id,
    transcriptRevision: row.transcript_revision,
    transcriptSha256: row.transcript_sha256,
    alignmentRevisionId: row.alignment_revision_id,
    boundaryMode: row.boundary_mode,
    captionLanguage: row.caption_language,
    templateId: row.template_id,
    recipeSha256: row.recipe_sha256,
    selection: recipe
      ? {
          startCueId: recipe.startCueId,
          endCueId: recipe.endCueId,
          startWordId: recipe.startWordId,
          endWordId: recipe.endWordId
        }
      : null,
    render: row.render_id
      ? {
          id: row.render_id,
          clipRevision: row.render_clip_revision,
          status: row.render_status,
          outputBytes: row.render_output_bytes,
          outputSha256: row.render_output_sha256,
          outputMimeType: row.render_output_mime_type,
          width: row.render_output_width,
          height: row.render_output_height,
          durationMs: row.render_output_duration_ms,
          processorVersion: row.render_processor_version,
          failureCode: row.render_failure_code,
          requestedAt: row.render_requested_at,
          completedAt: row.render_completed_at,
          ...(row.render_status === "ready"
            ? clipRenderMediaPaths(row.render_id)
            : {})
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validClipAspectRatio(value: string): AspectRatio {
  if (!Object.prototype.hasOwnProperty.call(ASPECT_DIMENSIONS, value)) {
    throw new RequestValidationError(
      "aspectRatio must be 9:16, 1:1, or 16:9"
    );
  }
  return value as AspectRatio;
}

function validClipRenderStatus(value: string | null): string | null {
  if (value === null || value === "" || value === "all") return null;
  if (!CLIP_RENDER_STATUSES.has(value)) {
    throw new RequestValidationError(
      "renderStatus must be queued, rendering, ready, failed, or all"
    );
  }
  return value;
}

function presentRender(row: ClipRenderRow): Record<string, unknown> {
  return {
    id: row.id,
    clipId: row.clip_id,
    clipRevision: row.clip_revision,
    recipeSha256: row.recipe_sha256,
    processorManifestSha256: row.processor_manifest_sha256,
    status: row.status,
    outputBytes: row.output_object_bytes,
    outputSha256: row.output_sha256,
    outputMimeType: row.output_mime_type,
    width: row.output_width,
    height: row.output_height,
    durationMs: row.output_duration_ms,
    processorVersion: row.processor_version,
    failureCode: row.failure_code,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    ...(row.status === "ready" ? clipRenderMediaPaths(row.id) : {})
  };
}

function clipRenderMediaPaths(renderId: string): {
  mediaPath: string;
  downloadPath: string;
} {
  const mediaPath =
    `/v1/admin/clip-renders/${encodeURIComponent(renderId)}/media`;
  return {
    mediaPath,
    downloadPath: `${mediaPath}?download=1`
  };
}

function validateClipOutput(
  value: unknown,
  render: ClipRenderRow,
  recipe: ClipRecipe
): {
  objectKey: string;
  objectBytes: number;
  sha256: string;
  mimeType: "video/mp4";
  width: number;
  height: number;
  durationMs: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("output evidence is required");
  }
  const output = value as Record<string, unknown>;
  const objectKey = requiredText(output.objectKey, "output.objectKey", 1_000);
  const objectBytes = positiveInteger(
    output.objectBytes,
    "output.objectBytes",
    MAXIMUM_OUTPUT_BYTES
  );
  const sha256 = requiredText(output.sha256, "output.sha256", 64);
  const mimeType = requiredText(output.mimeType, "output.mimeType", 100);
  const width = positiveInteger(output.width, "output.width", 4_096);
  const height = positiveInteger(output.height, "output.height", 4_096);
  const durationMs = positiveInteger(
    output.durationMs,
    "output.durationMs",
    MAXIMUM_CLIP_DURATION_MS + 1_000
  );
  if (
    objectKey !== render.output_object_key
    || !/^[a-f0-9]{64}$/.test(sha256)
    || mimeType !== "video/mp4"
  ) {
    throw new RequestValidationError(
      "Output identity does not match the render contract"
    );
  }
  const dimensions = ASPECT_DIMENSIONS[recipe.aspectRatio];
  const expectedDurationMs = recipe.endsAtMs - recipe.startsAtMs;
  if (
    width !== dimensions.width
    || height !== dimensions.height
    || Math.abs(durationMs - expectedDurationMs) > 250
  ) {
    throw new RequestValidationError(
      "Output dimensions or duration do not match the clip recipe"
    );
  }
  return {
    objectKey,
    objectBytes,
    sha256,
    mimeType: "video/mp4",
    width,
    height,
    durationMs
  };
}

function parseClipUploadPayload(value: string): {
  renderId: string;
  manifestSha256: string;
  objectBytes: number;
  sha256: string;
} {
  let decoded: unknown;
  try {
    const base64 = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    decoded = JSON.parse(atob(base64)) as unknown;
  } catch {
    throw new RequestValidationError(
      "The signed output upload payload is invalid"
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new RequestValidationError(
      "The signed output upload payload is invalid"
    );
  }
  const payload = decoded as Record<string, unknown>;
  const renderId = validIdentifier(payload.renderId, "renderId");
  const manifestSha256 = requiredText(
    payload.manifestSha256,
    "manifestSha256",
    64
  );
  const objectBytes = positiveInteger(
    payload.objectBytes,
    "objectBytes",
    MAXIMUM_OUTPUT_BYTES
  );
  const sha256 = requiredText(payload.sha256, "sha256", 64);
  if (
    payload.action !== "upload"
    || !/^[a-f0-9]{64}$/.test(manifestSha256)
    || !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new RequestValidationError(
      "The signed output upload payload is invalid"
    );
  }
  return {
    renderId,
    manifestSha256,
    objectBytes,
    sha256
  };
}

function processorReport(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("report must be a JSON object");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 50_000) {
    throw new RequestValidationError("report is too large");
  }
  return value as Record<string, unknown>;
}

function clipSourceReadinessError(
  episode: {
    durationSeconds: number | null;
    audioKey: string | null;
    audioBytes: number | null;
    audioEtag: string | null;
    audioMimeType: string | null;
    mediaStatus: string;
  }
): string | null {
  if (
    episode.mediaStatus !== "ready"
    || !episode.audioKey
    || !episode.audioBytes
    || !episode.audioEtag
  ) {
    return "clip_source_audio_not_ready";
  }
  if (episode.audioMimeType !== "audio/mpeg") {
    return "clip_source_audio_must_be_mp3";
  }
  if (!episode.durationSeconds) return "clip_episode_duration_required";
  return null;
}

function clipOutputKey(
  env: PodcastEnv,
  showId: string,
  episodeId: string,
  clipId: string,
  revision: number,
  renderId: string
): string {
  return [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    showId,
    episodeId,
    "clips",
    clipId,
    `revision-${revision}`,
    `${renderId}.mp4`
  ].join("/");
}

export function resolveSegmentClipSelection(
  cues: TranscriptCue[],
  startCueId: string,
  endCueId: string,
  episodeDurationMs: number
): {
  startCueIndex: number;
  endCueIndex: number;
  startsAtMs: number;
  endsAtMs: number;
} {
  const startCueIndex = cues.findIndex(({ id }) => id === startCueId);
  const endCueIndex = cues.findIndex(({ id }) => id === endCueId);
  if (
    startCueIndex < 0
    || endCueIndex < startCueIndex
  ) {
    throw new RequestValidationError(
      "The selected cue range is not in the approved transcript"
    );
  }
  const startsAtMs = cues[startCueIndex].startsAtMs;
  const endsAtMs = cues[endCueIndex].endsAtMs;
  validateClipDuration(startsAtMs, endsAtMs, episodeDurationMs);
  return {
    startCueIndex,
    endCueIndex,
    startsAtMs,
    endsAtMs
  };
}

export function validateClipDuration(
  startsAtMs: number,
  endsAtMs: number,
  episodeDurationMs: number
): void {
  const durationMs = endsAtMs - startsAtMs;
  if (
    !Number.isSafeInteger(startsAtMs)
    || !Number.isSafeInteger(endsAtMs)
    || startsAtMs < 0
    || endsAtMs > episodeDurationMs
    || durationMs < MINIMUM_CLIP_DURATION_MS
    || durationMs > MAXIMUM_CLIP_DURATION_MS
  ) {
    throw new RequestValidationError(
      "Clip range must be 1–180 seconds inside the episode"
    );
  }
}

function plainText(
  value: unknown,
  field: string,
  maximum: number
): string {
  const text = requiredText(value, field, maximum).normalize("NFKC").trim();
  if (/[\u0000-\u001f\u007f<>]/.test(text)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return text;
}

function validLanguage(value: unknown): "en" | "es" {
  const language = requiredText(value, "captionLanguage", 2).toLowerCase();
  if (language !== "en" && language !== "es") {
    throw new RequestValidationError("captionLanguage must be en or es");
  }
  return language;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RequestValidationError(`${field} must be a non-negative integer`);
  }
  return number;
}

function positiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < 1
    || number > maximum
  ) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return number;
}

async function currentClipRevision(
  db: D1Database,
  clipId: string
): Promise<number | null> {
  const row = await db.prepare(
    `SELECT revision FROM clips WHERE id = ?`
  ).bind(clipId).first<{ revision: number }>();
  return row?.revision ?? null;
}

function clipConflict(
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
