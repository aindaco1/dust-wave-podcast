import {
  hasAdminRoleForShow,
  requireAdmin,
  requireRecentAdminAuthentication,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import {
  serveVerifiedClipRenderMedia,
  verifyClipRenderObject,
  type ClipRenderMediaEvidence
} from "./clips";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  optionalText,
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const EDIT_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_CLIP_LIMIT = 24;

type PublicEpisodeRow = {
  id: string;
  canonical_url: string;
};

type ClipPublicationRow = ClipRenderMediaEvidence & {
  publication_id: string;
  show_id: string;
  show_slug: string;
  show_status: string;
  episode_id: string;
  episode_slug: string;
  episode_status: string;
  episode_access: string;
  episode_public_at: string | null;
  episode_media_status: string;
  canonical_url: string;
  current_clip_revision: number;
  current_recipe_sha256: string | null;
  public_slug: string;
  publication_title: string;
  publication_description: string;
  publication_status: "draft" | "approved" | "withdrawn";
  published_object_key: string;
  published_object_bytes: number;
  published_object_etag: string;
  published_sha256: string;
  published_mime_type: string;
  published_width: number;
  published_height: number;
  published_duration_ms: number;
  published_manifest_sha256: string;
  aspect_ratio: "9:16" | "1:1" | "16:9";
  caption_language: "en" | "es" | null;
  requested_at: string;
  approved_at: string | null;
  withdrawn_at: string | null;
  updated_at: string;
};

export async function createAdminClipPublicationDraft(
  request: Request,
  env: PodcastEnv,
  renderIdValue: string
): Promise<Response> {
  if (!clipPublicationEnabled(env)) {
    return clipPublicationNotFound(request, env);
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
    return clipPublicationNotFound(request, env);
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
  const publicSlug = validPublicSlug(body.publicSlug);
  const title = plainText(body.title, "title", 160);
  const description = plainText(
    optionalText(body.description, "description", 1_000),
    "description",
    1_000,
    true
  );
  if (
    render.clip_revision !== expectedClipRevision
    || render.current_clip_revision !== expectedClipRevision
    || render.recipe_sha256 !== render.current_recipe_sha256
    || !["en", "es"].includes(String(render.caption_language))
    || !episodeCanSchedulePublicClip(render)
  ) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_render_not_current"
    );
  }
  const objectHead = await verifyClipRenderObject(env, render);
  if (!objectHead) {
    return clipPublicationConflict(
      request,
      env,
      "clip_render_object_mismatch"
    );
  }
  const existing = await loadClipPublicationById(env.DB, publicationId);
  if (existing) {
    if (!sameDraft(existing, {
      renderId,
      expectedClipRevision,
      publicSlug,
      title,
      description
    })) {
      return clipPublicationConflict(
        request,
        env,
        "clip_publication_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentAdminClipPublication(existing),
      idempotent: true
    });
  }
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO clip_publications (
         id, show_id, episode_id, clip_id, clip_revision, render_id,
         public_slug, title, description, output_object_key,
         output_object_bytes, output_object_etag, output_sha256,
         output_mime_type, output_width, output_height, output_duration_ms,
         processor_manifest_sha256, requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      publicationId,
      render.show_id,
      render.episode_id,
      render.clip_id,
      expectedClipRevision,
      renderId,
      publicSlug,
      title,
      description,
      render.output_object_key,
      render.output_object_bytes,
      objectHead.httpEtag,
      render.output_sha256,
      render.output_mime_type,
      render.output_width,
      render.output_height,
      render.output_duration_ms,
      render.processor_manifest_sha256,
      auth.authorization.identity.id
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "clip.publication_draft_created",
      targetType: "clip_publication",
      targetId: publicationId,
      metadata: {
        showId: render.show_id,
        episodeId: render.episode_id,
        clipId: render.clip_id,
        renderId,
        clipRevision: expectedClipRevision,
        publicSlug
      }
    })
  ]);
  const created = await loadClipPublicationById(env.DB, publicationId);
  if (
    Number(inserted.meta.changes ?? 0) !== 1
    || !created
    || !sameDraft(created, {
      renderId,
      expectedClipRevision,
      publicSlug,
      title,
      description
    })
  ) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_render_already_prepared"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentAdminClipPublication(created),
    idempotent: false
  });
}

export async function approveAdminClipPublication(
  request: Request,
  env: PodcastEnv,
  publicationIdValue: string
): Promise<Response> {
  if (!clipPublicationEnabled(env)) {
    return clipPublicationNotFound(request, env);
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
  const publication = await loadClipPublicationById(env.DB, publicationId);
  if (!publication) return clipPublicationNotFound(request, env);
  if (publication.publication_status === "approved") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentAdminClipPublication(publication),
      idempotent: true
    });
  }
  if (
    publication.publication_status !== "draft"
    || !publicationEvidenceCurrent(publication)
    || !episodeCanSchedulePublicClip(publication)
  ) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_not_ready"
    );
  }
  const objectHead = await verifyClipRenderObject(env, publication);
  if (
    !objectHead
    || objectHead.httpEtag !== publication.published_object_etag
  ) {
    return clipPublicationConflict(
      request,
      env,
      "clip_render_object_mismatch"
    );
  }
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE clip_publications
       SET
         status = 'approved',
         approved_by_admin_user_id = ?,
         approved_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status = 'draft'
         AND EXISTS (
           SELECT 1
           FROM clip_renders render
           JOIN clips clip ON clip.id = render.clip_id
           JOIN episodes episode ON episode.id = clip.episode_id
           JOIN shows show_record ON show_record.id = episode.show_id
           WHERE render.id = clip_publications.render_id
             AND render.clip_id = clip_publications.clip_id
             AND render.clip_revision = clip_publications.clip_revision
             AND clip.revision = clip_publications.clip_revision
             AND clip.recipe_sha256 = render.recipe_sha256
             AND render.status = 'ready'
             AND render.output_object_key =
               clip_publications.output_object_key
             AND render.output_object_bytes =
               clip_publications.output_object_bytes
             AND render.output_sha256 = clip_publications.output_sha256
             AND render.output_mime_type =
               clip_publications.output_mime_type
             AND render.output_width = clip_publications.output_width
             AND render.output_height = clip_publications.output_height
             AND render.output_duration_ms =
               clip_publications.output_duration_ms
             AND render.processor_manifest_sha256 =
               clip_publications.processor_manifest_sha256
             AND episode.id = clip_publications.episode_id
             AND episode.show_id = clip_publications.show_id
             AND episode.status IN ('scheduled', 'published')
             AND episode.public_at IS NOT NULL
             AND episode.access IN ('public', 'early_access', 'free_mini')
             AND show_record.status != 'archived'
         )`
    ).bind(auth.authorization.identity.id, publicationId),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "clip.publication_approved",
      targetType: "clip_publication",
      targetId: publicationId,
      metadata: {
        showId: publication.show_id,
        episodeId: publication.episode_id,
        clipId: publication.clip_id,
        renderId: publication.id,
        clipRevision: publication.clip_revision,
        publicSlug: publication.public_slug,
        mode: clipPublicationMode(env)
      }
    })
  ]);
  if (Number(updated.meta.changes ?? 0) !== 1) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_conflict"
    );
  }
  const approved = await loadClipPublicationById(env.DB, publicationId);
  if (!approved) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentAdminClipPublication(approved),
    idempotent: false
  });
}

export async function withdrawAdminClipPublication(
  request: Request,
  env: PodcastEnv,
  publicationIdValue: string
): Promise<Response> {
  if (!clipPublicationEnabled(env)) {
    return clipPublicationNotFound(request, env);
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
  const publication = await loadClipPublicationById(env.DB, publicationId);
  if (!publication) return clipPublicationNotFound(request, env);
  if (publication.publication_status === "withdrawn") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      publication: presentAdminClipPublication(publication),
      idempotent: true
    });
  }
  if (publication.publication_status !== "approved") {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_not_approved"
    );
  }
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE clip_publications
       SET
         status = 'withdrawn',
         withdrawn_by_admin_user_id = ?,
         withdrawn_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'approved'`
    ).bind(auth.authorization.identity.id, publicationId),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "clip.publication_withdrawn",
      targetType: "clip_publication",
      targetId: publicationId,
      metadata: {
        showId: publication.show_id,
        episodeId: publication.episode_id,
        clipId: publication.clip_id,
        publicSlug: publication.public_slug
      }
    })
  ]);
  if (Number(updated.meta.changes ?? 0) !== 1) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_conflict"
    );
  }
  const withdrawn = await loadClipPublicationById(env.DB, publicationId);
  if (!withdrawn) {
    return clipPublicationConflict(
      request,
      env,
      "clip_publication_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    publication: presentAdminClipPublication(withdrawn),
    idempotent: false
  });
}

export async function listPublicEpisodeClips(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  episodeSlug: string
): Promise<Response> {
  if (!clipPublicationEnabled(env)) {
    return publicClipNotFound();
  }
  const episode = await loadPublicEpisode(env.DB, showSlug, episodeSlug);
  if (!episode) return publicClipNotFound();
  const publications = await env.DB.prepare(
    `${publicClipSelect()}
     WHERE show_record.slug = ?
       AND episode.slug = ?
       AND publication.status = 'approved'
       AND show_record.status != 'archived'
       AND episode.status = 'published'
       AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
       AND episode.access IN ('public', 'early_access', 'free_mini')
       AND episode.media_status = 'ready'
       AND clip.revision = publication.clip_revision
       AND clip.recipe_sha256 = render.recipe_sha256
       AND render.clip_revision = publication.clip_revision
       AND render.status = 'ready'
       AND render.output_object_key = publication.output_object_key
       AND render.output_object_bytes = publication.output_object_bytes
       AND render.output_sha256 = publication.output_sha256
       AND render.output_mime_type = publication.output_mime_type
       AND render.output_width = publication.output_width
       AND render.output_height = publication.output_height
       AND render.output_duration_ms = publication.output_duration_ms
       AND render.processor_manifest_sha256 =
         publication.processor_manifest_sha256
     ORDER BY publication.approved_at, publication.public_slug
     LIMIT ?`
  ).bind(
    showSlug,
    episodeSlug,
    PUBLIC_CLIP_LIMIT + 1
  ).all<ClipPublicationRow>();
  const truncated = publications.results.length > PUBLIC_CLIP_LIMIT;
  const clips = publications.results
    .slice(0, PUBLIC_CLIP_LIMIT)
    .map((publication) =>
    presentPublicClip(env, publication)
  );
  return publicClipJson(
    request,
    {
      schemaVersion: 1,
      episode: {
        showSlug,
        slug: episodeSlug,
        canonicalUrl: episode.canonical_url
      },
      clips,
      truncated
    }
  );
}

export async function servePublicClipMedia(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  episodeSlug: string,
  publicSlug: string
): Promise<Response> {
  if (!clipPublicationEnabled(env)) return publicClipNotFound();
  const publication = await env.DB.prepare(
    `${publicClipSelect()}
     WHERE show_record.slug = ?
       AND episode.slug = ?
       AND publication.public_slug = ?
       AND publication.status = 'approved'
       AND show_record.status != 'archived'
       AND episode.status = 'published'
       AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
       AND episode.access IN ('public', 'early_access', 'free_mini')
       AND episode.media_status = 'ready'
       AND clip.revision = publication.clip_revision
       AND clip.recipe_sha256 = render.recipe_sha256
       AND render.clip_revision = publication.clip_revision
       AND render.status = 'ready'
       AND render.output_object_key = publication.output_object_key
       AND render.output_object_bytes = publication.output_object_bytes
       AND render.output_sha256 = publication.output_sha256
       AND render.output_mime_type = publication.output_mime_type
       AND render.output_width = publication.output_width
       AND render.output_height = publication.output_height
       AND render.output_duration_ms = publication.output_duration_ms
       AND render.processor_manifest_sha256 =
         publication.processor_manifest_sha256
     LIMIT 1`
  ).bind(
    showSlug,
    episodeSlug,
    validPublicSlug(publicSlug)
  ).first<ClipPublicationRow>();
  if (!publication) return publicClipNotFound();
  const response = await serveVerifiedClipRenderMedia(
    request,
    env,
    publication,
    {
      visibility: "public",
      filename: `${publication.public_slug}.mp4`,
      canonicalUrl: publication.canonical_url
    }
  );
  return response ?? publicClipNotFound();
}

function clipPublicationMode(
  env: PodcastEnv
): "disabled" | "staging_preview" | "live" {
  const mode = String(env.CLIP_PUBLICATION_MODE ?? "disabled");
  if (mode === "staging_preview" || mode === "live") return mode;
  return "disabled";
}

function clipPublicationEnabled(env: PodcastEnv): boolean {
  const mode = clipPublicationMode(env);
  const environment = String(env.ENVIRONMENT);
  return (environment === "staging" && mode === "staging_preview")
    || (environment === "production" && mode === "live");
}

function episodeCanSchedulePublicClip(
  row: Pick<
    ClipPublicationRow,
    | "show_status"
    | "episode_status"
    | "episode_access"
    | "episode_public_at"
    | "caption_language"
  >
): boolean {
  return row.show_status !== "archived"
    && ["scheduled", "published"].includes(row.episode_status)
    && ["public", "early_access", "free_mini"].includes(row.episode_access)
    && ["en", "es"].includes(String(row.caption_language))
    && Boolean(row.episode_public_at);
}

function publicationEvidenceCurrent(row: ClipPublicationRow): boolean {
  return row.clip_revision === row.current_clip_revision
    && row.recipe_sha256 === row.current_recipe_sha256
    && row.output_object_key === row.published_object_key
    && row.output_object_bytes === row.published_object_bytes
    && row.output_sha256 === row.published_sha256
    && row.output_mime_type === row.published_mime_type
    && row.output_width === row.published_width
    && row.output_height === row.published_height
    && row.output_duration_ms === row.published_duration_ms
    && row.processor_manifest_sha256 === row.published_manifest_sha256;
}

async function loadPublicEpisode(
  db: D1Database,
  showSlug: string,
  episodeSlug: string
): Promise<PublicEpisodeRow | null> {
  return db.prepare(
    `SELECT episode.id, episode.canonical_url
     FROM episodes episode
     JOIN shows show_record ON show_record.id = episode.show_id
     WHERE show_record.slug = ?
       AND show_record.status != 'archived'
       AND episode.slug = ?
       AND episode.status = 'published'
       AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
       AND episode.access IN ('public', 'early_access', 'free_mini')
       AND episode.media_status = 'ready'
     LIMIT 1`
  ).bind(showSlug, episodeSlug).first<PublicEpisodeRow>();
}

async function loadReadyClipRender(
  db: D1Database,
  renderId: string
): Promise<ClipPublicationRow | null> {
  return db.prepare(
    `${clipPublicationSelect()}
     WHERE render.id = ?`
  ).bind(renderId).first<ClipPublicationRow>();
}

async function loadClipPublicationById(
  db: D1Database,
  publicationId: string
): Promise<ClipPublicationRow | null> {
  return db.prepare(
    `${clipPublicationSelect()}
     WHERE publication.id = ?`
  ).bind(publicationId).first<ClipPublicationRow>();
}

function clipPublicationSelect(): string {
  return `SELECT
      COALESCE(publication.id, '') AS publication_id,
      render.id, render.clip_id, render.clip_revision, render.recipe_sha256,
      render.processor_manifest_sha256, render.output_object_key,
      render.status, render.output_object_bytes, render.output_sha256,
      render.output_mime_type, render.output_width, render.output_height,
      render.output_duration_ms, render.processor_version,
      render.failure_code, render.requested_at, render.completed_at,
      clip.revision AS current_clip_revision,
      clip.recipe_sha256 AS current_recipe_sha256,
      clip.title AS clip_title, clip.aspect_ratio, clip.caption_language,
      episode.id AS episode_id, episode.slug AS episode_slug,
      episode.status AS episode_status, episode.access AS episode_access,
      episode.public_at AS episode_public_at,
      episode.media_status AS episode_media_status,
      episode.canonical_url,
      show_record.id AS show_id, show_record.slug AS show_slug,
      show_record.status AS show_status,
      COALESCE(publication.public_slug, '') AS public_slug,
      COALESCE(publication.title, '') AS publication_title,
      COALESCE(publication.description, '') AS publication_description,
      COALESCE(publication.status, 'draft') AS publication_status,
      COALESCE(
        publication.output_object_key,
        render.output_object_key
      ) AS published_object_key,
      COALESCE(
        publication.output_object_bytes,
        render.output_object_bytes
      ) AS published_object_bytes,
      COALESCE(publication.output_object_etag, '') AS published_object_etag,
      publication.output_object_etag AS expected_object_etag,
      COALESCE(
        publication.output_sha256,
        render.output_sha256
      ) AS published_sha256,
      COALESCE(
        publication.output_mime_type,
        render.output_mime_type
      ) AS published_mime_type,
      COALESCE(publication.output_width, render.output_width)
        AS published_width,
      COALESCE(publication.output_height, render.output_height)
        AS published_height,
      COALESCE(
        publication.output_duration_ms,
        render.output_duration_ms
      ) AS published_duration_ms,
      COALESCE(
        publication.processor_manifest_sha256,
        render.processor_manifest_sha256
      ) AS published_manifest_sha256,
      COALESCE(publication.requested_at, render.requested_at)
        AS requested_at,
      publication.approved_at,
      publication.withdrawn_at,
      COALESCE(publication.updated_at, render.requested_at) AS updated_at
    FROM clip_renders render
    JOIN clips clip ON clip.id = render.clip_id
    JOIN episodes episode ON episode.id = clip.episode_id
    JOIN shows show_record ON show_record.id = episode.show_id
    LEFT JOIN clip_publications publication
      ON publication.render_id = render.id`;
}

function publicClipSelect(): string {
  return clipPublicationSelect();
}

function sameDraft(
  publication: ClipPublicationRow,
  expected: {
    renderId: string;
    expectedClipRevision: number;
    publicSlug: string;
    title: string;
    description: string;
  }
): boolean {
  return publication.id === expected.renderId
    && publication.clip_revision === expected.expectedClipRevision
    && publication.public_slug === expected.publicSlug
    && publication.publication_title === expected.title
    && publication.publication_description === expected.description;
}

function presentAdminClipPublication(
  row: ClipPublicationRow
): Record<string, unknown> {
  return {
    id: row.publication_id,
    showId: row.show_id,
    episodeId: row.episode_id,
    clipId: row.clip_id,
    clipRevision: row.clip_revision,
    renderId: row.id,
    publicSlug: row.public_slug,
    title: row.publication_title,
    description: row.publication_description,
    status: row.publication_status,
    aspectRatio: row.aspect_ratio,
    width: row.published_width,
    height: row.published_height,
    durationMs: row.published_duration_ms,
    captionLanguage: row.caption_language,
    evidenceCurrent: publicationEvidenceCurrent(row),
    publicPath: publicClipPath(
      row.show_slug,
      row.episode_slug,
      row.public_slug
    ),
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    withdrawnAt: row.withdrawn_at,
    updatedAt: row.updated_at
  };
}

function presentPublicClip(
  env: PodcastEnv,
  row: ClipPublicationRow
): Record<string, unknown> {
  const path = publicClipPath(
    row.show_slug,
    row.episode_slug,
    row.public_slug
  );
  return {
    slug: row.public_slug,
    title: row.publication_title,
    description: row.publication_description,
    aspectRatio: row.aspect_ratio,
    width: row.published_width,
    height: row.published_height,
    durationMs: row.published_duration_ms,
    captionLanguage: row.caption_language,
    mediaUrl: new URL(path, env.MEDIA_ORIGIN).toString(),
    downloadUrl: new URL(`${path}?download=1`, env.MEDIA_ORIGIN).toString(),
    canonicalUrl: row.canonical_url
  };
}

function publicClipPath(
  showSlug: string,
  episodeSlug: string,
  publicSlug: string
): string {
  return `/v1/shows/${showSlug}/episodes/${episodeSlug}`
    + `/clips/${publicSlug}.mp4`;
}

function validPublicSlug(value: unknown): string {
  const slug = requiredText(value, "publicSlug", 100);
  if (!PUBLIC_SLUG_PATTERN.test(slug)) {
    throw new RequestValidationError(
      "publicSlug must contain lowercase letters, digits, and single hyphens"
    );
  }
  return slug;
}

function plainText(
  value: unknown,
  name: string,
  maximumLength: number,
  allowEmpty = false
): string {
  const text = typeof value === "string"
    ? value.trim().replace(/\r\n?/g, "\n")
    : "";
  if (
    (!allowEmpty && !text)
    || text.length > maximumLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  ) {
    throw new RequestValidationError(`${name} is invalid`);
  }
  return text;
}

async function publicClipJson(
  request: Request,
  body: Record<string, unknown>
): Promise<Response> {
  const bodyJson = JSON.stringify(body);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bodyJson)
  );
  const etag = `"${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}"`;
  const headers = new Headers({
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=60, must-revalidate",
    "content-type": "application/json; charset=utf-8",
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, noarchive"
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : bodyJson, {
    headers
  });
}

function publicClipNotFound(): Response {
  return new Response(JSON.stringify({ error: "clip_not_found" }), {
    status: 404,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

function clipPublicationNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "clip_publication_not_found" },
    { status: 404 }
  );
}

function clipPublicationConflict(
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
