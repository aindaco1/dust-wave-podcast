import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import {
  prepareAdminAuditAfterSingleChange,
  recordAdminAudit
} from "./audit";
import type { PodcastEnv } from "./env";
import {
  privateConflict,
  privateJson
} from "./http";
import { podcastGuidForFeedUrl } from "./podcast-guid";
import type { ShowStatus } from "./types";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier,
  validSlug
} from "./validation";

const READ_ROLES = ["super_admin", "admin", "producer", "analyst"] as const;
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
  podcast_guid: string | null;
  youtube_channel_url: string | null;
  premium_enabled: number;
  early_access_days: number | null;
  free_mini_episode_enabled: number;
  author_name: string;
  category: string;
  explicit: number;
  test_fixture: number;
  admin_created: number;
  episode_count: number;
};

type ShowCreationRequestRow = ShowAdminRow & {
  creation_request_sha256: string;
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
         s.podcast_guid, s.youtube_channel_url, s.premium_enabled,
         s.early_access_days,
         s.free_mini_episode_enabled, s.author_name, s.category, s.explicit,
         s.test_fixture,
         CASE WHEN s.creation_request_id IS NOT NULL THEN 1 ELSE 0 END
           AS admin_created,
         COUNT(e.id) AS episode_count
       FROM shows s
       LEFT JOIN episodes e ON e.show_id = s.id
       WHERE s.test_fixture = 0
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

export async function createAdminShow(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
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

  const body = await readJsonObject(request, 25_000);
  const requestId = validIdentifier(body.requestId, "requestId");
  if (requestId.length < 16) {
    throw new RequestValidationError("requestId is invalid");
  }
  const slug = validSlug(body.slug, "slug");
  const title = requiredText(body.title, "title", 200);
  const language = requiredText(body.language, "language", 12).toLowerCase();
  if (!["en", "es"].includes(language)) {
    throw new RequestValidationError("language must be en or es");
  }
  const description = optionalText(body.description, "description", 10_000);
  const descriptionEn = optionalText(
    body.descriptionEn,
    "descriptionEn",
    10_000
  );
  const authorName = optionalText(body.authorName, "authorName", 200)
    || "Dust Wave";
  const category = optionalText(body.category, "category", 200) || "Arts";
  const artworkUrl = optionalHttpsUrl(body.artworkUrl, "artworkUrl");
  const youtubeChannelUrl = optionalYouTubeChannelUrl(body.youtubeChannelUrl);
  const earlyAccessDays = body.earlyAccessDays === null
    || body.earlyAccessDays === undefined
    || body.earlyAccessDays === ""
    ? null
    : Number(body.earlyAccessDays);
  if (
    earlyAccessDays !== null
    && (!Number.isSafeInteger(earlyAccessDays)
      || earlyAccessDays < 0
      || earlyAccessDays > 365)
  ) {
    throw new RequestValidationError(
      "earlyAccessDays must be between 0 and 365"
    );
  }
  if (body.explicit !== undefined && typeof body.explicit !== "boolean") {
    throw new RequestValidationError("explicit must be a boolean");
  }
  const explicit = body.explicit === true;
  const confirmation = requiredText(body.confirmation, "confirmation", 180);
  if (confirmation !== `CREATE_SHOW ${slug}`) {
    throw new RequestValidationError(
      `confirmation must exactly match CREATE_SHOW ${slug}`
    );
  }

  const canonicalUrl = `https://dustwave.xyz/podcasts/${slug}/`;
  const feedUrl = `https://feeds.dustwave.xyz/${slug}/rss.xml`;
  const podcastGuid = await podcastGuidForFeedUrl(feedUrl);
  const normalized = {
    slug,
    title,
    language,
    description,
    descriptionEn,
    authorName,
    category,
    artworkUrl,
    youtubeChannelUrl,
    earlyAccessDays,
    explicit
  };
  const requestSha256 = await sha256Hex(JSON.stringify(normalized));

  const replay = await loadAdminShowByCreationRequest(env.DB, requestId);
  if (replay) {
    if (replay.creation_request_sha256 !== requestSha256) {
      return showCreationConflict(
        request,
        env,
        "show_creation_request_conflict"
      );
    }
    return showCreationResponse(request, env, replay, true);
  }

  const retiredRequest = await env.DB.prepare(
    `SELECT show_id
     FROM deleted_show_identities
     WHERE creation_request_id = ?
     LIMIT 1`
  ).bind(requestId).first<{ show_id: string }>();
  if (retiredRequest) {
    return showCreationConflict(request, env, "show_identity_retired");
  }

  const retiredIdentity = await env.DB
    .prepare(
      `SELECT show_id
       FROM deleted_show_identities
       WHERE slug = ? OR rss_slug = ? OR podcast_guid = ?
       LIMIT 1`
    )
    .bind(slug, slug, podcastGuid)
    .first<{ show_id: string }>();
  if (retiredIdentity) {
    return showCreationConflict(request, env, "show_identity_retired");
  }

  const identityConflict = await env.DB
    .prepare(
      `SELECT id
       FROM shows
       WHERE slug = ? OR rss_slug = ? OR podcast_guid = ?
       LIMIT 1`
    )
    .bind(slug, slug, podcastGuid)
    .first<{ id: string }>();
  if (identityConflict) {
    return showCreationConflict(request, env, "show_slug_conflict");
  }

  const showId = `show_${crypto.randomUUID().replace(/-/g, "")}`;
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO shows (
         id, slug, title, description, description_en, language, status,
         artwork_url, canonical_url, rss_slug, podcast_guid,
         youtube_channel_url, premium_enabled, early_access_days,
         free_mini_episode_enabled, author_name, category, explicit,
         test_fixture, creation_request_id, creation_request_sha256
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'coming_soon',
         ?, ?, ?, ?,
         ?, 0, ?,
         0, ?, ?, ?,
         0, ?, ?
       )`
    ).bind(
      showId,
      slug,
      title,
      description,
      descriptionEn,
      language,
      artworkUrl,
      canonicalUrl,
      slug,
      podcastGuid,
      youtubeChannelUrl,
      earlyAccessDays,
      authorName,
      category,
      explicit ? 1 : 0,
      requestId,
      requestSha256
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "show.created",
      targetType: "show",
      targetId: showId,
      metadata: {
        slug,
        language,
        status: "coming_soon",
        premiumEnabled: false,
        freeMiniEpisodeEnabled: false
      }
    })
  ]);
  if ((inserted.meta.changes ?? 0) !== 1) {
    const concurrentReplay = await loadAdminShowByCreationRequest(
      env.DB,
      requestId
    );
    if (
      concurrentReplay
      && concurrentReplay.creation_request_sha256 === requestSha256
    ) {
      return showCreationResponse(request, env, concurrentReplay, true);
    }
    if (concurrentReplay) {
      return showCreationConflict(
        request,
        env,
        "show_creation_request_conflict"
      );
    }
    return showCreationConflict(request, env, "show_slug_conflict");
  }

  const show: ShowAdminRow = {
    id: showId,
    slug,
    title,
    description,
    description_en: descriptionEn,
    language,
    status: "coming_soon",
    artwork_url: artworkUrl,
    canonical_url: canonicalUrl,
    rss_slug: slug,
    podcast_guid: podcastGuid,
    youtube_channel_url: youtubeChannelUrl,
    premium_enabled: 0,
    early_access_days: earlyAccessDays,
    free_mini_episode_enabled: 0,
    author_name: authorName,
    category,
    explicit: explicit ? 1 : 0,
    test_fixture: 0,
    admin_created: 1,
    episode_count: 0
  };
  return showCreationResponse(request, env, show, false, 201);
}

const SHOW_DELETION_HISTORY_GROUPS = [
  ["episodes", [
    "episodes"
  ]],
  ["audience_or_billing", [
    "private_feed_tokens",
    "redemption_codes",
    "show_notification_preferences",
    "show_prices",
    "show_tax_rate_assignments",
    "subscription_checkout_attempts",
    "subscription_entitlement_sources",
    "subscription_invoice_tax_evidence",
    "subscription_tax_change_previews",
    "subscriptions"
  ]],
  ["publication_or_distribution", [
    "clip_publications",
    "clip_youtube_publications",
    "distribution_observation_events",
    "episode_youtube_audio_renditions",
    "episode_youtube_publications",
    "show_feed_validations",
    "site_publications"
  ]],
  ["media_or_import", [
    "media_uploads",
    "rss_import_cutover_packets",
    "rss_import_executions",
    "rss_import_plans",
    "rss_import_podcast_guid_assignments",
    "rss_import_reconciliations",
    "rss_import_redirect_activation_approvals",
    "rss_import_redirect_attestations"
  ]],
  ["marketing_or_ads", [
    "ad_decisions",
    "ad_rules",
    "podcast_announcements",
    "podcast_marketing_links"
  ]],
  ["analytics_or_operations", [
    "launch_lab_runs",
    "podcast_analytics_progress_rollups",
    "podcast_analytics_progress_uniques",
    "podcast_analytics_rollups",
    "podcast_analytics_uniques",
    "queue_dead_letter_incidents"
  ]],
  ["show_access_roles", [
    "admin_user_roles"
  ]]
] as const;

type ShowDeletionRow = {
  id: string;
  slug: string;
  rss_slug: string;
  podcast_guid: string | null;
  creation_request_id: string | null;
  status: ShowStatus;
  test_fixture: number;
};

type DeletedShowIdentityRow = {
  show_id: string;
  slug: string;
  deletion_request_sha256: string;
};

export async function deleteAdminShow(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
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

  const body = await readJsonObject(request, 5_000);
  const requestId = validIdentifier(body.requestId, "requestId");
  if (requestId.length < 16) {
    throw new RequestValidationError("requestId is invalid");
  }
  const confirmation = requiredText(body.confirmation, "confirmation", 180);
  const requestSha256 = await sha256Hex(JSON.stringify({ showId }));

  const replay = await loadDeletedShowIdentity(env.DB, requestId);
  if (replay) {
    if (
      replay.show_id !== showId
      || replay.deletion_request_sha256 !== requestSha256
    ) {
      return showDeletionConflict(
        request,
        env,
        "show_deletion_request_conflict"
      );
    }
    return showDeletionResponse(request, env, replay, true);
  }

  const show = await loadShowForDeletion(env.DB, showId);
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  if (confirmation !== `DELETE_SHOW ${show.slug}`) {
    throw new RequestValidationError(
      `confirmation must exactly match DELETE_SHOW ${show.slug}`
    );
  }

  const blockers = await showDeletionBlockers(env.DB, show);
  if (blockers.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_delete_blocked", blockers },
      { status: 409 }
    );
  }

  const podcastGuid = show.podcast_guid;
  const creationRequestId = show.creation_request_id;
  if (!podcastGuid || !creationRequestId) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_delete_blocked",
        blockers: ["permanent_identity"]
      },
      { status: 409 }
    );
  }

  const [deleted, retired] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM shows AS s
       WHERE s.id = ?
         AND ${showDeletionGuardSql("s")}`
    ).bind(showId),
    env.DB.prepare(
      `INSERT INTO deleted_show_identities (
         show_id, slug, rss_slug, podcast_guid, creation_request_id,
         deletion_request_id, deletion_request_sha256,
         deleted_by_admin_user_id
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE changes() = 1`
    ).bind(
      show.id,
      show.slug,
      show.rss_slug,
      podcastGuid,
      creationRequestId,
      requestId,
      requestSha256,
      auth.authorization.identity.id
    ),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "show.deleted",
      targetType: "show",
      targetId: show.id,
      metadata: {
        slug: show.slug,
        status: show.status,
        identityRetired: true
      }
    })
  ]);

  if ((deleted.meta.changes ?? 0) !== 1 || (retired.meta.changes ?? 0) !== 1) {
    const concurrentReplay = await loadDeletedShowIdentity(env.DB, requestId);
    if (
      concurrentReplay
      && concurrentReplay.show_id === showId
      && concurrentReplay.deletion_request_sha256 === requestSha256
    ) {
      return showDeletionResponse(request, env, concurrentReplay, true);
    }
    const current = await loadShowForDeletion(env.DB, showId);
    const currentBlockers = current
      ? await showDeletionBlockers(env.DB, current)
      : ["show_not_found"];
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_delete_blocked",
        blockers: currentBlockers
      },
      { status: 409 }
    );
  }

  return showDeletionResponse(request, env, {
    show_id: show.id,
    slug: show.slug,
    deletion_request_sha256: requestSha256
  }, false);
}

function showDeletionGuardSql(showAlias: string): string {
  const noHistory = SHOW_DELETION_HISTORY_GROUPS.flatMap(([, tables]) =>
    tables.map((table) =>
      `NOT EXISTS (SELECT 1 FROM ${table} WHERE show_id = ${showAlias}.id)`
    )
  );
  return [
    `${showAlias}.creation_request_id IS NOT NULL`,
    `${showAlias}.creation_request_sha256 IS NOT NULL`,
    `${showAlias}.podcast_guid IS NOT NULL`,
    `${showAlias}.status = 'coming_soon'`,
    `${showAlias}.test_fixture = 0`,
    ...noHistory,
    `NOT EXISTS (
       SELECT 1
       FROM admin_audit_events audit
       WHERE audit.target_type = 'show'
         AND audit.target_id = ${showAlias}.id
         AND audit.action = 'show.site_projection_published'
     )`,
    `NOT EXISTS (
       SELECT 1
       FROM show_audio_qc_policies policy
       WHERE policy.show_id = ${showAlias}.id
         AND (
           policy.revision != 1
           OR policy.updated_by_admin_user_id IS NOT NULL
           OR policy.updated_at != policy.created_at
         )
     )`,
    `NOT EXISTS (
       SELECT 1
       FROM show_transcription_settings settings
       WHERE settings.show_id = ${showAlias}.id
         AND (
           settings.revision != 1
           OR settings.updated_by_admin_user_id IS NOT NULL
           OR settings.updated_at != settings.created_at
         )
     )`,
    `NOT EXISTS (
       SELECT 1
       FROM show_distribution_destinations destination
       WHERE destination.show_id = ${showAlias}.id
         AND (
           destination.owner_setup_status NOT IN ('not_started', 'not_required')
           OR destination.listing_url IS NOT NULL
           OR destination.owner_verified_at IS NOT NULL
           OR destination.last_checked_at IS NOT NULL
           OR destination.last_error IS NOT NULL
           OR destination.owner_account_label IS NOT NULL
           OR destination.submission_date IS NOT NULL
           OR destination.submission_evidence_url IS NOT NULL
           OR destination.setup_notes IS NOT NULL
           OR destination.updated_at != destination.created_at
         )
     )`
  ].join("\n         AND ");
}

async function showDeletionBlockers(
  db: D1Database,
  show: ShowDeletionRow
): Promise<string[]> {
  const blockers: string[] = [];
  if (!show.creation_request_id || !show.podcast_guid) {
    blockers.push("permanent_identity");
  }
  if (show.status !== "coming_soon") blockers.push("show_status");
  if (show.test_fixture === 1) blockers.push("test_fixture");

  const historyColumns = SHOW_DELETION_HISTORY_GROUPS.map(([code, tables]) => {
    const predicates = tables.map((table) =>
      `EXISTS (SELECT 1 FROM ${table} WHERE show_id = ?)`
    );
    return `CASE WHEN ${predicates.join(" OR ")} THEN 1 ELSE 0 END AS ${code}`;
  });
  const historyBindings = SHOW_DELETION_HISTORY_GROUPS.flatMap(([, tables]) =>
    tables.map(() => show.id)
  );
  const history = await db.prepare(
    `SELECT ${historyColumns.join(",\n            ")}`
  ).bind(...historyBindings).first<Record<string, number>>();
  for (const [code] of SHOW_DELETION_HISTORY_GROUPS) {
    if (history?.[code] === 1) blockers.push(code);
  }

  const externalProvisioning = await db.prepare(
    `SELECT 1 AS found
     FROM admin_audit_events
     WHERE target_type = 'show'
       AND target_id = ?
       AND action = 'show.site_projection_published'
     LIMIT 1`
  ).bind(show.id).first<{ found: number }>();
  if (externalProvisioning) blockers.push("website_publication");

  const settings = await db.prepare(
    `SELECT CASE WHEN ${showDeletionSettingsChangedSql()} THEN 1 ELSE 0 END
       AS changed`
  ).bind(show.id, show.id, show.id).first<{ changed: number }>();
  if (settings?.changed === 1) blockers.push("customized_show_settings");
  return blockers;
}

function showDeletionSettingsChangedSql(): string {
  return `EXISTS (
      SELECT 1 FROM show_audio_qc_policies
      WHERE show_id = ?
        AND (
          revision != 1 OR updated_by_admin_user_id IS NOT NULL
          OR updated_at != created_at
        )
    ) OR EXISTS (
      SELECT 1 FROM show_transcription_settings
      WHERE show_id = ?
        AND (
          revision != 1 OR updated_by_admin_user_id IS NOT NULL
          OR updated_at != created_at
        )
    ) OR EXISTS (
      SELECT 1 FROM show_distribution_destinations
      WHERE show_id = ?
        AND (
          owner_setup_status NOT IN ('not_started', 'not_required')
          OR listing_url IS NOT NULL OR owner_verified_at IS NOT NULL
          OR last_checked_at IS NOT NULL OR last_error IS NOT NULL
          OR owner_account_label IS NOT NULL OR submission_date IS NOT NULL
          OR submission_evidence_url IS NOT NULL OR setup_notes IS NOT NULL
          OR updated_at != created_at
        )
    )`;
}

async function loadShowForDeletion(
  db: D1Database,
  showId: string
): Promise<ShowDeletionRow | null> {
  return db.prepare(
    `SELECT id, slug, rss_slug, podcast_guid, creation_request_id,
            status, test_fixture
     FROM shows
     WHERE id = ?`
  ).bind(showId).first<ShowDeletionRow>();
}

async function loadDeletedShowIdentity(
  db: D1Database,
  requestId: string
): Promise<DeletedShowIdentityRow | null> {
  return db.prepare(
    `SELECT show_id, slug, deletion_request_sha256
     FROM deleted_show_identities
     WHERE deletion_request_id = ?
     LIMIT 1`
  ).bind(requestId).first<DeletedShowIdentityRow>();
}

function showDeletionResponse(
  request: Request,
  env: PodcastEnv,
  row: DeletedShowIdentityRow,
  idempotent: boolean
): Response {
  return privateJson(request, env.ALLOWED_ORIGINS, {
    deleted: true,
    idempotent,
    show: { id: row.show_id, slug: row.slug },
    identityRetired: true
  });
}

function showDeletionConflict(
  request: Request,
  env: PodcastEnv,
  error: "show_deletion_request_conflict"
): Response {
  return privateJson(request, env.ALLOWED_ORIGINS, { error }, { status: 409 });
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
  if ("artworkUrl" in body) {
    updates.push({
      column: "artwork_url",
      value: optionalHttpsUrl(body.artworkUrl, "artworkUrl")
    });
  }
  if ("youtubeChannelUrl" in body) {
    updates.push({
      column: "youtube_channel_url",
      value: optionalYouTubeChannelUrl(body.youtubeChannelUrl)
    });
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

function optionalHttpsUrl(
  value: unknown,
  field: string
): string | null {
  const text = optionalText(value, field, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.hash
    ) {
      throw new Error("invalid_https_url");
    }
    return url.toString();
  } catch {
    throw new RequestValidationError(
      `${field} must be an HTTPS URL without credentials, a port, or a fragment`
    );
  }
}

function optionalYouTubeChannelUrl(value: unknown): string | null {
  const urlValue = optionalHttpsUrl(value, "youtubeChannelUrl");
  if (!urlValue) return null;
  const url = new URL(urlValue);
  const permittedHosts = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com"
  ]);
  if (
    !permittedHosts.has(url.hostname.toLowerCase())
    || url.search
    || !/^\/(?:@[A-Za-z0-9._-]+|channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)\/?$/u.test(
      url.pathname
    )
  ) {
    throw new RequestValidationError(
      "youtubeChannelUrl must be a canonical YouTube channel URL"
    );
  }
  return url.toString();
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
    podcastGuid: show.podcast_guid,
    youtubeChannelUrl: show.youtube_channel_url,
    premiumEnabled: show.premium_enabled === 1,
    earlyAccessDays: show.early_access_days,
    freeMiniEpisodeEnabled: show.free_mini_episode_enabled === 1,
    authorName: show.author_name,
    category: show.category,
    explicit: show.explicit === 1,
    testFixture: show.test_fixture === 1,
    episodeCount: show.episode_count,
    deletionCandidate:
      show.admin_created === 1
      && show.status === "coming_soon"
      && show.test_fixture === 0
      && Number(show.episode_count) === 0
  };
}

async function loadAdminShowByCreationRequest(
  db: D1Database,
  requestId: string
): Promise<ShowCreationRequestRow | null> {
  return db.prepare(
    `SELECT
       s.id, s.slug, s.title, s.description, s.description_en, s.language,
       s.status, s.artwork_url, s.canonical_url, s.rss_slug,
       s.podcast_guid, s.youtube_channel_url, s.premium_enabled,
       s.early_access_days,
       s.free_mini_episode_enabled, s.author_name, s.category, s.explicit,
       s.test_fixture, s.creation_request_sha256,
       CASE WHEN s.creation_request_id IS NOT NULL THEN 1 ELSE 0 END
         AS admin_created,
       (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS episode_count
     FROM shows s
     WHERE s.creation_request_id = ?
     LIMIT 1`
  ).bind(requestId).first<ShowCreationRequestRow>();
}

function showCreationResponse(
  request: Request,
  env: PodcastEnv,
  show: ShowAdminRow,
  idempotent: boolean,
  status = 200
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      created: true,
      idempotent,
      show: presentAdminShow(show),
      provisioning: {
        publicSiteReady: false,
        blockers: [
          "site_catalog_entry_required",
          "site_artwork_assets_required"
        ]
      }
    },
    { status }
  );
}

function showCreationConflict(
  request: Request,
  env: PodcastEnv,
  error:
    | "show_creation_request_conflict"
    | "show_slug_conflict"
    | "show_identity_retired"
): Response {
  return privateConflict(request, env, error);
}
