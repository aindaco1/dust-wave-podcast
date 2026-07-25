import { requireAdmin } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const READ_ROLES = ["super_admin", "admin", "producer", "analyst"] as const;
const SHOW_EDIT_ROLES = ["super_admin", "admin"] as const;

export async function listDistributionDestinations(
  request: Request,
  env: PodcastEnv,
  episodeIdValue?: string
): Promise<Response> {
  let showId: string;
  let episodeId: string | null = null;
  if (episodeIdValue) {
    const access = await authorizeAdminEpisode(
      request,
      env,
      episodeIdValue,
      [...READ_ROLES]
    );
    if (access instanceof Response) return access;
    showId = access.episode.showId;
    episodeId = access.episode.id;
  } else {
    showId = validIdentifier(
      new URL(request.url).searchParams.get("showId"),
      "showId"
    );
    const auth = await requireAdmin(request, env, {
      allowedRoles: [...READ_ROLES],
      showId
    });
    if (!auth.ok) return auth.response;
  }
  const show = await env.DB
    .prepare(
      `SELECT id, title, rss_slug
       FROM shows
       WHERE id = ?`
    )
    .bind(showId)
    .first<{ id: string; title: string; rss_slug: string }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const result = episodeId
    ? await env.DB.prepare(
      `SELECT
         d.id,
         d.name,
         d.mode,
         COALESCE(sd.enabled, d.enabled) AS enabled,
         COALESCE(sd.owner_setup_status, d.owner_setup_status)
           AS owner_setup_status,
         d.submission_url,
         sd.listing_url,
         sd.owner_verified_at,
         sd.last_checked_at,
         sd.last_error AS setup_error,
         p.status AS publication_status,
         p.last_observed_at,
         p.last_error AS publication_error,
         p.publication_revision
       FROM distribution_destinations d
       LEFT JOIN show_distribution_destinations sd
         ON sd.destination_id = d.id AND sd.show_id = ?
       LEFT JOIN episode_publications p
         ON p.destination_id = d.id
         AND p.episode_id = ?
         AND p.publication_revision = (
           SELECT MAX(latest.publication_revision)
           FROM episode_publications latest
           WHERE latest.episode_id = ?
             AND latest.destination_id = d.id
         )
       ORDER BY d.display_order`
    ).bind(showId, episodeId, episodeId).all<DistributionDestinationRow>()
    : await env.DB.prepare(
      `SELECT
         d.id,
         d.name,
         d.mode,
         COALESCE(sd.enabled, d.enabled) AS enabled,
         COALESCE(sd.owner_setup_status, d.owner_setup_status)
           AS owner_setup_status,
         d.submission_url,
         sd.listing_url,
         sd.owner_verified_at,
         sd.last_checked_at,
         sd.last_error AS setup_error,
         NULL AS publication_status,
         NULL AS last_observed_at,
         NULL AS publication_error,
         NULL AS publication_revision
       FROM distribution_destinations d
       LEFT JOIN show_distribution_destinations sd
         ON sd.destination_id = d.id AND sd.show_id = ?
       ORDER BY d.display_order`
    ).bind(showId).all<DistributionDestinationRow>();
  const destinations = result.results.map(presentDistributionDestination);
  const channelResult = episodeId
    ? await env.DB
      .prepare(
        `SELECT
           j.destination,
           j.status,
           j.scheduled_at,
           j.started_at,
           j.completed_at,
           j.provider_id,
           j.attempt_count,
           j.last_error,
           j.publication_revision,
           sp.status AS site_status,
           sp.github_commit_sha,
           sp.github_run_id,
           sp.last_error AS site_error
         FROM distribution_jobs j
         LEFT JOIN site_publications sp
           ON j.destination = 'news'
           AND sp.episode_id = j.episode_id
           AND sp.publication_revision = j.publication_revision
         WHERE j.episode_id = ?
           AND j.publication_revision = (
             SELECT MAX(latest.publication_revision)
             FROM distribution_jobs latest
             WHERE latest.episode_id = ?
           )
         ORDER BY CASE j.destination
           WHEN 'rss' THEN 10
           WHEN 'news' THEN 20
           WHEN 'youtube' THEN 30
           WHEN 'email' THEN 40
           ELSE 50
         END`
      )
      .bind(episodeId, episodeId)
      .all<ReleaseChannelRow>()
    : { results: [] as ReleaseChannelRow[] };
  const channels = channelResult.results.map(presentReleaseChannel);
  const publicationRevision = channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.publicationRevision),
    0
  );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    showTitle: show.title,
    episodeId,
    feedUrl:
      `${env.FEED_ORIGIN.replace(/\/$/, "")}/${show.rss_slug}/rss.xml`,
    semantics: "rss-follow-after-one-time-owner-setup",
    summary: {
      total: destinations.length,
      enabled: destinations.filter(({ enabled }) => enabled).length,
      setupComplete: destinations.filter(
        ({ enabled, ownerSetupStatus }) =>
          enabled && ["verified", "not_required"].includes(ownerSetupStatus)
      ).length,
      setupRequired: destinations.filter(
        ({ enabled, ownerSetupStatus }) =>
          enabled && !["verified", "not_required"].includes(ownerSetupStatus)
      ).length,
      observed: destinations.filter(
        ({ publicationStatus }) => publicationStatus === "observed"
      ).length,
      failed: destinations.filter(
        ({ publicationStatus }) => publicationStatus === "failed"
      ).length
    },
    destinations,
    release: episodeId
      ? {
          publicationRevision,
          status: channels.length === 0
            ? "not_published"
            : channels.some(({ status }) => status === "failed")
              ? "needs_attention"
              : channels.every(({ status }) => status === "succeeded")
                ? "complete"
                : "in_progress",
          succeeded: channels.filter(
            ({ status }) => status === "succeeded"
          ).length,
          failed: channels.filter(({ status }) => status === "failed").length,
          channels
        }
      : null
  });
}

export async function updateShowDistributionDestination(
  request: Request,
  env: PodcastEnv,
  showIdValue: string,
  destinationIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const destinationId = validIdentifier(destinationIdValue, "destinationId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...SHOW_EDIT_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request, 20_000);
  const allowedFields = new Set([
    "enabled",
    "ownerSetupStatus",
    "listingUrl"
  ]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new RequestValidationError(
      "Only enabled, ownerSetupStatus, and listingUrl may be updated"
    );
  }
  const current = await env.DB
    .prepare(
      `SELECT
         d.id,
         COALESCE(sd.enabled, d.enabled) AS enabled,
         COALESCE(sd.owner_setup_status, d.owner_setup_status)
           AS owner_setup_status,
         sd.listing_url
       FROM shows s
       JOIN distribution_destinations d ON d.id = ?
       LEFT JOIN show_distribution_destinations sd
         ON sd.show_id = s.id AND sd.destination_id = d.id
       WHERE s.id = ?`
    )
    .bind(destinationId, showId)
    .first<{
      id: string;
      enabled: number;
      owner_setup_status: string;
      listing_url: string | null;
    }>();
  if (!current) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "distribution_destination_not_found" },
      { status: 404 }
    );
  }
  const enabled = "enabled" in body
    ? exactBoolean(body.enabled, "enabled")
    : current.enabled === 1;
  const ownerSetupStatus = "ownerSetupStatus" in body
    ? validOwnerSetupStatus(body.ownerSetupStatus)
    : current.owner_setup_status;
  const listingUrl = "listingUrl" in body
    ? validOptionalHttpsUrl(body.listingUrl, "listingUrl")
    : current.listing_url;
  await env.DB
    .prepare(
      `INSERT INTO show_distribution_destinations (
         show_id,
         destination_id,
         enabled,
         owner_setup_status,
         listing_url,
         owner_verified_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         CASE WHEN ? = 'verified' THEN datetime('now') ELSE NULL END
       )
       ON CONFLICT(show_id, destination_id) DO UPDATE SET
         enabled = excluded.enabled,
         owner_setup_status = excluded.owner_setup_status,
         listing_url = excluded.listing_url,
         owner_verified_at = CASE
           WHEN excluded.owner_setup_status = 'verified'
             THEN COALESCE(
               show_distribution_destinations.owner_verified_at,
               datetime('now')
             )
           ELSE NULL
         END,
         updated_at = datetime('now')`
    )
    .bind(
      showId,
      destinationId,
      enabled ? 1 : 0,
      ownerSetupStatus,
      listingUrl,
      ownerSetupStatus
    )
    .run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "distribution.setup_updated",
    targetType: "show_distribution_destination",
    targetId: `${showId}:${destinationId}`,
    metadata: {
      showId,
      destinationId,
      enabled,
      ownerSetupStatus,
      hasListingUrl: Boolean(listingUrl)
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    showId,
    destinationId,
    enabled,
    ownerSetupStatus,
    listingUrl
  });
}

type DistributionDestinationRow = {
  id: string;
  name: string;
  mode: string;
  enabled: number;
  owner_setup_status: string;
  submission_url: string | null;
  listing_url: string | null;
  owner_verified_at: string | null;
  last_checked_at: string | null;
  setup_error: string | null;
  publication_status: string | null;
  last_observed_at: string | null;
  publication_error: string | null;
  publication_revision: number | null;
};

type ReleaseChannelRow = {
  destination: string;
  status: string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  provider_id: string | null;
  attempt_count: number;
  last_error: string | null;
  publication_revision: number;
  site_status: string | null;
  github_commit_sha: string | null;
  github_run_id: string | null;
  site_error: string | null;
};

function presentDistributionDestination(
  row: DistributionDestinationRow
): {
  id: string;
  name: string;
  mode: string;
  enabled: boolean;
  ownerSetupStatus: string;
  submissionUrl: string | null;
  listingUrl: string | null;
  ownerVerifiedAt: string | null;
  lastCheckedAt: string | null;
  setupError: string | null;
  publicationStatus: string | null;
  publicationRevision: number | null;
  lastObservedAt: string | null;
  publicationError: string | null;
} {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    enabled: row.enabled === 1,
    ownerSetupStatus: row.owner_setup_status,
    submissionUrl: row.submission_url,
    listingUrl: row.listing_url,
    ownerVerifiedAt: row.owner_verified_at,
    lastCheckedAt: row.last_checked_at,
    setupError: row.setup_error,
    publicationStatus: row.publication_status,
    publicationRevision: row.publication_revision,
    lastObservedAt: row.last_observed_at,
    publicationError: row.publication_error
  };
}

function presentReleaseChannel(row: ReleaseChannelRow): {
  id: string;
  name: string;
  status: string;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  publicationRevision: number;
  providerEvidence: string | null;
  error: string | null;
  siteStatus: string | null;
  siteCommitSha: string | null;
  siteRunId: string | null;
} {
  const labels: Record<string, string> = {
    rss: "Canonical RSS",
    news: "Canonical News page",
    youtube: "YouTube",
    email: "Premium notification"
  };
  return {
    id: row.destination,
    name: labels[row.destination] || row.destination,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    attemptCount: Math.max(0, Number(row.attempt_count) || 0),
    publicationRevision: Math.max(0, Number(row.publication_revision) || 0),
    providerEvidence: boundedEvidence(row.provider_id, 200),
    error: boundedEvidence(row.last_error, 500)
      || boundedEvidence(row.site_error, 500),
    siteStatus: row.site_status,
    siteCommitSha: boundedEvidence(row.github_commit_sha, 64),
    siteRunId: boundedEvidence(row.github_run_id, 100)
  };
}

function boundedEvidence(value: unknown, maximum: number): string | null {
  const text = String(value ?? "").trim();
  return text ? Array.from(text).slice(0, maximum).join("") : null;
}

function exactBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${field} must be a boolean`);
  }
  return value;
}

function validOwnerSetupStatus(value: unknown): string {
  const status = requiredText(value, "ownerSetupStatus", 32);
  if (!["not_started", "pending", "verified", "not_required"].includes(status)) {
    throw new RequestValidationError("ownerSetupStatus is invalid");
  }
  return status;
}

function validOptionalHttpsUrl(value: unknown, field: string): string | null {
  const text = optionalText(value, field, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
    ) {
      throw new Error("invalid_https_url");
    }
    return url.toString();
  } catch {
    throw new RequestValidationError(
      `${field} must be an HTTPS URL without credentials or a fragment`
    );
  }
}
