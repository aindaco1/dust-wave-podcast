import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import {
  prepareAdminAuditAfterSingleChange
} from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { isPodcastGuid } from "./podcast-guid";
import {
  displayRssImportUrl,
  requireExactRssImportKeys,
  requireRssImportOwnershipConfirmation,
  validRssImportSha256
} from "./rss-import-contract";
import {
  loadPodcastRssImportPreview,
  validatedImportFeedUrl
} from "./rss-import-preview";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

type ShowIdentityRow = {
  id: string;
  status: string;
  podcast_guid: string | null;
  episode_count: number;
  import_plan_count: number;
};

type IdentityAssignmentRow = {
  show_id: string;
  show_podcast_guid: string;
  podcast_guid: string;
  requested_feed_url_sha256: string;
  requested_feed_display_url: string;
  resolved_feed_url_sha256: string;
  resolved_feed_display_url: string;
  feed_sha256: string;
  assigned_at: string;
};

export async function assignAdminRssImportPodcastGuid(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;

  const body = await readJsonObject(request, 5_000);
  requireExactRssImportKeys(body, [
    "feedUrl",
    "ownershipConfirmed",
    "expectedFeedSha256",
    "expectedPodcastGuid",
    "assignmentConfirmed"
  ], "channel identity assignment");
  requireRssImportOwnershipConfirmation(body.ownershipConfirmed);
  if (body.assignmentConfirmed !== true) {
    throw new RequestValidationError(
      "One-time channel identity assignment must be explicitly confirmed.",
      "rss_import_podcast_guid_assignment_confirmation_required"
    );
  }
  const feedUrl = validatedImportFeedUrl(
    requiredText(body.feedUrl, "feedUrl", 2_000)
  );
  const expectedFeedSha256 = validRssImportSha256(
    body.expectedFeedSha256,
    "expectedFeedSha256"
  );
  const expectedPodcastGuid = requiredText(
    body.expectedPodcastGuid,
    "expectedPodcastGuid",
    36
  );
  if (!isPodcastGuid(expectedPodcastGuid)) {
    throw new RequestValidationError(
      "expectedPodcastGuid must be a lowercase Podcasting 2.0 UUIDv5.",
      "rss_import_expected_podcast_guid_invalid"
    );
  }
  const requestedFeedUrlSha256 = await sha256Hex(feedUrl);
  const existing = await loadIdentityAssignment(env.DB, showId);
  if (existing) {
    if (
      existing.show_podcast_guid !== existing.podcast_guid
      || existing.podcast_guid !== expectedPodcastGuid
      || existing.feed_sha256 !== expectedFeedSha256
      || existing.requested_feed_url_sha256 !== requestedFeedUrlSha256
    ) {
      return identityConflict(
        request,
        env,
        "rss_import_podcast_guid_assignment_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      show: {
        id: existing.show_id,
        podcastGuid: existing.podcast_guid
      },
      assignment: presentIdentityAssignment(existing),
      idempotent: true,
      episodeMutationPerformed: false,
      importMutationPerformed: false,
      publicationMutationPerformed: false
    });
  }

  const show = await loadAssignableShow(env.DB, showId);
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  if (show.podcast_guid !== null) {
    return identityConflict(
      request,
      env,
      "rss_import_show_podcast_guid_already_assigned"
    );
  }
  if (
    show.status !== "coming_soon"
    || Number(show.episode_count) !== 0
    || Number(show.import_plan_count) !== 0
  ) {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_assignment_unavailable"
    );
  }

  const preview = await loadPodcastRssImportPreview(feedUrl);
  if (preview.feedSha256 !== expectedFeedSha256) {
    return identityConflict(request, env, "rss_import_feed_changed");
  }
  if (preview.podcastGuidStatus === "absent") {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_absent"
    );
  }
  if (
    preview.podcastGuidStatus !== "valid"
    || !preview.podcastGuid
  ) {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_invalid"
    );
  }
  if (preview.podcastGuid !== expectedPodcastGuid) {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_changed"
    );
  }

  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE shows
         SET podcast_guid = ?, updated_at = datetime('now')
         WHERE id = ?
           AND status = 'coming_soon'
           AND podcast_guid IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM episodes WHERE show_id = shows.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM rss_import_plans WHERE show_id = shows.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM rss_import_podcast_guid_assignments
             WHERE show_id = shows.id
           )`
      ).bind(preview.podcastGuid, showId),
      env.DB.prepare(
        `INSERT INTO rss_import_podcast_guid_assignments (
           show_id, podcast_guid,
           requested_feed_url_sha256, requested_feed_display_url,
           resolved_feed_url_sha256, resolved_feed_display_url,
           feed_sha256, assigned_by_admin_user_id
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`
      ).bind(
        showId,
        preview.podcastGuid,
        requestedFeedUrlSha256,
        displayRssImportUrl(preview.requestedUrl),
        await sha256Hex(preview.resolvedUrl),
        displayRssImportUrl(preview.resolvedUrl),
        preview.feedSha256,
        auth.authorization.identity.id
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.podcast_guid_assigned",
        targetType: "show",
        targetId: showId,
        metadata: {
          requestedFeedUrlSha256,
          feedSha256: preview.feedSha256,
          podcastGuidSha256: await sha256Hex(
            `rss-import-podcast-guid-v1\0${preview.podcastGuid}`
          ),
          episodeMutationPerformed: false,
          importMutationPerformed: false,
          publicationMutationPerformed: false
        }
      })
    ]);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("UNIQUE constraint failed")
    ) {
      return identityConflict(
        request,
        env,
        "rss_import_podcast_guid_in_use"
      );
    }
    throw error;
  }
  if (
    results.length !== 3
    || results.some((result) => Number(result.meta.changes ?? 0) !== 1)
  ) {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_assignment_conflict"
    );
  }
  const assigned = await loadIdentityAssignment(env.DB, showId);
  if (!assigned) {
    return identityConflict(
      request,
      env,
      "rss_import_podcast_guid_assignment_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    show: {
      id: assigned.show_id,
      podcastGuid: assigned.podcast_guid
    },
    assignment: presentIdentityAssignment(assigned),
    idempotent: false,
    episodeMutationPerformed: false,
    importMutationPerformed: false,
    publicationMutationPerformed: false
  });
}

async function loadAssignableShow(
  db: D1Database,
  showId: string
): Promise<ShowIdentityRow | null> {
  return db.prepare(
    `SELECT
       s.id, s.status, s.podcast_guid,
       (
         SELECT COUNT(*) FROM episodes WHERE show_id = s.id
       ) AS episode_count,
       (
         SELECT COUNT(*) FROM rss_import_plans WHERE show_id = s.id
       ) AS import_plan_count
     FROM shows s
     WHERE s.id = ? AND s.status != 'archived'`
  ).bind(showId).first<ShowIdentityRow>();
}

async function loadIdentityAssignment(
  db: D1Database,
  showId: string
): Promise<IdentityAssignmentRow | null> {
  return db.prepare(
    `SELECT
       assignment.show_id,
       s.podcast_guid AS show_podcast_guid,
       assignment.podcast_guid,
       assignment.requested_feed_url_sha256,
       assignment.requested_feed_display_url,
       assignment.resolved_feed_url_sha256,
       assignment.resolved_feed_display_url,
       assignment.feed_sha256,
       assignment.assigned_at
     FROM rss_import_podcast_guid_assignments assignment
     JOIN shows s ON s.id = assignment.show_id
     WHERE assignment.show_id = ?`
  ).bind(showId).first<IdentityAssignmentRow>();
}

function presentIdentityAssignment(
  assignment: IdentityAssignmentRow
): Record<string, unknown> {
  return {
    podcastGuid: assignment.podcast_guid,
    requestedFeedUrl: assignment.requested_feed_display_url,
    resolvedFeedUrl: assignment.resolved_feed_display_url,
    feedSha256: assignment.feed_sha256,
    assignedAt: assignment.assigned_at
  };
}

function identityConflict(
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
