import { requireAdmin } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import { prepareAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  publicationJobType,
  type PublicationDestination
} from "./jobs";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const READ_ROLES = ["super_admin", "admin", "producer", "analyst"] as const;
const SHOW_EDIT_ROLES = ["super_admin", "admin"] as const;
const PUBLICATION_EDIT_ROLES = ["super_admin", "admin", "producer"] as const;
const PUBLICATION_DESTINATIONS = new Set<PublicationDestination>([
  "rss",
  "news",
  "youtube",
  "email"
]);
const CREDENTIAL_SHAPED_CHECKLIST_VALUE =
  /(?:password|passcode|verification\s+code|otp|contraseña|c[oó]digo\s+de\s+verificaci[oó]n)\s*[:=]\s*\S+/iu;

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
         sd.owner_account_label,
         sd.submission_date,
         sd.submission_evidence_url,
         sd.setup_notes,
         sd.owner_verified_at,
         sd.last_checked_at,
         sd.last_error AS setup_error,
         p.status AS publication_status,
         p.last_observed_at,
         p.last_error AS publication_error,
         p.evidence_url,
         p.evidence_source,
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
         sd.owner_account_label,
         sd.submission_date,
         sd.submission_evidence_url,
         sd.setup_notes,
         sd.owner_verified_at,
         sd.last_checked_at,
         sd.last_error AS setup_error,
         NULL AS publication_status,
         NULL AS last_observed_at,
         NULL AS publication_error,
         NULL AS evidence_url,
         NULL AS evidence_source,
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
         sp.last_error AS site_error,
         yp.id AS youtube_publication_id,
         yp.status AS youtube_publication_status,
         yp.privacy_status AS youtube_privacy_status,
         yp.provider_video_id AS youtube_provider_video_id,
         yp.failure_code AS youtube_failure_code,
         yp.channel_url AS youtube_channel_url,
         yp.title AS youtube_title,
         yp.description AS youtube_description,
         yp.video_object_bytes AS youtube_video_object_bytes,
         yp.requested_at AS youtube_requested_at,
         yp.approved_at AS youtube_approved_at
       FROM distribution_jobs j
         LEFT JOIN site_publications sp
           ON j.destination = 'news'
           AND sp.episode_id = j.episode_id
           AND sp.publication_revision = j.publication_revision
         LEFT JOIN episode_youtube_publications yp
           ON j.destination = 'youtube'
           AND yp.distribution_job_id = j.id
           AND yp.episode_id = j.episode_id
           AND yp.publication_revision = j.publication_revision
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
    "listingUrl",
    "ownerAccountLabel",
    "submissionDate",
    "submissionEvidenceUrl",
    "setupNotes"
  ]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new RequestValidationError(
      "Only enabled, ownerSetupStatus, listingUrl, ownerAccountLabel, "
      + "submissionDate, submissionEvidenceUrl, and setupNotes may be updated"
    );
  }
  const current = await env.DB
    .prepare(
      `SELECT
         d.id,
         COALESCE(sd.enabled, d.enabled) AS enabled,
         COALESCE(sd.owner_setup_status, d.owner_setup_status)
           AS owner_setup_status,
         sd.listing_url,
         sd.owner_account_label,
         sd.submission_date,
         sd.submission_evidence_url,
         sd.setup_notes
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
      owner_account_label: string | null;
      submission_date: string | null;
      submission_evidence_url: string | null;
      setup_notes: string | null;
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
  const ownerAccountLabel = "ownerAccountLabel" in body
    ? validChecklistText(
        body.ownerAccountLabel,
        "ownerAccountLabel",
        120,
        false
      )
    : current.owner_account_label;
  const submissionDate = "submissionDate" in body
    ? validOptionalIsoDate(body.submissionDate, "submissionDate")
    : current.submission_date;
  const submissionEvidenceUrl = "submissionEvidenceUrl" in body
    ? validOptionalHttpsUrl(
        body.submissionEvidenceUrl,
        "submissionEvidenceUrl"
      )
    : current.submission_evidence_url;
  const setupNotes = "setupNotes" in body
    ? validChecklistText(body.setupNotes, "setupNotes", 1_000, true)
    : current.setup_notes;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO show_distribution_destinations (
         show_id,
         destination_id,
         enabled,
         owner_setup_status,
         listing_url,
         owner_account_label,
         submission_date,
         submission_evidence_url,
         setup_notes,
         owner_verified_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN ? = 'verified' THEN datetime('now') ELSE NULL END
       )
       ON CONFLICT(show_id, destination_id) DO UPDATE SET
         enabled = excluded.enabled,
         owner_setup_status = excluded.owner_setup_status,
         listing_url = excluded.listing_url,
         owner_account_label = excluded.owner_account_label,
         submission_date = excluded.submission_date,
         submission_evidence_url = excluded.submission_evidence_url,
         setup_notes = excluded.setup_notes,
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
      ownerAccountLabel,
      submissionDate,
      submissionEvidenceUrl,
      setupNotes,
      ownerSetupStatus
    ),
    env.DB.prepare(
      `UPDATE episode_publications
       SET
         status = CASE
           WHEN ? = 0 THEN 'disabled'
           WHEN ? IN ('verified', 'not_required') THEN 'waiting_for_feed'
           ELSE 'setup_required'
         END,
         updated_at = datetime('now')
       WHERE destination_id = ?
         AND status IN ('setup_required', 'waiting_for_feed', 'disabled')
         AND publication_revision = (
           SELECT e.publication_revision
           FROM episodes e
           WHERE e.id = episode_publications.episode_id
             AND e.show_id = ?
         )`
    ).bind(
      enabled ? 1 : 0,
      ownerSetupStatus,
      destinationId,
      showId
    ),
    prepareAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "distribution.setup_updated",
      targetType: "show_distribution_destination",
      targetId: `${showId}:${destinationId}`,
      metadata: {
        showId,
        destinationId,
        enabled,
        ownerSetupStatus,
        hasListingUrl: Boolean(listingUrl),
        hasOwnerAccountLabel: Boolean(ownerAccountLabel),
        hasSubmissionDate: Boolean(submissionDate),
        hasSubmissionEvidenceUrl: Boolean(submissionEvidenceUrl),
        hasSetupNotes: Boolean(setupNotes)
      }
    })
  ]);
  const reconciledPublications = Math.max(
    0,
    Number(results[1]?.meta?.changes ?? 0)
  );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    showId,
    destinationId,
    enabled,
    ownerSetupStatus,
    listingUrl,
    ownerAccountLabel,
    submissionDate,
    submissionEvidenceUrl,
    setupNotes,
    reconciledPublications
  });
}

export async function retryDistributionJob(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  destinationValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    [...PUBLICATION_EDIT_ROLES],
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const destination = validIdentifier(
    destinationValue,
    "destination"
  ) as PublicationDestination;
  if (!PUBLICATION_DESTINATIONS.has(destination)) {
    throw new RequestValidationError("destination is not retryable");
  }
  const body = await readJsonObject(request, 10_000);
  if (
    Object.keys(body).some((field) => field !== "publicationRevision")
  ) {
    throw new RequestValidationError(
      "Only publicationRevision may be supplied"
    );
  }
  const publicationRevision = Number(body.publicationRevision);
  if (
    !Number.isSafeInteger(publicationRevision)
    || publicationRevision <= 0
  ) {
    throw new RequestValidationError(
      "publicationRevision must be a positive integer"
    );
  }
  const job = await env.DB
    .prepare(
      `SELECT
         j.id,
         j.status,
         j.attempt_count,
         e.publication_revision AS current_publication_revision
       FROM episodes e
       LEFT JOIN distribution_jobs j
         ON j.episode_id = e.id
         AND j.destination = ?
         AND j.publication_revision = ?
       WHERE e.id = ?`
    )
    .bind(destination, publicationRevision, access.episode.id)
    .first<{
      id: string | null;
      status: string | null;
      attempt_count: number | null;
      current_publication_revision: number;
    }>();
  if (
    !job
    || job.current_publication_revision !== publicationRevision
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "stale_publication_revision",
        currentPublicationRevision:
          Math.max(0, Number(job?.current_publication_revision) || 0)
      },
      { status: 409 }
    );
  }
  if (!job.id || !job.status) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "release_job_not_found" },
      { status: 404 }
    );
  }
  if (job.status === "queued" || job.status === "running") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      queued: true,
      idempotent: true,
      episodeId: access.episode.id,
      destination,
      publicationRevision
    });
  }
  if (job.status !== "failed") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "release_job_not_retryable", status: job.status },
      { status: 409 }
    );
  }

  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const statements = [
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, ?, ?, ?, ?
       FROM distribution_jobs
       WHERE id = ?
         AND publication_revision = ?
         AND status = 'failed'`
    ).bind(
      auditId,
      access.authorization.identity.id,
      "distribution.job_retried",
      "distribution_job",
      job.id,
      JSON.stringify({
        episodeId: access.episode.id,
        destination,
        publicationRevision,
        priorAttempts: Math.max(0, Number(job.attempt_count) || 0)
      }),
      job.id,
      publicationRevision
    )
  ];
  if (destination === "news") {
    statements.push(
      env.DB.prepare(
        `UPDATE site_publications
         SET
           status = 'queued',
           github_commit_sha = NULL,
           github_run_id = NULL,
           last_error = NULL,
           updated_at = datetime('now')
         WHERE episode_id = ?
           AND publication_revision = ?
           AND status = 'failed'
           AND EXISTS (
             SELECT 1
             FROM distribution_jobs
             WHERE id = ?
               AND publication_revision = ?
               AND status = 'failed'
           )`
      ).bind(
        access.episode.id,
        publicationRevision,
        job.id,
        publicationRevision
      )
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE distribution_jobs
       SET
         status = 'queued',
         scheduled_at = datetime('now'),
         started_at = NULL,
         completed_at = NULL,
         provider_id = NULL,
         last_error = NULL
       WHERE id = ?
         AND publication_revision = ?
         AND status = 'failed'`
    ).bind(job.id, publicationRevision)
  );
  const results = await env.DB.batch(statements);
  const retryResult = results[results.length - 1];
  if (Number(retryResult?.meta?.changes ?? 0) !== 1) {
    const current = await env.DB
      .prepare(
        `SELECT status
         FROM distribution_jobs
         WHERE id = ? AND publication_revision = ?`
      )
      .bind(job.id, publicationRevision)
      .first<{ status: string }>();
    if (current?.status === "queued" || current?.status === "running") {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        queued: true,
        idempotent: true,
        episodeId: access.episode.id,
        destination,
        publicationRevision
      });
    }
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "release_job_retry_conflict" },
      { status: 409 }
    );
  }

  let delivery: "immediate" | "scheduled" = "immediate";
  try {
    await env.JOBS.send({
      id: job.id,
      type: publicationJobType(destination),
      showId: access.episode.showId,
      episodeId: access.episode.id,
      publicationRevision,
      requestedAt: new Date().toISOString()
    });
  } catch {
    delivery = "scheduled";
    console.error(JSON.stringify({
      level: "error",
      event: "distribution_retry_queue_deferred",
      jobId: job.id,
      destination
    }));
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      queued: true,
      idempotent: false,
      delivery,
      episodeId: access.episode.id,
      destination,
      publicationRevision
    },
    { status: 202 }
  );
}

export async function updateEpisodeDistributionObservation(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  destinationIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    [...PUBLICATION_EDIT_ROLES],
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const destinationId = validIdentifier(
    destinationIdValue,
    "destinationId"
  );
  const body = await readJsonObject(request, 20_000);
  const allowedFields = new Set([
    "publicationRevision",
    "status",
    "evidenceUrl",
    "error"
  ]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new RequestValidationError(
      "Only publicationRevision, status, evidenceUrl, and error may be supplied"
    );
  }
  const publicationRevision = Number(body.publicationRevision);
  if (
    !Number.isSafeInteger(publicationRevision)
    || publicationRevision <= 0
  ) {
    throw new RequestValidationError(
      "publicationRevision must be a positive integer"
    );
  }
  const status = requiredText(body.status, "status", 16);
  if (!["observed", "failed"].includes(status)) {
    throw new RequestValidationError(
      "status must be observed or failed"
    );
  }
  const evidenceUrl = validOptionalHttpsUrl(
    body.evidenceUrl,
    "evidenceUrl"
  );
  const error = optionalText(body.error, "error", 500);
  if (status === "observed" && !evidenceUrl) {
    throw new RequestValidationError(
      "evidenceUrl is required when status is observed"
    );
  }
  if (status === "observed" && error) {
    throw new RequestValidationError(
      "error must be empty when status is observed"
    );
  }
  if (status === "failed" && !error) {
    throw new RequestValidationError(
      "error is required when status is failed"
    );
  }

  const publication = await env.DB
    .prepare(
      `SELECT
         p.id,
         p.status,
         p.last_error,
         p.evidence_url,
         p.evidence_source,
         e.publication_revision AS current_publication_revision,
         d.id AS destination_id,
         COALESCE(sd.enabled, d.enabled) AS enabled,
         COALESCE(sd.owner_setup_status, d.owner_setup_status)
           AS owner_setup_status
       FROM episodes e
       LEFT JOIN distribution_destinations d ON d.id = ?
       LEFT JOIN show_distribution_destinations sd
         ON sd.show_id = e.show_id
         AND sd.destination_id = d.id
       LEFT JOIN episode_publications p
         ON p.episode_id = e.id
         AND p.destination_id = d.id
         AND p.publication_revision = ?
       WHERE e.id = ?`
    )
    .bind(destinationId, publicationRevision, access.episode.id)
    .first<{
      id: string | null;
      status: string | null;
      last_error: string | null;
      evidence_url: string | null;
      evidence_source: string | null;
      current_publication_revision: number;
      destination_id: string | null;
      enabled: number | null;
      owner_setup_status: string | null;
    }>();
  if (
    !publication
    || publication.current_publication_revision !== publicationRevision
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "stale_publication_revision",
        currentPublicationRevision:
          Math.max(
            0,
            Number(publication?.current_publication_revision) || 0
          )
      },
      { status: 409 }
    );
  }
  if (
    !publication.id
    || !publication.destination_id
    || !publication.status
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "directory_publication_not_found" },
      { status: 404 }
    );
  }
  if (
    publication.enabled !== 1
    || !["verified", "not_required"].includes(
      publication.owner_setup_status || ""
    )
    || ["setup_required", "disabled"].includes(publication.status)
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "directory_not_ready_for_observation",
        status: publication.status,
        ownerSetupStatus: publication.owner_setup_status
      },
      { status: 409 }
    );
  }
  const nextError = status === "failed" ? error : null;
  const idempotent = publication.status === status
    && (publication.evidence_url || null) === evidenceUrl
    && (publication.last_error || null) === nextError
    && publication.evidence_source === "manual_review";
  if (idempotent) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      updated: true,
      idempotent: true,
      episodeId: access.episode.id,
      destinationId,
      publicationRevision,
      status,
      evidenceUrl
    });
  }

  const priorStatus = publication.status;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, ?, ?, ?, ?
       FROM episode_publications
       WHERE id = ?
         AND publication_revision = ?
         AND status = ?`
    ).bind(
      auditId,
      access.authorization.identity.id,
      status === "observed"
        ? "distribution.directory_observed"
        : "distribution.directory_failed",
      "episode_publication",
      publication.id,
      JSON.stringify({
        episodeId: access.episode.id,
        destinationId,
        publicationRevision,
        priorStatus,
        status,
        hasEvidenceUrl: Boolean(evidenceUrl),
        hasError: Boolean(nextError)
      }),
      publication.id,
      publicationRevision,
      priorStatus
    ),
    env.DB.prepare(
      `UPDATE episode_publications
       SET
         status = ?,
         evidence_url = ?,
         evidence_source = 'manual_review',
         evidence_admin_user_id = ?,
         last_observed_at = CASE
           WHEN ? = 'observed' THEN datetime('now')
           ELSE last_observed_at
         END,
         last_error = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND publication_revision = ?
         AND status = ?`
    ).bind(
      status,
      evidenceUrl,
      access.authorization.identity.id,
      status,
      nextError,
      publication.id,
      publicationRevision,
      priorStatus
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "directory_observation_conflict" },
      { status: 409 }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    idempotent: false,
    episodeId: access.episode.id,
    destinationId,
    publicationRevision,
    status,
    evidenceUrl
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
  owner_account_label: string | null;
  submission_date: string | null;
  submission_evidence_url: string | null;
  setup_notes: string | null;
  owner_verified_at: string | null;
  last_checked_at: string | null;
  setup_error: string | null;
  publication_status: string | null;
  last_observed_at: string | null;
  publication_error: string | null;
  evidence_url: string | null;
  evidence_source: string | null;
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
  youtube_publication_id: string | null;
  youtube_publication_status: string | null;
  youtube_privacy_status: string | null;
  youtube_provider_video_id: string | null;
  youtube_failure_code: string | null;
  youtube_channel_url: string | null;
  youtube_title: string | null;
  youtube_description: string | null;
  youtube_video_object_bytes: number | null;
  youtube_requested_at: string | null;
  youtube_approved_at: string | null;
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
  ownerAccountLabel: string | null;
  submissionDate: string | null;
  submissionEvidenceUrl: string | null;
  setupNotes: string | null;
  ownerVerifiedAt: string | null;
  lastCheckedAt: string | null;
  setupError: string | null;
  publicationStatus: string | null;
  publicationRevision: number | null;
  lastObservedAt: string | null;
  publicationError: string | null;
  evidenceUrl: string | null;
  evidenceSource: string | null;
} {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    enabled: row.enabled === 1,
    ownerSetupStatus: row.owner_setup_status,
    submissionUrl: row.submission_url,
    listingUrl: row.listing_url,
    ownerAccountLabel: boundedEvidence(row.owner_account_label, 120),
    submissionDate: boundedEvidence(row.submission_date, 10),
    submissionEvidenceUrl: boundedEvidence(
      row.submission_evidence_url,
      2_048
    ),
    setupNotes: boundedEvidence(row.setup_notes, 1_000),
    ownerVerifiedAt: row.owner_verified_at,
    lastCheckedAt: row.last_checked_at,
    setupError: row.setup_error,
    publicationStatus: row.publication_status,
    publicationRevision: row.publication_revision,
    lastObservedAt: row.last_observed_at,
    publicationError: row.publication_error,
    evidenceUrl: boundedEvidence(row.evidence_url, 2_048),
    evidenceSource: boundedEvidence(row.evidence_source, 32)
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
  youtubePublication: {
    id: string;
    status: string;
    privacyStatus: string;
    providerVideoId: string | null;
    failureCode: string | null;
    channelUrl: string;
    title: string;
    description: string;
    videoObjectBytes: number;
    requestedAt: string | null;
    approvedAt: string | null;
  } | null;
  retryable: boolean;
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
    siteRunId: boundedEvidence(row.github_run_id, 100),
    youtubePublication:
      row.destination === "youtube" && row.youtube_publication_id
        ? {
            id: row.youtube_publication_id,
            status: row.youtube_publication_status || "draft",
            privacyStatus: row.youtube_privacy_status || "unlisted",
            providerVideoId: boundedEvidence(
              row.youtube_provider_video_id,
              64
            ),
            failureCode: boundedEvidence(row.youtube_failure_code, 160),
            channelUrl: boundedEvidence(row.youtube_channel_url, 2_000) || "",
            title: boundedEvidence(row.youtube_title, 100) || "",
            description:
              boundedEvidence(row.youtube_description, 5_000) || "",
            videoObjectBytes: Math.max(
              0,
              Number(row.youtube_video_object_bytes) || 0
            ),
            requestedAt: row.youtube_requested_at,
            approvedAt: row.youtube_approved_at
          }
        : null,
    retryable: row.status === "failed" && row.destination !== "youtube"
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

function validChecklistText(
  value: unknown,
  field: string,
  maximumLength: number,
  multiline: boolean
): string | null {
  const text = optionalText(value, field, maximumLength);
  if (!text) return null;
  const invalidControl = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  if (
    invalidControl.test(text)
    || /[\u202A-\u202E\u2066-\u2069]/u.test(text)
  ) {
    throw new RequestValidationError(
      `${field} contains unsupported control characters`
    );
  }
  if (
    CREDENTIAL_SHAPED_CHECKLIST_VALUE.test(text.normalize("NFKC"))
  ) {
    throw new RequestValidationError(
      `${field} must not contain provider credentials or verification codes`
    );
  }
  return text;
}

function validOptionalIsoDate(value: unknown, field: string): string | null {
  const text = optionalText(value, field, 10);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new RequestValidationError(`${field} must be an ISO date`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new RequestValidationError(`${field} must be an ISO date`);
  }
  return text;
}
