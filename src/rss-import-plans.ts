import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import {
  prepareAdminAudit,
  prepareAdminAuditAfterSingleChange
} from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  displayRssImportUrl,
  requireExactRssImportKeys,
  requireRssImportOwnershipConfirmation,
  validRssImportSha256
} from "./rss-import-contract";
import {
  loadPodcastRssImportPreview,
  type RssImportEpisodePreview,
  validatedImportFeedUrl
} from "./rss-import-preview";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const MAXIMUM_PLAN_ITEMS = 25;
type ImportPlanStatus = "draft" | "reviewed" | "canceled";

export type ImportPlanRow = {
  id: string;
  show_id: string;
  requested_feed_url_sha256: string;
  requested_feed_display_url: string;
  resolved_feed_url_sha256: string;
  resolved_feed_display_url: string;
  feed_sha256: string;
  source_podcast_guid: string | null;
  selection_sha256: string;
  feed_title: string;
  feed_item_count: number;
  migratable_item_count: number;
  selected_item_count: number;
  status: ImportPlanStatus;
  cancellation_reason_sha256: string | null;
  requested_at: string;
  reviewed_at: string | null;
  canceled_at: string | null;
  updated_at: string;
};

export type ImportPlanItemRow = {
  plan_id: string;
  source_identity_sha256: string;
  ordinal: number;
  metadata_sha256: string;
  title: string;
  summary: string;
  published_at: string;
  duration_seconds: number | null;
  explicit: number | null;
  canonical_display_url: string | null;
  enclosure_url_sha256: string;
  enclosure_display_url: string;
  enclosure_mime_type: string;
  enclosure_bytes: number;
  warnings_json: string;
};

export type PlanSnapshotItem = {
  sourceIdentitySha256: string;
  ordinal: number;
  metadataSha256: string;
  title: string;
  summary: string;
  publishedAt: string;
  durationSeconds: number | null;
  explicit: boolean | null;
  canonicalDisplayUrl: string | null;
  enclosureUrlSha256: string;
  enclosureDisplayUrl: string;
  enclosureMimeType: string;
  enclosureBytes: number;
  warnings: string[];
};

export async function createAdminRssImportPlan(
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
  const body = await readJsonObject(request, 12_000);
  requireExactRssImportKeys(body, [
    "planId",
    "feedUrl",
    "ownershipConfirmed",
    "expectedFeedSha256",
    "selectedSourceIdentitySha256"
  ], "plan");
  requireRssImportOwnershipConfirmation(body.ownershipConfirmed);
  const planId = validIdentifier(body.planId, "planId");
  const feedUrl = validatedImportFeedUrl(
    requiredText(body.feedUrl, "feedUrl", 2_000)
  );
  const expectedFeedSha256 = validRssImportSha256(
    body.expectedFeedSha256,
    "expectedFeedSha256"
  );
  const selectedSourceIdentities = selectedIdentityList(
    body.selectedSourceIdentitySha256
  );

  const existing = await loadRssImportPlanEvidence(env.DB, planId);
  if (existing) {
    if (
      existing.plan.show_id !== showId
      || existing.plan.feed_sha256 !== expectedFeedSha256
      || existing.plan.requested_feed_url_sha256
        !== await sha256Hex(feedUrl)
      || !sameSelectedIdentities(existing.items, selectedSourceIdentities)
    ) {
      return planConflict(request, env, "rss_import_plan_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      plan: presentPlan(existing.plan, existing.items),
      idempotent: true,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
  }

  const show = await loadActiveShow(env.DB, showId);
  if (!show) return planNotFound(request, env);
  const preview = await loadPodcastRssImportPreview(feedUrl);
  if (preview.feedSha256 !== expectedFeedSha256) {
    return planConflict(request, env, "rss_import_feed_changed");
  }
  assertPodcastGuidCompatibility(show, preview);
  const items = await selectedSnapshotItems(
    preview.episodes,
    selectedSourceIdentities
  );
  const selectionSha256 = await selectionDigest(items);
  const duplicate = await env.DB.prepare(
    `SELECT id
     FROM rss_import_plans
     WHERE show_id = ? AND feed_sha256 = ? AND selection_sha256 = ?
     LIMIT 1`
  ).bind(
    showId,
    preview.feedSha256,
    selectionSha256
  ).first<{ id: string }>();
  if (duplicate) {
    return planConflict(
      request,
      env,
      "rss_import_selection_already_planned"
    );
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO rss_import_plans (
         id, show_id,
         requested_feed_url_sha256, requested_feed_display_url,
         resolved_feed_url_sha256, resolved_feed_display_url,
         feed_sha256, source_podcast_guid, selection_sha256, feed_title,
         feed_item_count, migratable_item_count, selected_item_count,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      planId,
      showId,
      await sha256Hex(preview.requestedUrl),
      displayRssImportUrl(preview.requestedUrl),
      await sha256Hex(preview.resolvedUrl),
      displayRssImportUrl(preview.resolvedUrl),
      preview.feedSha256,
      preview.podcastGuid,
      selectionSha256,
      preview.title,
      preview.itemCount,
      preview.migratableItemCount,
      items.length,
      auth.authorization.identity.id
    ),
    ...items.map((item) =>
      env.DB.prepare(
        `INSERT INTO rss_import_plan_items (
           plan_id, source_identity_sha256, ordinal, metadata_sha256,
           title, summary, published_at, duration_seconds, explicit,
           canonical_display_url, enclosure_url_sha256,
           enclosure_display_url, enclosure_mime_type, enclosure_bytes,
           warnings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        planId,
        item.sourceIdentitySha256,
        item.ordinal,
        item.metadataSha256,
        item.title,
        item.summary,
        item.publishedAt,
        item.durationSeconds,
        item.explicit === null ? null : Number(item.explicit),
        item.canonicalDisplayUrl,
        item.enclosureUrlSha256,
        item.enclosureDisplayUrl,
        item.enclosureMimeType,
        item.enclosureBytes,
        JSON.stringify(item.warnings)
      )
    ),
    prepareAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "rss_import.plan_created",
      targetType: "rss_import_plan",
      targetId: planId,
      metadata: {
        showId,
        feedSha256: preview.feedSha256,
        selectionSha256,
        selectedItemCount: items.length,
        sourcePodcastGuidPresent: preview.podcastGuid !== null
      }
    })
  ];
  await env.DB.batch(statements);
  const created = await loadRssImportPlanEvidence(env.DB, planId);
  if (!created) {
    return planConflict(request, env, "rss_import_plan_conflict");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    plan: presentPlan(created.plan, created.items),
    idempotent: false,
    mediaCopyPerformed: false,
    episodeMutationPerformed: false
  });
}

export async function reviewAdminRssImportPlan(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const planId = validIdentifier(planIdValue, "planId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true
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
    "expectedSelectionSha256",
    "reviewConfirmed"
  ], "plan review");
  requireRssImportOwnershipConfirmation(body.ownershipConfirmed);
  if (body.reviewConfirmed !== true) {
    throw new RequestValidationError(
      "The immutable migration selection must be explicitly confirmed.",
      "rss_import_review_confirmation_required"
    );
  }
  const feedUrl = validatedImportFeedUrl(
    requiredText(body.feedUrl, "feedUrl", 2_000)
  );
  const expectedFeedSha256 = validRssImportSha256(
    body.expectedFeedSha256,
    "expectedFeedSha256"
  );
  const expectedSelectionSha256 = validRssImportSha256(
    body.expectedSelectionSha256,
    "expectedSelectionSha256"
  );
  const existing = await loadRssImportPlanEvidence(env.DB, planId);
  if (!existing) return planNotFound(request, env);
  if (
    existing.plan.feed_sha256 !== expectedFeedSha256
    || existing.plan.selection_sha256 !== expectedSelectionSha256
    || existing.plan.requested_feed_url_sha256
      !== await sha256Hex(feedUrl)
  ) {
    return planConflict(request, env, "rss_import_plan_changed");
  }
  if (existing.plan.status === "canceled") {
    return planConflict(request, env, "rss_import_plan_canceled");
  }
  if (existing.plan.status === "reviewed") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      plan: presentPlan(existing.plan, existing.items),
      idempotent: true,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
  }

  try {
    await reconcileRssImportPlanSource(env.DB, feedUrl, existing);
  } catch (error) {
    if (
      error instanceof RequestValidationError
      && error.code === "rss_import_feed_changed"
    ) {
      return planConflict(request, env, error.code);
    }
    throw error;
  }

  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE rss_import_plans
       SET
         status = 'reviewed',
         reviewed_by_admin_user_id = ?,
         reviewed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status = 'draft'`
    ).bind(auth.authorization.identity.id, planId),
    prepareAdminAuditAfterSingleChange(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "rss_import.plan_reviewed",
      targetType: "rss_import_plan",
      targetId: planId,
      metadata: {
        showId: existing.plan.show_id,
        feedSha256: existing.plan.feed_sha256,
        selectionSha256: existing.plan.selection_sha256,
        selectedItemCount: existing.items.length,
        mediaCopyPerformed: false
      }
    })
  ]);
  if (Number(updated.meta.changes ?? 0) !== 1) {
    return planConflict(request, env, "rss_import_plan_conflict");
  }
  const reviewed = await loadRssImportPlanEvidence(env.DB, planId);
  if (!reviewed) return planConflict(request, env, "rss_import_plan_conflict");
  return privateJson(request, env.ALLOWED_ORIGINS, {
    plan: presentPlan(reviewed.plan, reviewed.items),
    idempotent: false,
    mediaCopyPerformed: false,
    episodeMutationPerformed: false
  });
}

export async function cancelAdminRssImportPlan(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const planId = validIdentifier(planIdValue, "planId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  const body = await readJsonObject(request, 2_000);
  requireExactRssImportKeys(
    body,
    ["expectedSelectionSha256", "reason"],
    "plan cancellation"
  );
  const expectedSelectionSha256 = validRssImportSha256(
    body.expectedSelectionSha256,
    "expectedSelectionSha256"
  );
  const reason = requiredText(body.reason, "reason", 500);
  const reasonSha256 = await sha256Hex(
    `rss-import-cancellation-v1\0${reason}`
  );
  const existing = await loadRssImportPlanEvidence(env.DB, planId);
  if (!existing) return planNotFound(request, env);
  if (existing.plan.selection_sha256 !== expectedSelectionSha256) {
    return planConflict(request, env, "rss_import_plan_changed");
  }
  if (existing.plan.status === "canceled") {
    if (existing.plan.cancellation_reason_sha256 !== reasonSha256) {
      return planConflict(request, env, "rss_import_plan_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      plan: presentPlan(existing.plan, existing.items),
      idempotent: true,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
  }
  const execution = await env.DB.prepare(
    `SELECT id FROM rss_import_executions WHERE plan_id = ? LIMIT 1`
  ).bind(planId).first<{ id: string }>();
  if (execution) {
    return planConflict(request, env, "rss_import_plan_has_execution");
  }
  let updated: D1Result;
  try {
    [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE rss_import_plans
         SET
           status = 'canceled',
           canceled_by_admin_user_id = ?,
           cancellation_reason_sha256 = ?,
           canceled_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status IN ('draft', 'reviewed')`
      ).bind(
        auth.authorization.identity.id,
        reasonSha256,
        planId
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.plan_canceled",
        targetType: "rss_import_plan",
        targetId: planId,
        metadata: {
          showId: existing.plan.show_id,
          selectionSha256: existing.plan.selection_sha256,
          reasonSha256
        }
      })
    ]);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("rss_import_plan_has_execution")
    ) {
      return planConflict(request, env, "rss_import_plan_has_execution");
    }
    throw error;
  }
  if (Number(updated.meta.changes ?? 0) !== 1) {
    return planConflict(request, env, "rss_import_plan_conflict");
  }
  const canceled = await loadRssImportPlanEvidence(env.DB, planId);
  if (!canceled) return planConflict(request, env, "rss_import_plan_conflict");
  return privateJson(request, env.ALLOWED_ORIGINS, {
    plan: presentPlan(canceled.plan, canceled.items),
    idempotent: false,
    mediaCopyPerformed: false,
    episodeMutationPerformed: false
  });
}

export async function listAdminRssImportPlans(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin", "admin", "producer", "analyst"],
    showId
  });
  if (!auth.ok) return auth.response;
  const rows = await env.DB.prepare(
    `SELECT
       plan.id, plan.show_id,
       plan.requested_feed_url_sha256,
       plan.requested_feed_display_url,
       plan.resolved_feed_url_sha256,
       plan.resolved_feed_display_url,
       plan.feed_sha256, plan.source_podcast_guid,
       plan.selection_sha256, plan.feed_title,
       plan.feed_item_count, plan.migratable_item_count,
       plan.selected_item_count, plan.status,
       plan.cancellation_reason_sha256,
       plan.requested_at, plan.reviewed_at, plan.canceled_at,
       plan.updated_at,
       item.plan_id, item.source_identity_sha256, item.ordinal,
       item.metadata_sha256, item.title, item.summary, item.published_at,
       item.duration_seconds, item.explicit, item.canonical_display_url,
       item.enclosure_url_sha256, item.enclosure_display_url,
       item.enclosure_mime_type, item.enclosure_bytes, item.warnings_json
     FROM (
       SELECT *
       FROM rss_import_plans
       WHERE show_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 10
     ) plan
     JOIN rss_import_plan_items item ON item.plan_id = plan.id
     ORDER BY plan.updated_at DESC, plan.id DESC, item.ordinal`
  ).bind(showId).all<ImportPlanRow & ImportPlanItemRow>();
  const grouped = new Map<
    string,
    { plan: ImportPlanRow; items: ImportPlanItemRow[] }
  >();
  for (const row of rows.results) {
    const entry = grouped.get(row.id) ?? {
      plan: row,
      items: []
    };
    entry.items.push(row);
    grouped.set(row.id, entry);
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    plans: [...grouped.values()].map(({ plan, items }) =>
      presentPlan(plan, items)
    ),
    limit: 10,
    mediaCopyPerformed: false,
    episodeMutationPerformed: false
  });
}

async function selectedSnapshotItems(
  episodes: RssImportEpisodePreview[],
  identities: string[]
): Promise<PlanSnapshotItem[]> {
  const selected = new Set(identities);
  const items: PlanSnapshotItem[] = [];
  for (const [ordinal, episode] of episodes.entries()) {
    if (!selected.has(episode.sourceIdentitySha256)) continue;
    if (
      !episode.migrationReady
      || !episode.title
      || !episode.publishedAt
      || !episode.enclosure.url
      || !episode.enclosure.mimeType
      || !episode.enclosure.bytes
    ) {
      throw new RequestValidationError(
        "Every selected item must be migration-ready.",
        "rss_import_selection_not_ready",
        409
      );
    }
    const snapshot = {
      sourceIdentitySha256: episode.sourceIdentitySha256,
      ordinal,
      title: episode.title,
      summary: episode.summary,
      publishedAt: episode.publishedAt,
      durationSeconds: episode.durationSeconds,
      explicit: episode.explicit,
      canonicalDisplayUrl: episode.canonicalUrl
        ? displayRssImportUrl(episode.canonicalUrl)
        : null,
      enclosureUrlSha256: await sha256Hex(episode.enclosure.url),
      enclosureDisplayUrl: displayRssImportUrl(episode.enclosure.url),
      enclosureMimeType: episode.enclosure.mimeType,
      enclosureBytes: episode.enclosure.bytes,
      warnings: [...episode.warnings]
    };
    items.push({
      ...snapshot,
      metadataSha256: await sha256Hex(JSON.stringify(snapshot))
    });
  }
  if (items.length !== identities.length) {
    throw new RequestValidationError(
      "A selected source identity is not present in the bounded preview.",
      "rss_import_selection_changed",
      409
    );
  }
  return items;
}

async function selectionDigest(items: PlanSnapshotItem[]): Promise<string> {
  return sha256Hex(JSON.stringify(items.map((item) => ({
    sourceIdentitySha256: item.sourceIdentitySha256,
    metadataSha256: item.metadataSha256
  }))));
}

function presentPlan(
  plan: ImportPlanRow,
  items: ImportPlanItemRow[]
): Record<string, unknown> {
  return {
    id: plan.id,
    showId: plan.show_id,
    status: plan.status,
    requestedFeedUrl: plan.requested_feed_display_url,
    resolvedFeedUrl: plan.resolved_feed_display_url,
    feedSha256: plan.feed_sha256,
    sourcePodcastGuid: plan.source_podcast_guid,
    selectionSha256: plan.selection_sha256,
    feedTitle: plan.feed_title,
    feedItemCount: plan.feed_item_count,
    migratableItemCount: plan.migratable_item_count,
    selectedItemCount: plan.selected_item_count,
    items: items.map((item) => ({
      sourceIdentitySha256: item.source_identity_sha256,
      ordinal: item.ordinal,
      metadataSha256: item.metadata_sha256,
      title: item.title,
      summary: item.summary,
      publishedAt: item.published_at,
      durationSeconds: item.duration_seconds,
      explicit: item.explicit === null ? null : Boolean(item.explicit),
      canonicalUrl: item.canonical_display_url,
      enclosure: {
        url: item.enclosure_display_url,
        mimeType: item.enclosure_mime_type,
        bytes: item.enclosure_bytes
      },
      warnings: safeWarnings(item.warnings_json)
    })),
    requestedAt: plan.requested_at,
    reviewedAt: plan.reviewed_at,
    canceledAt: plan.canceled_at,
    updatedAt: plan.updated_at
  };
}

export async function loadRssImportPlanEvidence(
  db: D1Database,
  planId: string
): Promise<{
  plan: ImportPlanRow;
  items: ImportPlanItemRow[];
} | null> {
  const plan = await db.prepare(
    `SELECT
       id, show_id,
       requested_feed_url_sha256, requested_feed_display_url,
       resolved_feed_url_sha256, resolved_feed_display_url,
       feed_sha256, source_podcast_guid, selection_sha256, feed_title,
       feed_item_count, migratable_item_count, selected_item_count,
       status, cancellation_reason_sha256,
       requested_at, reviewed_at, canceled_at, updated_at
     FROM rss_import_plans
     WHERE id = ?`
  ).bind(planId).first<ImportPlanRow>();
  if (!plan) return null;
  const items = await db.prepare(
    `SELECT
       plan_id, source_identity_sha256, ordinal, metadata_sha256,
       title, summary, published_at, duration_seconds, explicit,
       canonical_display_url, enclosure_url_sha256,
       enclosure_display_url, enclosure_mime_type, enclosure_bytes,
       warnings_json
     FROM rss_import_plan_items
     WHERE plan_id = ?
     ORDER BY ordinal`
  ).bind(planId).all<ImportPlanItemRow>();
  return { plan, items: items.results };
}

export async function reconcileRssImportPlanSource(
  db: D1Database,
  feedUrl: string,
  evidence: {
    plan: ImportPlanRow;
    items: ImportPlanItemRow[];
  }
): Promise<{
  preview: Awaited<ReturnType<typeof loadPodcastRssImportPreview>>;
  items: PlanSnapshotItem[];
}> {
  const preview = await loadPodcastRssImportPreview(feedUrl);
  const show = await loadActiveShow(db, evidence.plan.show_id);
  if (!show) {
    throw new RequestValidationError(
      "The target show is unavailable.",
      "rss_import_show_unavailable",
      409
    );
  }
  assertPodcastGuidCompatibility(show, preview);
  const items = await selectedSnapshotItems(
    preview.episodes,
    evidence.items.map(({ source_identity_sha256 }) =>
      source_identity_sha256
    )
  );
  if (
    preview.feedSha256 !== evidence.plan.feed_sha256
    || preview.podcastGuid !== evidence.plan.source_podcast_guid
    || await sha256Hex(preview.resolvedUrl)
      !== evidence.plan.resolved_feed_url_sha256
    || await selectionDigest(items)
      !== evidence.plan.selection_sha256
    || !sameMetadata(evidence.items, items)
  ) {
    throw new RequestValidationError(
      "The source feed changed after the migration plan was prepared.",
      "rss_import_feed_changed",
      409
    );
  }
  return { preview, items };
}

async function loadActiveShow(
  db: D1Database,
  showId: string
): Promise<{ id: string; podcast_guid: string | null } | null> {
  return db.prepare(
    `SELECT id, podcast_guid
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<{ id: string; podcast_guid: string | null }>();
}

function assertPodcastGuidCompatibility(
  show: { podcast_guid: string | null },
  preview: {
    podcastGuid: string | null;
    podcastGuidStatus: "absent" | "valid" | "invalid";
  }
): void {
  if (preview.podcastGuidStatus === "invalid") {
    throw new RequestValidationError(
      "The source feed has invalid Podcasting 2.0 channel identity.",
      "rss_import_podcast_guid_invalid",
      409
    );
  }
  if (preview.podcastGuidStatus === "absent") return;
  if (!show.podcast_guid) {
    throw new RequestValidationError(
      "Assign the source channel GUID to the show before planning migration.",
      "rss_import_show_podcast_guid_unassigned",
      409
    );
  }
  if (show.podcast_guid !== preview.podcastGuid) {
    throw new RequestValidationError(
      "The source feed and target show have different channel identities.",
      "rss_import_podcast_guid_mismatch",
      409
    );
  }
}

function selectedIdentityList(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAXIMUM_PLAN_ITEMS
  ) {
    throw new RequestValidationError(
      `selectedSourceIdentitySha256 must contain 1-${MAXIMUM_PLAN_ITEMS} items`
    );
  }
  const identities = value.map((candidate) =>
    validRssImportSha256(candidate, "selectedSourceIdentitySha256")
  );
  if (new Set(identities).size !== identities.length) {
    throw new RequestValidationError(
      "selectedSourceIdentitySha256 contains a duplicate"
    );
  }
  return identities;
}

function sameSelectedIdentities(
  items: ImportPlanItemRow[],
  expected: string[]
): boolean {
  const actual = items
    .map(({ source_identity_sha256 }) => source_identity_sha256)
    .sort();
  const expectedSorted = [...expected].sort();
  return actual.length === expected.length
    && actual.every((value, index) =>
      value === expectedSorted[index]
    );
}

function sameMetadata(
  stored: ImportPlanItemRow[],
  current: PlanSnapshotItem[]
): boolean {
  if (stored.length !== current.length) return false;
  const digests = new Map(current.map((item) => [
    item.sourceIdentitySha256,
    item.metadataSha256
  ]));
  return stored.every((item) =>
    digests.get(item.source_identity_sha256) === item.metadata_sha256
  );
}

function safeWarnings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((warning): warning is string =>
        typeof warning === "string"
      ).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function planNotFound(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rss_import_plan_not_found" },
    { status: 404 }
  );
}

function planConflict(
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
