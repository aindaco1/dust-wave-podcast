import { sha256Hex } from "@dustwave/worker-core/crypto";

import { requireAdmin } from "./admin-auth";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import type { EpisodeAccess, EpisodeStatus, PodcastJob, ShowStatus } from "./types";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validDateTime,
  validIdentifier,
  validSlug
} from "./validation";

const READ_ROLES = ["super_admin", "admin", "producer", "analyst"] as const;
const EDIT_ROLES = ["super_admin", "admin", "producer"] as const;
const SHOW_EDIT_ROLES = ["super_admin", "admin"] as const;

type ShowAdminRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  description_en: string;
  language: string;
  status: ShowStatus;
  artwork_url: string | null;
  canonical_url: string;
  rss_slug: string;
  youtube_channel_url: string | null;
  premium_enabled: number;
  early_access_days: number | null;
  free_mini_episode_enabled: number;
  author_name: string;
  category: string;
  explicit: number;
  episode_count: number;
};

export async function listAdminShows(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, { allowedRoles: [...READ_ROLES] });
  if (!auth.ok) return auth.response;
  const result = await env.DB
    .prepare(
      `SELECT
         s.id, s.slug, s.title, s.description, s.description_en, s.language,
         s.status, s.artwork_url, s.canonical_url, s.rss_slug,
         s.youtube_channel_url, s.premium_enabled, s.early_access_days,
         s.free_mini_episode_enabled, s.author_name, s.category, s.explicit,
         COUNT(e.id) AS episode_count
       FROM shows s
       LEFT JOIN episodes e ON e.show_id = s.id
       GROUP BY s.id
       ORDER BY s.title`
    )
    .all<ShowAdminRow>();
  const allowedShowIds = new Set(
    auth.authorization.identity.roles
      .filter(({ role }) => role !== "super_admin")
      .map(({ showId }) => showId)
      .filter((showId): showId is string => Boolean(showId))
  );
  const global = auth.authorization.identity.roles.some(({ role, showId }) =>
    role === "super_admin" || showId === null
  );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    shows: result.results
      .filter((show) => global || allowedShowIds.has(show.id))
      .map(presentAdminShow)
  });
}

export async function updateAdminShow(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...SHOW_EDIT_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request);
  const updates: Array<{ column: string; value: unknown }> = [];

  const textFields = [
    ["title", "title", 200],
    ["description", "description", 10_000],
    ["descriptionEn", "description_en", 10_000],
    ["artworkUrl", "artwork_url", 2_000],
    ["youtubeChannelUrl", "youtube_channel_url", 2_000],
    ["authorName", "author_name", 200],
    ["category", "category", 200]
  ] as const;
  for (const [input, column, maximum] of textFields) {
    if (input in body) {
      updates.push({
        column,
        value: input === "title"
          ? requiredText(body[input], input, maximum)
          : optionalText(body[input], input, maximum)
      });
    }
  }
  if ("language" in body) {
    const language = requiredText(body.language, "language", 12).toLowerCase();
    if (!["en", "es"].includes(language)) {
      throw new RequestValidationError("language must be en or es");
    }
    updates.push({ column: "language", value: language });
  }
  if ("status" in body) {
    const status = requiredText(body.status, "status", 20) as ShowStatus;
    if (!["coming_soon", "active", "archived"].includes(status)) {
      throw new RequestValidationError("show status is invalid");
    }
    updates.push({ column: "status", value: status });
  }
  if ("earlyAccessDays" in body) {
    const days = body.earlyAccessDays === null ? null : Number(body.earlyAccessDays);
    if (days !== null && (!Number.isSafeInteger(days) || days < 0 || days > 365)) {
      throw new RequestValidationError("earlyAccessDays must be between 0 and 365");
    }
    updates.push({ column: "early_access_days", value: days });
  }
  for (const [input, column] of [
    ["premiumEnabled", "premium_enabled"],
    ["freeMiniEpisodeEnabled", "free_mini_episode_enabled"],
    ["explicit", "explicit"]
  ] as const) {
    if (input in body) {
      if (typeof body[input] !== "boolean") {
        throw new RequestValidationError(`${input} must be a boolean`);
      }
      updates.push({ column, value: body[input] ? 1 : 0 });
    }
  }
  if (updates.length === 0) {
    throw new RequestValidationError("No supported show fields were supplied");
  }

  const statement = env.DB.prepare(
    `UPDATE shows
     SET ${updates.map(({ column }) => `${column} = ?`).join(", ")},
         updated_at = datetime('now')
     WHERE id = ?
     RETURNING id`
  ).bind(...updates.map(({ value }) => value), showId);
  const updated = await statement.first<{ id: string }>();
  if (!updated) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "show.updated",
    targetType: "show",
    targetId: showId,
    metadata: { fields: updates.map(({ column }) => column) }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, { updated: true, showId });
}

export async function createAdminEpisode(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...EDIT_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const show = await env.DB
    .prepare(
      `SELECT slug, early_access_days, free_mini_episode_enabled
       FROM shows
       WHERE id = ? AND status != 'archived'`
    )
    .bind(showId)
    .first<{
      slug: string;
      early_access_days: number | null;
      free_mini_episode_enabled: number;
    }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const body = await readJsonObject(request);
  const slug = validSlug(body.slug);
  const title = requiredText(body.title, "title", 240);
  const summary = optionalText(body.summary, "summary", 4_000);
  const contentHtml = optionalText(body.contentHtml, "contentHtml", 100_000);
  const access = requiredText(body.access ?? "public", "access", 30) as EpisodeAccess;
  if (!["public", "early_access", "premium_bonus", "free_mini"].includes(access)) {
    throw new RequestValidationError("episode access is invalid");
  }
  if (access === "free_mini") {
    if (show.free_mini_episode_enabled !== 1) {
      throw new RequestValidationError("This show does not allow a free mini episode");
    }
    const existing = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count
         FROM episodes
         WHERE show_id = ? AND access = 'free_mini' AND status != 'archived'`
      )
      .bind(showId)
      .first<{ count: number }>();
    if ((existing?.count ?? 0) >= 1) {
      throw new RequestValidationError("This show already has its free mini episode");
    }
  }

  const publicAt = validDateTime(body.publicAt, "publicAt");
  let premiumAt = validDateTime(body.premiumAt, "premiumAt");
  if (
    access === "early_access"
    && publicAt
    && !premiumAt
    && show.early_access_days !== null
  ) {
    premiumAt = new Date(
      new Date(publicAt).getTime() - show.early_access_days * 86_400_000
    ).toISOString();
  }
  if (premiumAt && publicAt && new Date(premiumAt) > new Date(publicAt)) {
    throw new RequestValidationError("premiumAt cannot be after publicAt");
  }

  const uuid = crypto.randomUUID();
  const episodeId = `episode_${uuid.replace(/-/g, "")}`;
  const canonicalUrl = `${env.SITE_ORIGIN.replace(/\/$/, "")}/news/podcasts/${show.slug}/${slug}/`;
  await env.DB
    .prepare(
      `INSERT INTO episodes (
         id, show_id, slug, title, summary, content_html, access,
         premium_at, public_at, canonical_url, guid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      episodeId,
      showId,
      slug,
      title,
      summary,
      contentHtml,
      access,
      premiumAt,
      publicAt,
      canonicalUrl,
      `urn:uuid:${uuid}`
    )
    .run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "episode.created",
    targetType: "episode",
    targetId: episodeId,
    metadata: { showId, slug, access }
  });
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { episodeId, canonicalUrl, status: "draft" },
    { status: 201 }
  );
}

export async function listAdminEpisodes(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...READ_ROLES],
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
  const episodes = await env.DB
    .prepare(
      `SELECT
         id, slug, title, summary, content_html, status, access, premium_at,
         public_at, canonical_url, duration_seconds, explicit, media_status,
         audio_filename, audio_bytes, video_source_key, youtube_video_id,
         publication_revision, created_at, updated_at
       FROM episodes
       WHERE show_id = ?
       ORDER BY
         CASE status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
         COALESCE(public_at, created_at) DESC`
    )
    .bind(showId)
    .all<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content_html: string;
      status: EpisodeStatus;
      access: EpisodeAccess;
      premium_at: string | null;
      public_at: string | null;
      canonical_url: string;
      duration_seconds: number | null;
      explicit: number;
      media_status: string;
      audio_filename: string | null;
      audio_bytes: number | null;
      video_source_key: string | null;
      youtube_video_id: string | null;
      publication_revision: number;
      created_at: string;
      updated_at: string;
    }>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    episodes: episodes.results.map((episode) => ({
      id: episode.id,
      slug: episode.slug,
      title: episode.title,
      summary: episode.summary,
      contentHtml: episode.content_html,
      status: episode.status,
      access: episode.access,
      premiumAt: episode.premium_at,
      publicAt: episode.public_at,
      canonicalUrl: episode.canonical_url,
      durationSeconds: episode.duration_seconds,
      explicit: episode.explicit === 1,
      mediaStatus: episode.media_status,
      audioFilename: episode.audio_filename,
      audioBytes: episode.audio_bytes,
      hasVideoSource: Boolean(episode.video_source_key),
      youtubeVideoId: episode.youtube_video_id,
      publicationRevision: episode.publication_revision,
      createdAt: episode.created_at,
      updatedAt: episode.updated_at
    }))
  });
}

export async function updateAdminEpisode(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const episode = await env.DB
    .prepare(`SELECT show_id FROM episodes WHERE id = ?`)
    .bind(episodeId)
    .first<{ show_id: string }>();
  if (!episode) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...EDIT_ROLES],
    requireCsrf: true,
    showId: episode.show_id
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request);
  const updates: Array<{ column: string; value: unknown }> = [];
  for (const [input, column, maximum, required] of [
    ["title", "title", 240, true],
    ["summary", "summary", 4_000, false],
    ["contentHtml", "content_html", 100_000, false]
  ] as const) {
    if (input in body) {
      updates.push({
        column,
        value: required
          ? requiredText(body[input], input, maximum)
          : optionalText(body[input], input, maximum)
      });
    }
  }
  if ("access" in body) {
    const access = requiredText(body.access, "access", 30) as EpisodeAccess;
    if (!["public", "early_access", "premium_bonus", "free_mini"].includes(access)) {
      throw new RequestValidationError("episode access is invalid");
    }
    updates.push({ column: "access", value: access });
  }
  for (const [input, column] of [
    ["premiumAt", "premium_at"],
    ["publicAt", "public_at"]
  ] as const) {
    if (input in body) {
      updates.push({ column, value: validDateTime(body[input], input) });
    }
  }
  if ("durationSeconds" in body) {
    const duration = Number(body.durationSeconds);
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 86_400) {
      throw new RequestValidationError("durationSeconds is invalid");
    }
    updates.push({ column: "duration_seconds", value: duration });
  }
  if ("explicit" in body) {
    if (typeof body.explicit !== "boolean") {
      throw new RequestValidationError("explicit must be a boolean");
    }
    updates.push({ column: "explicit", value: body.explicit ? 1 : 0 });
  }
  if (updates.length === 0) {
    throw new RequestValidationError("No supported episode fields were supplied");
  }
  await env.DB
    .prepare(
      `UPDATE episodes
       SET ${updates.map(({ column }) => `${column} = ?`).join(", ")},
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(...updates.map(({ value }) => value), episodeId)
    .run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "episode.updated",
    targetType: "episode",
    targetId: episodeId,
    metadata: { fields: updates.map(({ column }) => column) }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, { updated: true, episodeId });
}

export async function publishAdminEpisode(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const episode = await env.DB
    .prepare(
      `SELECT
         e.show_id, e.title, e.summary, e.guid, e.audio_key, e.audio_mime_type,
         e.audio_bytes, e.duration_seconds, e.public_at, e.canonical_url,
         e.media_status, e.status, e.access, e.content_html, e.explicit,
         e.video_source_key, e.publication_revision, e.publication_fingerprint,
         s.slug AS show_slug
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.id = ?`
    )
    .bind(episodeId)
    .first<{
      show_id: string;
      title: string;
      summary: string;
      guid: string | null;
      audio_key: string | null;
      audio_mime_type: string | null;
      audio_bytes: number | null;
      duration_seconds: number | null;
      public_at: string | null;
      canonical_url: string;
      media_status: string;
      status: EpisodeStatus;
      access: EpisodeAccess;
      content_html: string;
      explicit: number;
      video_source_key: string | null;
      publication_revision: number;
      publication_fingerprint: string | null;
      show_slug: string;
    }>();
  if (!episode) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...EDIT_ROLES],
    requireCsrf: true,
    showId: episode.show_id
  });
  if (!auth.ok) return auth.response;
  const missing = [
    !episode.title && "title",
    !episode.summary && "summary",
    !episode.guid && "guid",
    !episode.audio_key && "delivery audio",
    !episode.audio_mime_type && "audio MIME type",
    !episode.audio_bytes && "audio byte length",
    !episode.duration_seconds && "duration",
    episode.media_status !== "ready" && "ready media"
  ].filter(Boolean);
  if (missing.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_ready", missing },
      { status: 409 }
    );
  }

  const publicAt = episode.public_at ?? new Date().toISOString();
  const status: EpisodeStatus = new Date(publicAt).getTime() > Date.now()
    ? "scheduled"
    : "published";
  const fingerprint = await sha256Hex(JSON.stringify({
    id: episodeId,
    showId: episode.show_id,
    showSlug: episode.show_slug,
    title: episode.title,
    summary: episode.summary,
    contentHtml: episode.content_html,
    access: episode.access,
    explicit: episode.explicit,
    guid: episode.guid,
    audioKey: episode.audio_key,
    audioMimeType: episode.audio_mime_type,
    audioBytes: episode.audio_bytes,
    durationSeconds: episode.duration_seconds,
    videoSourceKey: episode.video_source_key,
    publicAt,
    canonicalUrl: episode.canonical_url
  }));
  const scheduledAt = publicAt;
  const destinations = await env.DB
    .prepare(
      `SELECT id, enabled, owner_setup_status
       FROM distribution_destinations
       ORDER BY display_order`
    )
    .all<{ id: string; enabled: number; owner_setup_status: string }>();
  if (
    episode.publication_fingerprint === fingerprint
    && episode.publication_revision > 0
    && ["scheduled", "published"].includes(episode.status)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        episodeId,
        status: episode.status,
        publicAt,
        publicationRevision: episode.publication_revision,
        distributionTargets: destinations.results.length,
        idempotent: true
      },
      { status: 200 }
    );
  }
  const revision = episode.publication_revision + 1;
  const queueJobs: PodcastJob[] = [
    makeJob("publish-rss", episode.show_id, episodeId, revision),
    makeJob("publish-news", episode.show_id, episodeId, revision),
    makeJob("publish-youtube", episode.show_id, episodeId, revision)
  ];
  const statements = [
    env.DB.prepare(
      `UPDATE episodes
       SET
         status = ?,
         public_at = ?,
         publication_revision = ?,
         publication_fingerprint = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND publication_revision = ?
         AND COALESCE(publication_fingerprint, '') = COALESCE(?, '')`
    ).bind(
      status,
      publicAt,
      revision,
      fingerprint,
      episodeId,
      episode.publication_revision,
      episode.publication_fingerprint
    ),
    ...queueJobs.map((job) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO distribution_jobs (
         id, episode_id, destination, status, scheduled_at, idempotency_key
       ) VALUES (?, ?, ?, 'queued', ?, ?)`
    ).bind(
      job.id,
      episodeId,
      job.type === "publish-rss"
        ? "rss"
        : job.type === "publish-news"
          ? "news"
          : "youtube",
      scheduledAt,
      `${job.type}:${episodeId}:${revision}`
    )
    )
  ];
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO site_publications (
         id, show_id, episode_id, publication_revision, canonical_url,
         idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      `site_${crypto.randomUUID().replace(/-/g, "")}`,
      episode.show_id,
      episodeId,
      revision,
      episode.canonical_url,
      `news:${episodeId}:${revision}`
    )
  );
  for (const destination of destinations.results) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO episode_publications (
           id, episode_id, destination_id, publication_revision, status,
           idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        `destination_${crypto.randomUUID().replace(/-/g, "")}`,
        episodeId,
        destination.id,
        revision,
        destination.enabled !== 1
          ? "disabled"
          : destination.owner_setup_status === "verified"
            ? "waiting_for_feed"
            : "setup_required",
        `directory:${destination.id}:${episodeId}:${revision}`
      )
    );
  }
  const results = await env.DB.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "publication_conflict",
        message: "The episode changed while it was being published. Reload and retry."
      },
      { status: 409 }
    );
  }
  if (new Date(scheduledAt).getTime() <= Date.now()) {
    for (const job of queueJobs) {
      await env.JOBS.send(job);
    }
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: status === "published" ? "episode.published" : "episode.scheduled",
    targetType: "episode",
    targetId: episodeId,
    metadata: { revision, publicAt, destinations: destinations.results.length }
  });
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      episodeId,
      status,
      publicAt,
      publicationRevision: revision,
      distributionTargets: destinations.results.length
    },
    { status: 202 }
  );
}

export async function listDistributionDestinations(
  request: Request,
  env: PodcastEnv,
  episodeIdValue?: string
): Promise<Response> {
  const auth = await requireAdmin(request, env, { allowedRoles: [...READ_ROLES] });
  if (!auth.ok) return auth.response;
  const episodeId = episodeIdValue
    ? validIdentifier(episodeIdValue, "episodeId")
    : null;
  const result = episodeId
    ? await env.DB.prepare(
      `SELECT
         d.id, d.name, d.mode, d.enabled, d.owner_setup_status,
         d.submission_url, p.status, p.last_observed_at, p.last_error,
         p.publication_revision
       FROM distribution_destinations d
       LEFT JOIN episode_publications p
         ON p.destination_id = d.id AND p.episode_id = ?
       ORDER BY d.display_order, p.publication_revision DESC`
    ).bind(episodeId).all<Record<string, unknown>>()
    : await env.DB.prepare(
      `SELECT
         id, name, mode, enabled, owner_setup_status, submission_url
       FROM distribution_destinations
       ORDER BY display_order`
    ).all<Record<string, unknown>>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    feedUrl: `${env.FEED_ORIGIN.replace(/\/$/, "")}/opera-en-la-selva/rss.xml`,
    destinations: result.results
  });
}

function presentAdminShow(show: ShowAdminRow): Record<string, unknown> {
  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    description: show.description,
    descriptionEn: show.description_en,
    language: show.language,
    status: show.status,
    artworkUrl: show.artwork_url,
    canonicalUrl: show.canonical_url,
    feedUrl: `https://feeds.dustwave.xyz/${show.rss_slug}/rss.xml`,
    youtubeChannelUrl: show.youtube_channel_url,
    premiumEnabled: show.premium_enabled === 1,
    earlyAccessDays: show.early_access_days,
    freeMiniEpisodeEnabled: show.free_mini_episode_enabled === 1,
    authorName: show.author_name,
    category: show.category,
    explicit: show.explicit === 1,
    episodeCount: show.episode_count
  };
}

function makeJob(
  type: PodcastJob["type"],
  showId: string,
  episodeId: string,
  revision: number
): PodcastJob {
  return {
    id: `job_${crypto.randomUUID().replace(/-/g, "")}`,
    type,
    showId,
    episodeId,
    publicationRevision: revision,
    requestedAt: new Date().toISOString()
  };
}
