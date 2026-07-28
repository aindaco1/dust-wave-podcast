import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { AdminRole } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  hashPrivateFeedToken,
  privateFeedTokenNeedsTouch,
  touchPrivateFeedToken
} from "./private-feeds";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
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
const MAXIMUM_CHAPTERS = 500;
const MAXIMUM_CHAPTER_TITLE_LENGTH = 160;
const MAXIMUM_CHAPTER_DOCUMENT_BYTES = 256_000;
const MAXIMUM_EPISODE_DURATION_MS = 86_400_000;

export type EpisodeChapter = {
  id: string;
  startsAtMs: number;
  title: string;
  url: string;
  imageUrl: string;
  toc: boolean;
};

type ChapterSetRow = {
  episode_id: string;
  status: string;
  revision: number;
  content_sha256: string | null;
  approved_revision: number | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type ChapterRow = {
  id: string;
  chapter_key: string | null;
  starts_at_ms: number;
  title: string;
  url: string | null;
  image_url: string | null;
  toc: number;
  sort_order: number;
};

type ApprovedRevisionRow = {
  revision: number;
  content_json: string;
  content_sha256: string;
};

type PublicEpisodeRow = {
  id: string;
};

type PrivateEpisodeRow = {
  id: string;
  last_used_at: string | null;
};

export async function servePublicEpisodeChapters(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  episodeSlug: string
): Promise<Response> {
  const episode = await env.DB
    .prepare(
      `SELECT e.id
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE s.slug = ?
         AND s.status != 'archived'
         AND e.slug = ?
         AND e.status = 'published'
         AND e.public_at <= ${SQL_UTC_NOW_RFC3339}
         AND e.access IN ('public', 'early_access', 'free_mini')
         AND e.media_status = 'ready'
       LIMIT 1`
    )
    .bind(showSlug, episodeSlug)
    .first<PublicEpisodeRow>();
  if (!episode) return chapterNotFound(request, "public");
  return serveApprovedChapterDocument(request, env.DB, episode.id, "public");
}

export async function servePrivateEpisodeChapters(
  request: Request,
  env: PodcastEnv,
  rawToken: string,
  rssSlug: string,
  episodeSlug: string
): Promise<Response> {
  if (!env.FEED_TOKEN_PEPPER) return chapterNotFound(request, "private");
  const tokenHash = await hashPrivateFeedToken(
    rawToken,
    env.FEED_TOKEN_PEPPER
  );
  const episode = await env.DB
    .prepare(
      `SELECT e.id, f.last_used_at
       FROM private_feed_tokens f
       JOIN subscriptions subscription
         ON subscription.listener_id = f.listener_id
        AND subscription.show_id = f.show_id
       JOIN shows s ON s.id = f.show_id
       JOIN episodes e ON e.show_id = s.id
       WHERE f.token_hash = ?
         AND f.revoked_at IS NULL
         AND s.rss_slug = ?
         AND s.status != 'archived'
         AND subscription.status = 'active'
         AND (
           subscription.current_period_end IS NULL
           OR subscription.current_period_end > ${SQL_UTC_NOW_RFC3339}
         )
         AND e.slug = ?
         AND e.status IN ('scheduled', 'published')
         AND e.media_status = 'ready'
         AND (
           (
             e.access IN ('public', 'free_mini')
             AND e.public_at <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             e.access = 'early_access'
             AND COALESCE(e.premium_at, e.public_at)
               <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             e.access = 'premium_bonus'
             AND e.premium_at <= ${SQL_UTC_NOW_RFC3339}
           )
         )
       LIMIT 1`
    )
    .bind(tokenHash, rssSlug, episodeSlug)
    .first<PrivateEpisodeRow>();
  if (!episode) return chapterNotFound(request, "private");
  if (privateFeedTokenNeedsTouch(episode.last_used_at)) {
    await touchPrivateFeedToken(env.DB, tokenHash);
  }
  return serveApprovedChapterDocument(request, env.DB, episode.id, "private");
}

export async function getAdminEpisodeChapters(
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
  return privateJson(request, env.ALLOWED_ORIGINS, {
    chapterSet: await presentChapterSet(
      env.DB,
      authorized.episode.id,
      authorized.episode.durationSeconds
    )
  });
}

export async function saveAdminEpisodeChapters(
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
  const mutationId = validIdentifier(body.mutationId, "mutationId");
  const baseRevision = nonNegativeInteger(body.baseRevision, "baseRevision");
  const durationMs = authorized.episode.durationSeconds === null
    ? null
    : authorized.episode.durationSeconds * 1_000;
  const chapters = normalizeEpisodeChapters(body.chapters, durationMs);
  const content = canonicalChapterContent(chapters);
  const contentJson = serializeChapterContent(content);
  const contentSha256 = await sha256Hex(contentJson);

  const replay = await env.DB
    .prepare(
      `SELECT episode_id, base_revision, target_revision, content_sha256
       FROM episode_chapter_mutations
       WHERE id = ?`
    )
    .bind(mutationId)
    .first<{
      episode_id: string;
      base_revision: number;
      target_revision: number;
      content_sha256: string;
    }>();
  if (replay) {
    if (
      replay.episode_id !== authorized.episode.id
      || replay.base_revision !== baseRevision
      || replay.content_sha256 !== contentSha256
    ) {
      return conflict(request, env, "chapter_mutation_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      chapterSet: await presentChapterSet(
        env.DB,
        authorized.episode.id,
        authorized.episode.durationSeconds
      ),
      idempotent: true
    });
  }

  const targetRevision = baseRevision + 1;
  const revisionId =
    `chapter_revision_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const rowIdentifiers = await Promise.all(chapters.map(async (chapter) => {
    const digest = await sha256Hex(
      `episode-chapter:v1:${authorized.episode.id}:${chapter.id}`
    );
    return `chapter_${digest.slice(0, 32)}`;
  }));
  const mutationGuard =
    `EXISTS (
       SELECT 1
       FROM episode_chapter_mutations mutation
       JOIN episode_chapter_sets chapter_set
         ON chapter_set.episode_id = mutation.episode_id
       WHERE mutation.id = ?
         AND mutation.episode_id = ?
         AND mutation.target_revision = ?
         AND mutation.content_sha256 = ?
         AND chapter_set.revision = mutation.target_revision
         AND chapter_set.content_sha256 = mutation.content_sha256
     )`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO episode_chapter_sets (
         episode_id, status, revision
       )
       SELECT ?, 'needs_review', 0
       WHERE ? = 0`
    ).bind(authorized.episode.id, baseRevision),
    env.DB.prepare(
      `INSERT OR IGNORE INTO episode_chapter_mutations (
         id, episode_id, base_revision, target_revision, content_sha256,
         admin_user_id
       )
       SELECT ?, chapter_set.episode_id, ?, ?, ?, ?
       FROM episode_chapter_sets chapter_set
       WHERE chapter_set.episode_id = ?
         AND chapter_set.revision = ?`
    ).bind(
      mutationId,
      baseRevision,
      targetRevision,
      contentSha256,
      authorized.authorization.identity.id,
      authorized.episode.id,
      baseRevision
    ),
    env.DB.prepare(
      `UPDATE episode_chapter_sets
       SET
         status = 'needs_review',
         revision = ?,
         content_sha256 = ?,
         approved_revision = NULL,
         approved_at = NULL,
         approved_by_admin_user_id = NULL,
         updated_at = datetime('now')
       WHERE episode_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM episode_chapter_mutations mutation
           WHERE mutation.id = ?
             AND mutation.episode_id = episode_chapter_sets.episode_id
             AND mutation.target_revision = ?
             AND mutation.content_sha256 = ?
         )`
    ).bind(
      targetRevision,
      contentSha256,
      authorized.episode.id,
      baseRevision,
      mutationId,
      targetRevision,
      contentSha256
    ),
    env.DB.prepare(
      `DELETE FROM episode_chapters
       WHERE episode_id = ? AND ${mutationGuard}`
    ).bind(
      authorized.episode.id,
      mutationId,
      authorized.episode.id,
      targetRevision,
      contentSha256
    ),
    ...chapters.map((chapter, index) =>
      env.DB.prepare(
        `INSERT INTO episode_chapters (
           id, episode_id, chapter_key, starts_at_ms, title, url, image_url,
           toc, sort_order
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${mutationGuard}`
      ).bind(
        rowIdentifiers[index],
        authorized.episode.id,
        chapter.id,
        chapter.startsAtMs,
        chapter.title,
        chapter.url || null,
        chapter.imageUrl || null,
        chapter.toc ? 1 : 0,
        index,
        mutationId,
        authorized.episode.id,
        targetRevision,
        contentSha256
      )
    ),
    env.DB.prepare(
      `INSERT INTO episode_chapter_revisions (
         id, episode_id, revision, content_json, content_sha256,
         created_by_admin_user_id
       )
       SELECT ?, chapter_set.episode_id, chapter_set.revision, ?, ?, ?
       FROM episode_chapter_sets chapter_set
       WHERE chapter_set.episode_id = ?
         AND chapter_set.revision = ?
         AND chapter_set.content_sha256 = ?
         AND ${mutationGuard}`
    ).bind(
      revisionId,
      contentJson,
      contentSha256,
      authorized.authorization.identity.id,
      authorized.episode.id,
      targetRevision,
      contentSha256,
      mutationId,
      authorized.episode.id,
      targetRevision,
      contentSha256
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'chapters.revised', 'episode', ?, ?
       FROM episode_chapter_mutations
       WHERE id = ? AND episode_id = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      authorized.episode.id,
      JSON.stringify({
        revision: targetRevision,
        chapterCount: chapters.length,
        contentSha256
      }),
      mutationId,
      authorized.episode.id
    )
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    return conflict(request, env, "chapter_revision_conflict", {
      currentRevision: await currentChapterRevision(
        env.DB,
        authorized.episode.id
      )
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    chapterSet: await presentChapterSet(
      env.DB,
      authorized.episode.id,
      authorized.episode.durationSeconds
    ),
    idempotent: false
  });
}

export async function approveAdminEpisodeChapters(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    APPROVE_ROLES,
    { requireCsrf: true }
  );
  if (authorized instanceof Response) return authorized;
  const body = await readJsonObject(request);
  const approvalId = validIdentifier(body.approvalId, "approvalId");
  const expectedRevision = positiveInteger(
    body.expectedRevision,
    "expectedRevision"
  );
  const chapterSet = await loadChapterSet(env.DB, authorized.episode.id);
  if (!chapterSet) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "chapters_not_found" },
      { status: 404 }
    );
  }
  if (
    chapterSet.status === "approved"
    && chapterSet.approved_revision === expectedRevision
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      chapterSet: await presentChapterSet(
        env.DB,
        authorized.episode.id,
        authorized.episode.durationSeconds
      ),
      idempotent: true
    });
  }
  if (chapterSet.revision !== expectedRevision) {
    return conflict(request, env, "chapter_revision_conflict", {
      currentRevision: chapterSet.revision
    });
  }
  const priorApproval = await env.DB
    .prepare(
      `SELECT episode_id, revision
       FROM episode_chapter_approvals
       WHERE id = ?`
    )
    .bind(approvalId)
    .first<{ episode_id: string; revision: number }>();
  if (priorApproval) {
    if (
      priorApproval.episode_id !== authorized.episode.id
      || priorApproval.revision !== expectedRevision
    ) {
      return conflict(request, env, "chapter_approval_conflict");
    }
    return conflict(request, env, "chapter_revision_conflict", {
      currentRevision: chapterSet.revision
    });
  }

  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO episode_chapter_approvals (
         id, episode_id, revision, admin_user_id
       )
       SELECT ?, chapter_set.episode_id, chapter_set.revision, ?
       FROM episode_chapter_sets chapter_set
       JOIN episode_chapter_revisions revision
         ON revision.episode_id = chapter_set.episode_id
        AND revision.revision = chapter_set.revision
        AND revision.content_sha256 = chapter_set.content_sha256
       WHERE chapter_set.episode_id = ?
         AND chapter_set.revision = ?
         AND chapter_set.status = 'needs_review'`
    ).bind(
      approvalId,
      authorized.authorization.identity.id,
      authorized.episode.id,
      expectedRevision
    ),
    env.DB.prepare(
      `UPDATE episode_chapter_sets
       SET
         status = 'approved',
         approved_revision = revision,
         approved_at = datetime('now'),
         approved_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE episode_id = ?
         AND revision = ?
         AND status = 'needs_review'
         AND EXISTS (
           SELECT 1
           FROM episode_chapter_approvals approval
           WHERE approval.id = ?
             AND approval.episode_id = episode_chapter_sets.episode_id
             AND approval.revision = episode_chapter_sets.revision
         )`
    ).bind(
      authorized.authorization.identity.id,
      authorized.episode.id,
      expectedRevision,
      approvalId
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'chapters.approved', 'episode', ?, ?
       FROM episode_chapter_approvals
       WHERE id = ? AND episode_id = ? AND revision = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      authorized.episode.id,
      JSON.stringify({ revision: expectedRevision }),
      approvalId,
      authorized.episode.id,
      expectedRevision
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return conflict(request, env, "chapter_approval_conflict");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    chapterSet: await presentChapterSet(
      env.DB,
      authorized.episode.id,
      authorized.episode.durationSeconds
    ),
    idempotent: false
  });
}

export function normalizeEpisodeChapters(
  value: unknown,
  episodeDurationMs: number | null = null
): EpisodeChapter[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new RequestValidationError("At least one chapter is required");
  }
  if (value.length > MAXIMUM_CHAPTERS) {
    throw new RequestValidationError("The episode has too many chapters");
  }
  const identifiers = new Set<string>();
  let previousStart = -1;
  const normalized = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RequestValidationError(`Chapter ${index + 1} must be an object`);
    }
    const chapter = candidate as Record<string, unknown>;
    const id = validIdentifier(chapter.id, `chapters[${index}].id`);
    if (identifiers.has(id)) {
      throw new RequestValidationError(
        `Chapter ${index + 1} has a duplicate id`
      );
    }
    identifiers.add(id);
    const startsAtMs = chapterMillisecond(
      chapter.startsAtMs,
      `chapters[${index}].startsAtMs`
    );
    if (index === 0 && startsAtMs !== 0) {
      throw new RequestValidationError("The first chapter must start at 00:00");
    }
    if (startsAtMs <= previousStart) {
      throw new RequestValidationError(
        `Chapter ${index + 1} must start after the previous chapter`
      );
    }
    if (episodeDurationMs !== null && startsAtMs >= episodeDurationMs) {
      throw new RequestValidationError(
        `Chapter ${index + 1} starts outside the episode duration`
      );
    }
    previousStart = startsAtMs;
    const title = safeChapterTitle(
      chapter.title,
      `chapters[${index}].title`
    );
    if ("toc" in chapter && typeof chapter.toc !== "boolean") {
      throw new RequestValidationError(
        `chapters[${index}].toc must be a boolean`
      );
    }
    return {
      id,
      startsAtMs,
      title,
      url: optionalHttpsUrl(chapter.url, `chapters[${index}].url`),
      imageUrl: optionalHttpsUrl(
        chapter.imageUrl,
        `chapters[${index}].imageUrl`
      ),
      toc: chapter.toc !== false
    };
  });
  if (!normalized.some(({ toc }) => toc)) {
    throw new RequestValidationError(
      "At least one chapter must appear in the table of contents"
    );
  }
  return normalized;
}

export function canonicalChapterContent(
  chapters: EpisodeChapter[]
): {
  schemaVersion: 1;
  chapters: EpisodeChapter[];
} {
  return {
    schemaVersion: 1,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      startsAtMs: chapter.startsAtMs,
      title: chapter.title,
      url: chapter.url,
      imageUrl: chapter.imageUrl,
      toc: chapter.toc
    }))
  };
}

export function serializeChapterContent(
  content: ReturnType<typeof canonicalChapterContent>
): string {
  const contentJson = JSON.stringify(content);
  if (
    new TextEncoder().encode(contentJson).byteLength
    > MAXIMUM_CHAPTER_DOCUMENT_BYTES
  ) {
    throw new RequestValidationError(
      "The chapter document exceeds the review limit"
    );
  }
  return contentJson;
}

function parseChapterContent(
  value: string
): ReturnType<typeof canonicalChapterContent> {
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: number;
      chapters?: unknown;
    };
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.chapters)) {
      return canonicalChapterContent(normalizeEpisodeChapters(parsed.chapters));
    }
  } catch {
    // Malformed and legacy payloads remain private and fail closed.
  }
  return { schemaVersion: 1, chapters: [] };
}

async function serveApprovedChapterDocument(
  request: Request,
  db: D1Database,
  episodeId: string,
  visibility: "public" | "private"
): Promise<Response> {
  const revision = await db
    .prepare(
      `SELECT
         revision.revision,
         revision.content_json,
         revision.content_sha256
       FROM episode_chapter_approvals approval
       JOIN episode_chapter_revisions revision
         ON revision.episode_id = approval.episode_id
        AND revision.revision = approval.revision
       WHERE approval.episode_id = ?
       ORDER BY approval.revision DESC
       LIMIT 1`
    )
    .bind(episodeId)
    .first<ApprovedRevisionRow>();
  if (!revision) return chapterNotFound(request, visibility);
  const content = parseChapterContent(revision.content_json);
  if (content.chapters.length < 1) {
    return chapterNotFound(request, visibility);
  }
  const canonicalJson = serializeChapterContent(content);
  if (await sha256Hex(canonicalJson) !== revision.content_sha256) {
    return chapterNotFound(request, visibility);
  }
  const chapterDocument = {
    version: "1.2.0",
    chapters: content.chapters.map((chapter) => ({
      startTime: chapter.startsAtMs / 1_000,
      title: chapter.title,
      ...(chapter.imageUrl ? { img: chapter.imageUrl } : {}),
      ...(chapter.url ? { url: chapter.url } : {}),
      ...(chapter.toc ? {} : { toc: false })
    }))
  };
  const bodyJson = JSON.stringify(chapterDocument);
  const etag = `"${await sha256Hex(bodyJson)}"`;
  const headers = chapterHeaders(
    visibility,
    visibility === "public"
      ? "public, max-age=60, stale-while-revalidate=300"
      : "private, no-store, max-age=0"
  );
  headers.set("etag", etag);
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : bodyJson, {
    status: 200,
    headers
  });
}

async function presentChapterSet(
  db: D1Database,
  episodeId: string,
  durationSeconds: number | null
): Promise<Record<string, unknown>> {
  const chapterSet = await loadChapterSet(db, episodeId);
  const chapterRows = await db
    .prepare(
      `SELECT
         id, chapter_key, starts_at_ms, title, url, image_url, toc, sort_order
       FROM episode_chapters
       WHERE episode_id = ?
       ORDER BY sort_order, starts_at_ms`
    )
    .bind(episodeId)
    .all<ChapterRow>();
  return {
    episodeId,
    durationSeconds,
    status: chapterSet?.status ?? "needs_review",
    revision: chapterSet?.revision ?? 0,
    contentSha256: chapterSet?.content_sha256 ?? null,
    approvedRevision: chapterSet?.approved_revision ?? null,
    approvedAt: chapterSet?.approved_at ?? null,
    chapters: chapterRows.results.map((row, index) => ({
      id: currentChapterPublicId(row.chapter_key, index),
      startsAtMs: row.starts_at_ms,
      title: row.title,
      url: row.url ?? "",
      imageUrl: row.image_url ?? "",
      toc: row.toc === 1
    })),
    createdAt: chapterSet?.created_at ?? null,
    updatedAt: chapterSet?.updated_at ?? null
  };
}

function currentChapterPublicId(chapterKey: string | null, index: number): string {
  return chapterKey && /^[A-Za-z0-9_-]+$/.test(chapterKey)
    ? chapterKey
    : `chapter_${String(index + 1).padStart(3, "0")}`;
}

async function loadChapterSet(
  db: D1Database,
  episodeId: string
): Promise<ChapterSetRow | null> {
  return db
    .prepare(
      `SELECT
         episode_id, status, revision, content_sha256, approved_revision,
         approved_at, created_at, updated_at
       FROM episode_chapter_sets
       WHERE episode_id = ?`
    )
    .bind(episodeId)
    .first<ChapterSetRow>();
}

async function currentChapterRevision(
  db: D1Database,
  episodeId: string
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT revision FROM episode_chapter_sets WHERE episode_id = ?`
    )
    .bind(episodeId)
    .first<{ revision: number }>();
  return row?.revision ?? null;
}

function chapterNotFound(
  request: Request,
  visibility: "public" | "private"
): Response {
  return new Response(
    request.method === "HEAD"
      ? null
      : JSON.stringify({ error: "chapters_not_found" }),
    {
      status: 404,
      headers: chapterHeaders(
        visibility,
        visibility === "public"
          ? "no-store"
          : "private, no-store, max-age=0"
      )
    }
  );
}

function chapterHeaders(
  visibility: "public" | "private",
  cacheControl: string
): Headers {
  const headers = new Headers({
    "content-type": "application/json+chapters; charset=utf-8",
    "cache-control": cacheControl,
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy":
      visibility === "public" ? "cross-origin" : "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer"
  });
  if (visibility === "public") {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", "etag");
  }
  return headers;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*"
      || value === etag
      || (value.startsWith("W/") && value.slice(2) === etag);
  });
}

function safeChapterTitle(value: unknown, field: string): string {
  const title = requiredText(value, field, MAXIMUM_CHAPTER_TITLE_LENGTH)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/.test(title)
  ) {
    throw new RequestValidationError(
      `${field} contains unsafe control or markup characters`
    );
  }
  return title;
}

function optionalHttpsUrl(value: unknown, field: string): string {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) return "";
  if (text.length > 2_048 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RequestValidationError(`${field} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:"
    || Boolean(url.username)
    || Boolean(url.password)
  ) {
    throw new RequestValidationError(`${field} must be an HTTPS URL`);
  }
  return url.href;
}

function chapterMillisecond(value: unknown, field: string): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < 0
    || number > MAXIMUM_EPISODE_DURATION_MS
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

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return number;
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
