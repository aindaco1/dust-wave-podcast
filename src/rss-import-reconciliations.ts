import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import {
  loadDistributionLaunchCertification
} from "./distribution-certification";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  loadRssImportExecutionEvidence,
  rssImportExecutionEnabled,
  type RssImportExecutionItemRow,
  type RssImportExecutionRow
} from "./rss-import-executions";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const RECONCILIATION_SCHEMA =
  "dustwave-rss-import-reconciliation-v1";
const R2_HEAD_CONCURRENCY = 5;

type ReconciliationRow = {
  id: string;
  execution_id: string;
  plan_id: string;
  show_id: string;
  evidence_sha256: string;
  item_count: number;
  copied_bytes: number;
  approved_by_admin_user_id: string | null;
  approved_at: string;
  created_at: string;
};

type ShowRow = {
  id: string;
  slug: string;
  rss_slug: string;
};

type ReconciliationItemStateRow = RssImportExecutionItemRow & {
  metadata_sha256: string;
  episode_show_id: string | null;
  episode_slug: string | null;
  episode_guid: string | null;
  episode_source_audio_key: string | null;
  episode_audio_key: string | null;
  episode_status: string | null;
  episode_media_status: string | null;
  episode_publication_revision: number | null;
  episode_source_language: string | null;
  episode_canonical_url: string | null;
  episode_updated_at: string | null;
  upload_id: string | null;
  upload_object_key: string | null;
  upload_content_type: string | null;
  upload_expected_bytes: number | null;
  upload_status: string | null;
  upload_completed_bytes: number | null;
  upload_object_etag: string | null;
  root_job_count: number;
  site_publication_count: number;
  directory_publication_count: number;
};

type ReconciliationContext = {
  execution: RssImportExecutionRow;
  items: ReconciliationItemStateRow[];
  reconciliation: ReconciliationRow | null;
  show: ShowRow;
};

type ItemSnapshot = {
  sourceIdentitySha256: string;
  targetEpisodeId: string;
  targetSlug: string;
  copiedBytes: number | null;
  copiedSha256: string | null;
  copiedMimeType: string | null;
  copyReady: boolean;
  privateObjectVerified: boolean;
  draftIdentityVerified: boolean;
  sourceUploadVerified: boolean;
  copyBlockers: string[];
  prePublicationBlockers: string[];
  evidence: Record<string, unknown>;
};

type ReconciliationSnapshot = {
  evidenceSha256: string;
  itemCount: number;
  copiedBytes: number;
  copyReady: boolean;
  prePublicationReady: boolean;
  blockers: string[];
  items: ItemSnapshot[];
};

export async function getAdminRssImportReconciliation(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  if (!rssImportExecutionEnabled(env)) {
    return reconciliationUnavailable(request, env);
  }
  const planId = validIdentifier(planIdValue, "planId");
  const execution = await loadRssImportExecutionEvidence(env.DB, planId);
  if (!execution) return reconciliationNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin", "admin", "producer", "analyst"],
    showId: execution.execution.show_id
  });
  if (!auth.ok) return auth.response;
  const context = await loadReconciliationContext(
    env.DB,
    execution.execution,
    execution.items
  );
  if (!context) return reconciliationNotFound(request, env);
  const snapshot = await buildReconciliationSnapshot(env, context);
  return reconciliationResponse(request, env, context, snapshot, {
    idempotent: null
  });
}

export async function createAdminRssImportReconciliation(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  if (!rssImportExecutionEnabled(env)) {
    return reconciliationUnavailable(request, env);
  }
  const planId = validIdentifier(planIdValue, "planId");
  const execution = await loadRssImportExecutionEvidence(env.DB, planId);
  if (!execution) return reconciliationNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId: execution.execution.show_id
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  const body = await readJsonObject(request, 4_000);
  requireExactKeys(body, [
    "reconciliationId",
    "expectedEvidenceSha256",
    "reconciliationConfirmed"
  ]);
  if (body.reconciliationConfirmed !== true) {
    throw new RequestValidationError(
      "The exact private-copy reconciliation must be confirmed.",
      "rss_import_reconciliation_confirmation_required"
    );
  }
  const reconciliationId = validIdentifier(
    body.reconciliationId,
    "reconciliationId"
  );
  const expectedEvidenceSha256 = validSha256(
    body.expectedEvidenceSha256,
    "expectedEvidenceSha256"
  );
  const context = await loadReconciliationContext(
    env.DB,
    execution.execution,
    execution.items
  );
  if (!context) return reconciliationNotFound(request, env);
  const snapshot = await buildReconciliationSnapshot(env, context);
  if (snapshot.evidenceSha256 !== expectedEvidenceSha256) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_reconciliation_changed"
    );
  }
  if (context.reconciliation) {
    if (
      context.reconciliation.id !== reconciliationId
      || context.reconciliation.evidence_sha256
        !== expectedEvidenceSha256
    ) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_reconciliation_conflict"
      );
    }
    return reconciliationResponse(request, env, context, snapshot, {
      idempotent: true
    });
  }
  if (!snapshot.copyReady || !snapshot.prePublicationReady) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_reconciliation_not_ready"
    );
  }

  let inserted: D1Result;
  try {
    [inserted] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rss_import_reconciliations (
           id, execution_id, plan_id, show_id, evidence_sha256,
           item_count, copied_bytes, approved_by_admin_user_id
         )
         SELECT ?, execution.id, execution.plan_id, execution.show_id,
           ?, ?, ?, ?
         FROM rss_import_executions execution
         WHERE execution.plan_id = ?
           AND execution.status = 'succeeded'
           AND execution.expected_item_count = ?
           AND execution.copied_item_count = execution.expected_item_count
           AND execution.draft_item_count = execution.expected_item_count
           AND execution.failed_item_count = 0
           AND (
             SELECT COUNT(*)
             FROM rss_import_execution_items item
             WHERE item.execution_id = execution.id
           ) = execution.expected_item_count
           AND NOT EXISTS (
             SELECT 1
             FROM rss_import_execution_items item
             LEFT JOIN episodes episode
               ON episode.id = item.target_episode_id
             LEFT JOIN shows show_record
               ON show_record.id = execution.show_id
             LEFT JOIN media_uploads upload
               ON upload.episode_id = item.target_episode_id
              AND upload.kind = 'source_audio'
              AND upload.object_key = item.target_object_key
             WHERE item.execution_id = execution.id
               AND (
                 item.status != 'succeeded'
                 OR item.copied_bytes IS NULL
                 OR item.copied_sha256 IS NULL
                 OR item.copied_etag IS NULL
                 OR item.copied_mime_type IS NULL
                 OR item.episode_id IS NOT item.target_episode_id
                 OR episode.id IS NULL
                 OR episode.show_id IS NOT execution.show_id
                 OR episode.slug IS NOT item.target_slug
                 OR episode.guid IS NOT (
                   'urn:dustwave:rss-import:'
                   || item.source_identity_sha256
                 )
                 OR episode.source_audio_key IS NOT item.target_object_key
                 OR episode.source_language IS NOT item.source_language
                 OR episode.canonical_url IS NOT (
                   ? || '/news/podcasts/' || show_record.slug || '/'
                   || item.target_slug || '/'
                 )
                 OR episode.status != 'draft'
                 OR episode.audio_key IS NOT NULL
                 OR episode.publication_revision != 0
                 OR upload.id IS NULL
                 OR upload.status != 'completed'
                 OR upload.expected_bytes IS NOT item.copied_bytes
                 OR upload.completed_bytes IS NOT item.copied_bytes
                 OR upload.content_type IS NOT item.copied_mime_type
                 OR upload.object_etag IS NOT item.copied_etag
                 OR EXISTS (
                   SELECT 1 FROM distribution_jobs job
                   WHERE job.episode_id = item.target_episode_id
                 )
                 OR EXISTS (
                   SELECT 1 FROM site_publications publication
                   WHERE publication.episode_id = item.target_episode_id
                 )
                 OR EXISTS (
                   SELECT 1 FROM episode_publications publication
                   WHERE publication.episode_id = item.target_episode_id
                 )
               )
           )`
      ).bind(
        reconciliationId,
        snapshot.evidenceSha256,
        snapshot.itemCount,
        snapshot.copiedBytes,
        auth.authorization.identity.id,
        planId,
        snapshot.itemCount,
        env.SITE_ORIGIN.replace(/\/$/u, "")
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.reconciliation_approved",
        targetType: "rss_import_reconciliation",
        targetId: reconciliationId,
        metadata: {
          executionId: context.execution.id,
          planId,
          showId: context.execution.show_id,
          evidenceSha256: snapshot.evidenceSha256,
          itemCount: snapshot.itemCount,
          copiedBytes: snapshot.copiedBytes,
          publicationMutationPerformed: false,
          redirectMutationPerformed: false
        }
      })
    ]);
  } catch (error) {
    const raced = await loadReconciliation(
      env.DB,
      context.execution.id
    );
    if (
      raced?.id === reconciliationId
      && raced.evidence_sha256 === snapshot.evidenceSha256
    ) {
      const racedContext = { ...context, reconciliation: raced };
      return reconciliationResponse(
        request,
        env,
        racedContext,
        snapshot,
        { idempotent: true }
      );
    }
    if (raced) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_reconciliation_conflict"
      );
    }
    throw error;
  }
  if (Number(inserted.meta.changes ?? 0) !== 1) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_reconciliation_not_ready"
    );
  }
  const approved = await loadReconciliation(
    env.DB,
    context.execution.id
  );
  if (!approved) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_reconciliation_conflict"
    );
  }
  return reconciliationResponse(
    request,
    env,
    { ...context, reconciliation: approved },
    snapshot,
    { idempotent: false, status: 201 }
  );
}

async function loadReconciliationContext(
  db: D1Database,
  execution: RssImportExecutionRow,
  executionItems: RssImportExecutionItemRow[]
): Promise<ReconciliationContext | null> {
  const [show, reconciliation, itemResult] = await Promise.all([
    db.prepare(
      "SELECT id, slug, rss_slug FROM shows WHERE id = ?"
    ).bind(execution.show_id).first<ShowRow>(),
    loadReconciliation(db, execution.id),
    db.prepare(
      `SELECT
         item.execution_id, item.plan_id, item.source_identity_sha256,
         item.ordinal, item.target_episode_id, item.target_slug,
         item.source_language, item.target_object_key, item.status,
         item.attempt_count, item.queue_sent_at, item.started_at,
         item.completed_at, item.response_resolved_url_sha256,
         item.copied_bytes, item.copied_sha256, item.copied_etag,
         item.copied_mime_type, item.episode_id, item.last_error_code,
         plan_item.metadata_sha256,
         episode.show_id AS episode_show_id,
         episode.slug AS episode_slug,
         episode.guid AS episode_guid,
         episode.source_audio_key AS episode_source_audio_key,
         episode.audio_key AS episode_audio_key,
         episode.status AS episode_status,
         episode.media_status AS episode_media_status,
         episode.publication_revision AS episode_publication_revision,
         episode.source_language AS episode_source_language,
         episode.canonical_url AS episode_canonical_url,
         episode.updated_at AS episode_updated_at,
         upload.id AS upload_id,
         upload.object_key AS upload_object_key,
         upload.content_type AS upload_content_type,
         upload.expected_bytes AS upload_expected_bytes,
         upload.status AS upload_status,
         upload.completed_bytes AS upload_completed_bytes,
         upload.object_etag AS upload_object_etag,
         (
           SELECT COUNT(*) FROM distribution_jobs job
           WHERE job.episode_id = item.target_episode_id
         ) AS root_job_count,
         (
           SELECT COUNT(*) FROM site_publications publication
           WHERE publication.episode_id = item.target_episode_id
         ) AS site_publication_count,
         (
           SELECT COUNT(*) FROM episode_publications publication
           WHERE publication.episode_id = item.target_episode_id
         ) AS directory_publication_count
       FROM rss_import_execution_items item
       JOIN rss_import_plan_items plan_item
         ON plan_item.plan_id = item.plan_id
        AND plan_item.source_identity_sha256 =
          item.source_identity_sha256
       LEFT JOIN episodes episode
         ON episode.id = item.target_episode_id
       LEFT JOIN media_uploads upload
         ON upload.episode_id = item.target_episode_id
        AND upload.kind = 'source_audio'
        AND upload.object_key = item.target_object_key
       WHERE item.execution_id = ?
       ORDER BY item.ordinal`
    ).bind(execution.id).all<ReconciliationItemStateRow>()
  ]);
  if (
    !show
    || itemResult.results.length !== executionItems.length
  ) {
    return null;
  }
  return {
    execution,
    items: itemResult.results,
    reconciliation,
    show
  };
}

async function buildReconciliationSnapshot(
  env: PodcastEnv,
  context: ReconciliationContext
): Promise<ReconciliationSnapshot> {
  const objects = await mapWithConcurrency(
    context.items,
    R2_HEAD_CONCURRENCY,
    async (item) => {
      try {
        return await env.MEDIA_BUCKET.head(item.target_object_key);
      } catch {
        return null;
      }
    }
  );
  const canonicalOrigin = env.SITE_ORIGIN.replace(/\/$/u, "");
  const snapshots = context.items.map((item, index) =>
    itemSnapshot(
      item,
      objects[index],
      context.execution,
      context.show,
      canonicalOrigin
    )
  );
  const blockers = unique([
    ...(context.execution.status === "succeeded"
      && context.execution.copied_item_count
        === context.execution.expected_item_count
      && context.execution.draft_item_count
        === context.execution.expected_item_count
      && context.execution.failed_item_count === 0
      ? []
      : ["rss_import_execution_not_succeeded"]),
    ...snapshots.flatMap(({ copyBlockers }) => copyBlockers)
  ]);
  const prePublicationBlockers = unique(
    snapshots.flatMap(({ prePublicationBlockers }) =>
      prePublicationBlockers
    )
  );
  const copiedBytes = snapshots.reduce(
    (total, item) => total + Number(item.copiedBytes ?? 0),
    0
  );
  const evidence = {
    schemaVersion: RECONCILIATION_SCHEMA,
    executionId: context.execution.id,
    planId: context.execution.plan_id,
    showId: context.execution.show_id,
    feedSha256: context.execution.feed_sha256,
    selectionSha256: context.execution.selection_sha256,
    itemCount: snapshots.length,
    copiedBytes,
    items: snapshots.map(({ evidence: itemEvidence }) => itemEvidence)
  };
  return {
    evidenceSha256: await sha256Hex(JSON.stringify(evidence)),
    itemCount: snapshots.length,
    copiedBytes,
    copyReady: blockers.length === 0,
    prePublicationReady:
      blockers.length === 0 && prePublicationBlockers.length === 0,
    blockers: unique([...blockers, ...prePublicationBlockers]),
    items: snapshots
  };
}

function itemSnapshot(
  item: ReconciliationItemStateRow,
  object: R2Object | null,
  execution: RssImportExecutionRow,
  show: ShowRow,
  canonicalOrigin: string
): ItemSnapshot {
  const copyEvidenceComplete = item.status === "succeeded"
    && item.episode_id === item.target_episode_id
    && Boolean(
      item.response_resolved_url_sha256
      && item.copied_bytes
      && item.copied_sha256
      && item.copied_etag
      && item.copied_mime_type
    );
  const expectedCanonicalUrl =
    `${canonicalOrigin}/news/podcasts/${show.slug}/${item.target_slug}/`;
  const draftIdentityVerified = Boolean(
    item.episode_id === item.target_episode_id
    && item.episode_show_id === execution.show_id
    && item.episode_slug === item.target_slug
    && item.episode_guid
      === `urn:dustwave:rss-import:${item.source_identity_sha256}`
    && item.episode_source_audio_key === item.target_object_key
    && item.episode_source_language === item.source_language
    && item.episode_canonical_url === expectedCanonicalUrl
  );
  const sourceUploadVerified = Boolean(
    item.upload_id
    && item.upload_object_key === item.target_object_key
    && item.upload_status === "completed"
    && item.upload_expected_bytes === item.copied_bytes
    && item.upload_completed_bytes === item.copied_bytes
    && item.upload_content_type === item.copied_mime_type
    && item.upload_object_etag === item.copied_etag
  );
  const privateObjectVerified = Boolean(
    object
    && object.size === item.copied_bytes
    && object.httpEtag === item.copied_etag
    && object.httpMetadata?.contentType === item.copied_mime_type
    && object.customMetadata?.kind === "rss_import_source_audio"
    && object.customMetadata?.executionId === execution.id
    && object.customMetadata?.planId === execution.plan_id
    && object.customMetadata?.episodeId === item.target_episode_id
    && object.customMetadata?.sourceIdentitySha256
      === item.source_identity_sha256
  );
  const copyBlockers = unique([
    ...(item.status === "succeeded"
      ? []
      : ["rss_import_execution_item_not_succeeded"]),
    ...(copyEvidenceComplete
      ? []
      : ["rss_import_copy_evidence_incomplete"]),
    ...(draftIdentityVerified
      ? []
      : ["rss_import_draft_identity_mismatch"]),
    ...(sourceUploadVerified
      ? []
      : ["rss_import_source_upload_mismatch"]),
    ...(!object
      ? ["rss_import_private_object_missing"]
      : privateObjectVerified
        ? []
        : ["rss_import_private_object_mismatch"])
  ]);
  const publicationWorkCount = Number(item.root_job_count)
    + Number(item.site_publication_count)
    + Number(item.directory_publication_count);
  const prePublicationBlockers = unique([
    ...(item.episode_status === "draft"
      && item.episode_audio_key === null
      && item.episode_publication_revision === 0
      ? []
      : ["rss_import_publication_state_changed"]),
    ...(publicationWorkCount === 0
      ? []
      : ["rss_import_publication_work_exists"])
  ]);
  return {
    sourceIdentitySha256: item.source_identity_sha256,
    targetEpisodeId: item.target_episode_id,
    targetSlug: item.target_slug,
    copiedBytes: item.copied_bytes,
    copiedSha256: item.copied_sha256,
    copiedMimeType: item.copied_mime_type,
    copyReady: copyBlockers.length === 0,
    privateObjectVerified,
    draftIdentityVerified,
    sourceUploadVerified,
    copyBlockers,
    prePublicationBlockers,
    evidence: {
      sourceIdentitySha256: item.source_identity_sha256,
      sourceMetadataSha256: item.metadata_sha256,
      targetEpisodeId: item.target_episode_id,
      targetSlug: item.target_slug,
      sourceLanguage: item.source_language,
      targetObjectKey: item.target_object_key,
      responseResolvedUrlSha256: item.response_resolved_url_sha256,
      copiedBytes: item.copied_bytes,
      copiedSha256: item.copied_sha256,
      copiedEtag: item.copied_etag,
      copiedMimeType: item.copied_mime_type,
      episode: {
        id: item.episode_id,
        showId: item.episode_show_id,
        slug: item.episode_slug,
        guid: item.episode_guid,
        sourceAudioKey: item.episode_source_audio_key,
        sourceLanguage: item.episode_source_language,
        canonicalUrl: item.episode_canonical_url
      },
      upload: {
        id: item.upload_id,
        objectKey: item.upload_object_key,
        contentType: item.upload_content_type,
        expectedBytes: item.upload_expected_bytes,
        completedBytes: item.upload_completed_bytes,
        objectEtag: item.upload_object_etag
      },
      object: object
        ? {
            key: object.key,
            size: object.size,
            httpEtag: object.httpEtag,
            contentType: object.httpMetadata?.contentType ?? null,
            customMetadata: {
              kind: object.customMetadata?.kind ?? null,
              executionId:
                object.customMetadata?.executionId ?? null,
              planId: object.customMetadata?.planId ?? null,
              episodeId: object.customMetadata?.episodeId ?? null,
              sourceIdentitySha256:
                object.customMetadata?.sourceIdentitySha256 ?? null
            }
          }
        : null
    }
  };
}

async function loadReconciliation(
  db: D1Database,
  executionId: string
): Promise<ReconciliationRow | null> {
  return db.prepare(
    `SELECT
       id, execution_id, plan_id, show_id, evidence_sha256,
       item_count, copied_bytes, approved_by_admin_user_id,
       approved_at, created_at
     FROM rss_import_reconciliations
     WHERE execution_id = ?`
  ).bind(executionId).first<ReconciliationRow>();
}

async function reconciliationResponse(
  request: Request,
  env: PodcastEnv,
  context: ReconciliationContext,
  snapshot: ReconciliationSnapshot,
  options: { idempotent: boolean | null; status?: number }
): Promise<Response> {
  const certification = await loadDistributionLaunchCertification(
    env.DB,
    context.execution.show_id
  );
  const approvalFresh = Boolean(
    context.reconciliation
    && context.reconciliation.evidence_sha256
      === snapshot.evidenceSha256
    && snapshot.copyReady
  );
  const importedEpisodesPublic = context.items.every((item) =>
    item.episode_status === "published"
    && item.episode_media_status === "ready"
    && Boolean(item.episode_audio_key)
    && Number(item.episode_publication_revision) > 0
  );
  const latestEpisodeUpdate = context.items.reduce(
    (latest, item) => Math.max(
      latest,
      timestamp(item.episode_updated_at)
    ),
    0
  );
  const feedValidatedAfterImport = Boolean(
    certification.feedValidation.status === "valid"
    && timestamp(certification.feedValidation.validatedAt)
      >= latestEpisodeUpdate
  );
  const redirectBlockers = unique([
    ...(approvalFresh
      ? []
      : ["rss_import_owner_reconciliation_required"]),
    ...(importedEpisodesPublic
      ? []
      : ["rss_import_imported_episodes_unpublished"]),
    ...(feedValidatedAfterImport
      ? []
      : ["rss_import_canonical_feed_not_revalidated"]),
    ...(certification.launchClaim.ready
      ? []
      : ["rss_import_directory_reobservation_required"]),
    "rss_import_old_host_attestation_required"
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    reconciliationAvailable: true,
    executionId: context.execution.id,
    planId: context.execution.plan_id,
    readiness: {
      evidenceSha256: snapshot.evidenceSha256,
      itemCount: snapshot.itemCount,
      copiedBytes: snapshot.copiedBytes,
      copyReady: snapshot.copyReady,
      prePublicationReady: snapshot.prePublicationReady,
      readyForApproval:
        !context.reconciliation
        && snapshot.copyReady
        && snapshot.prePublicationReady,
      blockers: snapshot.blockers,
      items: snapshot.items.map((item) => ({
        sourceIdentitySha256: item.sourceIdentitySha256,
        targetEpisodeId: item.targetEpisodeId,
        targetSlug: item.targetSlug,
        copiedBytes: item.copiedBytes,
        copiedSha256: item.copiedSha256,
        copiedMimeType: item.copiedMimeType,
        copyReady: item.copyReady,
        privateObjectVerified: item.privateObjectVerified,
        draftIdentityVerified: item.draftIdentityVerified,
        sourceUploadVerified: item.sourceUploadVerified,
        blockers: unique([
          ...item.copyBlockers,
          ...item.prePublicationBlockers
        ])
      }))
    },
    approval: context.reconciliation
      ? {
          id: context.reconciliation.id,
          evidenceSha256: context.reconciliation.evidence_sha256,
          itemCount: context.reconciliation.item_count,
          copiedBytes: context.reconciliation.copied_bytes,
          fresh: approvalFresh,
          approvedAt: context.reconciliation.approved_at
        }
      : null,
    oldHostRedirectChecklist: {
      activationAvailable: false,
      ready: false,
      newFeedUrl:
        `${env.FEED_ORIGIN.replace(/\/$/u, "")}/`
        + `${context.show.rss_slug}/rss.xml`,
      blockers: redirectBlockers,
      checks: {
        ownerReconciliationApproved: approvalFresh,
        importedEpisodesPublic,
        canonicalFeedRevalidated: feedValidatedAfterImport,
        directoryCertificationReady: certification.launchClaim.ready,
        ownerRedirectAttested: false
      }
    },
    idempotent: options.idempotent,
    r2MutationPerformed: false,
    episodeMutationPerformed: false,
    publicationMutationPerformed: false,
    redirectMutationPerformed: false,
    providerContactPerformed: false
  }, { status: options.status ?? 200 });
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  maximumConcurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(maximumConcurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(values[index], index);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function validSha256(value: unknown, field: string): string {
  const digest = requiredText(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new RequestValidationError(`${field} must be a SHA-256 digest`);
  }
  return digest;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[]
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestValidationError(
      "The RSS import reconciliation request has unsupported fields."
    );
  }
}

function reconciliationNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rss_import_reconciliation_not_found" },
    { status: 404 }
  );
}

function reconciliationUnavailable(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rss_import_reconciliation_unavailable" },
    { status: 404 }
  );
}

function reconciliationConflict(
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
