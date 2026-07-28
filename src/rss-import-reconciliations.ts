import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  loadRssImportExecutionEvidence,
  rssImportExecutionEnabled,
  type RssImportExecutionItemRow,
  type RssImportExecutionRow
} from "./rss-import-executions";
import { validatedImportFeedUrl } from "./rss-import-preview";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const RECONCILIATION_SCHEMA =
  "dustwave-rss-import-reconciliation-v1";
const CUTOVER_SCHEMA = "dustwave-rss-import-cutover-v1";
const CUTOVER_REQUIRED_DESTINATIONS = 10;
const R2_HEAD_CONCURRENCY = 5;
const REDIRECT_METHODS = [
  "provider_managed_redirect",
  "self_managed_http_301"
] as const;
type RedirectMethod = typeof REDIRECT_METHODS[number];
const REDIRECT_ATTESTATION_COLUMNS = `
  id, reconciliation_id, execution_id, plan_id, show_id,
  reconciliation_evidence_sha256, old_feed_url_sha256,
  new_feed_url_sha256, redirect_method, owner_control_confirmed,
  permanence_acknowledged, no_activation_confirmed,
  attested_by_admin_user_id, attested_at, created_at`;
const CUTOVER_PACKET_COLUMNS = `
  id, reconciliation_id, redirect_attestation_id, execution_id,
  plan_id, show_id, reconciliation_evidence_sha256,
  imported_episode_state_sha256,
  feed_validation_evidence_sha256, directory_evidence_sha256,
  evidence_sha256, imported_episode_count, public_episode_count,
  certified_destination_count, reobserved_destination_count,
  feed_item_count, expected_feed_item_count, feed_validated_at,
  show_evidence_version,
  episode_evidence_version_total, owner_review_confirmed,
  no_activation_confirmed, prepared_by_admin_user_id,
  prepared_at, created_at`;

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

type PlanRow = {
  id: string;
  requested_feed_url_sha256: string;
  requested_feed_display_url: string;
};

type RedirectAttestationRow = {
  id: string;
  reconciliation_id: string;
  execution_id: string;
  plan_id: string;
  show_id: string;
  reconciliation_evidence_sha256: string;
  old_feed_url_sha256: string;
  new_feed_url_sha256: string;
  redirect_method: RedirectMethod;
  owner_control_confirmed: number;
  permanence_acknowledged: number;
  no_activation_confirmed: number;
  attested_by_admin_user_id: string | null;
  attested_at: string;
  created_at: string;
};

type CutoverPacketRow = {
  id: string;
  reconciliation_id: string;
  redirect_attestation_id: string;
  execution_id: string;
  plan_id: string;
  show_id: string;
  reconciliation_evidence_sha256: string;
  imported_episode_state_sha256: string;
  feed_validation_evidence_sha256: string;
  directory_evidence_sha256: string;
  evidence_sha256: string;
  imported_episode_count: number;
  public_episode_count: number;
  certified_destination_count: number;
  reobserved_destination_count: number;
  feed_item_count: number;
  expected_feed_item_count: number;
  feed_validated_at: string;
  show_evidence_version: number;
  episode_evidence_version_total: number;
  owner_review_confirmed: number;
  no_activation_confirmed: number;
  prepared_by_admin_user_id: string | null;
  prepared_at: string;
  created_at: string;
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
  episode_publication_evidence_version: number | null;
  episode_source_language: string | null;
  episode_canonical_url: string | null;
  episode_public_at: string | null;
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
  rss_job_status: string | null;
  rss_job_completed_at: string | null;
  news_job_status: string | null;
  news_job_completed_at: string | null;
  news_site_status: string | null;
  news_site_updated_at: string | null;
};

type ReconciliationContext = {
  execution: RssImportExecutionRow;
  items: ReconciliationItemStateRow[];
  plan: PlanRow;
  reconciliation: ReconciliationRow | null;
  redirectAttestation: RedirectAttestationRow | null;
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

type CutoverDestinationRow = {
  destination_id: string;
  enabled: number;
  owner_setup_status: string;
  failure_recovery_verified: number;
  latest_observed_sequence: number | null;
  latest_observed_at: string | null;
};

type CutoverFeedValidationRow = {
  status: string;
  feed_url: string;
  validator_version: string;
  feed_sha256: string | null;
  item_count: number | null;
  failure_code: string | null;
  checked_at: string;
  validated_at: string | null;
};

type CutoverSnapshot = {
  evidenceSha256: string;
  importedEpisodeStateSha256: string;
  feedValidationEvidenceSha256: string;
  directoryEvidenceSha256: string;
  readyForPacket: boolean;
  blockers: string[];
  importedEpisodeCount: number;
  publicEpisodeCount: number;
  feedItemCount: number;
  expectedFeedItemCount: number;
  feedValidatedAt: string | null;
  certifiedDestinationCount: number;
  reobservedDestinationCount: number;
  requiredDestinationCount: number;
  showEvidenceVersion: number;
  episodeEvidenceVersionTotal: number;
  items: Array<{
    episodeId: string;
    slug: string;
    publicationRevision: number;
    public: boolean;
    rssPublished: boolean;
    newsPublished: boolean;
    blockers: string[];
  }>;
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

export async function createAdminRssImportRedirectAttestation(
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
  const body = await readJsonObject(request, 8_000);
  requireExactKeys(body, [
    "attestationId",
    "feedUrl",
    "expectedReconciliationEvidenceSha256",
    "redirectMethod",
    "ownerControlConfirmed",
    "permanenceAcknowledged",
    "noActivationConfirmed"
  ]);
  if (
    body.ownerControlConfirmed !== true
    || body.permanenceAcknowledged !== true
    || body.noActivationConfirmed !== true
  ) {
    throw new RequestValidationError(
      "Old-host control, permanence, and no-activation must be confirmed.",
      "rss_import_redirect_attestation_confirmation_required"
    );
  }
  const attestationId = validIdentifier(
    body.attestationId,
    "attestationId"
  );
  const feedUrl = validatedImportFeedUrl(
    requiredText(body.feedUrl, "feedUrl", 2_000)
  );
  const expectedEvidenceSha256 = validSha256(
    body.expectedReconciliationEvidenceSha256,
    "expectedReconciliationEvidenceSha256"
  );
  const redirectMethod = validRedirectMethod(body.redirectMethod);
  const context = await loadReconciliationContext(
    env.DB,
    execution.execution,
    execution.items
  );
  if (!context?.reconciliation) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_not_ready"
    );
  }
  const snapshot = await buildReconciliationSnapshot(env, context);
  const oldFeedUrlSha256 = await sha256Hex(feedUrl);
  const newFeedUrl = redirectNewFeedUrl(env, context.show);
  const newFeedUrlSha256 = await sha256Hex(newFeedUrl);
  if (
    expectedEvidenceSha256 !== snapshot.evidenceSha256
    || context.reconciliation.evidence_sha256
      !== expectedEvidenceSha256
    || context.execution.feed_url_sha256 !== oldFeedUrlSha256
    || context.plan.requested_feed_url_sha256 !== oldFeedUrlSha256
  ) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_changed"
    );
  }

  const existingById = await loadRedirectAttestationById(
    env.DB,
    attestationId
  );
  if (existingById) {
    if (!sameRedirectAttestation(existingById, {
      reconciliationId: context.reconciliation.id,
      executionId: context.execution.id,
      planId,
      showId: context.execution.show_id,
      evidenceSha256: expectedEvidenceSha256,
      oldFeedUrlSha256,
      newFeedUrlSha256,
      redirectMethod
    })) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_redirect_attestation_conflict"
      );
    }
    return reconciliationResponse(
      request,
      env,
      { ...context, redirectAttestation: existingById },
      snapshot,
      { idempotent: true }
    );
  }
  if (!reconciliationApprovalFresh(context, snapshot)) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_not_ready"
    );
  }
  const matching = await loadMatchingRedirectAttestation(
    env.DB,
    context.execution.id,
    expectedEvidenceSha256,
    oldFeedUrlSha256,
    newFeedUrlSha256,
    redirectMethod
  );
  if (matching) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_conflict"
    );
  }

  let inserted: D1Result;
  try {
    [inserted] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rss_import_redirect_attestations (
           id, reconciliation_id, execution_id, plan_id, show_id,
           reconciliation_evidence_sha256, old_feed_url_sha256,
           new_feed_url_sha256, redirect_method,
           owner_control_confirmed, permanence_acknowledged,
           no_activation_confirmed, attested_by_admin_user_id
         )
         SELECT
           ?, reconciliation.id, execution.id, execution.plan_id,
           execution.show_id, ?, ?, ?, ?, 1, 1, 1, ?
         FROM rss_import_reconciliations reconciliation
         JOIN rss_import_executions execution
           ON execution.id = reconciliation.execution_id
         JOIN rss_import_plans plan
           ON plan.id = execution.plan_id
         JOIN shows show_record
           ON show_record.id = execution.show_id
         WHERE execution.plan_id = ?
           AND reconciliation.evidence_sha256 = ?
           AND execution.feed_url_sha256 = ?
           AND plan.requested_feed_url_sha256 = ?
           AND show_record.rss_slug = ?`
      ).bind(
        attestationId,
        expectedEvidenceSha256,
        oldFeedUrlSha256,
        newFeedUrlSha256,
        redirectMethod,
        auth.authorization.identity.id,
        planId,
        expectedEvidenceSha256,
        oldFeedUrlSha256,
        oldFeedUrlSha256,
        context.show.rss_slug
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.redirect_control_attested",
        targetType: "rss_import_redirect_attestation",
        targetId: attestationId,
        metadata: {
          reconciliationId: context.reconciliation.id,
          executionId: context.execution.id,
          planId,
          showId: context.execution.show_id,
          reconciliationEvidenceSha256: expectedEvidenceSha256,
          oldFeedUrlSha256,
          newFeedUrlSha256,
          redirectMethod,
          redirectMutationPerformed: false,
          providerContactPerformed: false
        }
      })
    ]);
  } catch (error) {
    const raced = await loadRedirectAttestationById(
      env.DB,
      attestationId
    );
    if (
      raced
      && sameRedirectAttestation(raced, {
        reconciliationId: context.reconciliation.id,
        executionId: context.execution.id,
        planId,
        showId: context.execution.show_id,
        evidenceSha256: expectedEvidenceSha256,
        oldFeedUrlSha256,
        newFeedUrlSha256,
        redirectMethod
      })
    ) {
      return reconciliationResponse(
        request,
        env,
        { ...context, redirectAttestation: raced },
        snapshot,
        { idempotent: true }
      );
    }
    const racedMatching = await loadMatchingRedirectAttestation(
      env.DB,
      context.execution.id,
      expectedEvidenceSha256,
      oldFeedUrlSha256,
      newFeedUrlSha256,
      redirectMethod
    );
    if (racedMatching) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_redirect_attestation_conflict"
      );
    }
    throw error;
  }
  if (Number(inserted.meta.changes ?? 0) !== 1) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_not_ready"
    );
  }
  const created = await loadRedirectAttestationById(
    env.DB,
    attestationId
  );
  if (!created) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_redirect_attestation_conflict"
    );
  }
  return reconciliationResponse(
    request,
    env,
    { ...context, redirectAttestation: created },
    snapshot,
    {
      idempotent: false,
      status: 201,
      attestationRecorded: true
    }
  );
}

export async function createAdminRssImportCutoverPacket(
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
  const body = await readJsonObject(request, 8_000);
  requireExactKeys(body, [
    "packetId",
    "expectedEvidenceSha256",
    "ownerReviewConfirmed",
    "noActivationConfirmed"
  ]);
  if (
    body.ownerReviewConfirmed !== true
    || body.noActivationConfirmed !== true
  ) {
    throw new RequestValidationError(
      "Exact cutover evidence review and no activation must be confirmed.",
      "rss_import_cutover_confirmation_required"
    );
  }
  const packetId = validIdentifier(body.packetId, "packetId");
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
  const reconciliationSnapshot = await buildReconciliationSnapshot(
    env,
    context
  );
  const cutover = await buildCutoverSnapshot(
    env,
    context,
    reconciliationSnapshot
  );
  if (cutover.evidenceSha256 !== expectedEvidenceSha256) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_cutover_evidence_changed"
    );
  }

  const existingById = await loadCutoverPacketById(
    env.DB,
    packetId
  );
  if (existingById) {
    if (!sameCutoverPacket(existingById, context, cutover)) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_cutover_packet_conflict"
      );
    }
    return reconciliationResponse(
      request,
      env,
      context,
      reconciliationSnapshot,
      { idempotent: true }
    );
  }
  if (
    !cutover.readyForPacket
    || !context.reconciliation
    || !context.redirectAttestation
  ) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_cutover_not_ready"
    );
  }
  const matching = await loadMatchingCutoverPacket(
    env.DB,
    context.execution.id,
    expectedEvidenceSha256
  );
  if (matching) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_cutover_packet_conflict"
    );
  }

  let inserted: D1Result;
  try {
    [inserted] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rss_import_cutover_packets (
           id, reconciliation_id, redirect_attestation_id,
           execution_id, plan_id, show_id,
           reconciliation_evidence_sha256,
           imported_episode_state_sha256,
           feed_validation_evidence_sha256,
           directory_evidence_sha256, evidence_sha256,
           imported_episode_count, public_episode_count,
           certified_destination_count,
           reobserved_destination_count, feed_item_count,
           expected_feed_item_count,
           feed_validated_at, show_evidence_version,
           episode_evidence_version_total,
           owner_review_confirmed, no_activation_confirmed,
           prepared_by_admin_user_id
         )
         SELECT
           ?, reconciliation.id, attestation.id,
           execution.id, execution.plan_id, execution.show_id,
           reconciliation.evidence_sha256, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?
         FROM rss_import_reconciliations reconciliation
         JOIN rss_import_executions execution
           ON execution.id = reconciliation.execution_id
         JOIN rss_import_redirect_attestations attestation
           ON attestation.reconciliation_id = reconciliation.id
          AND attestation.execution_id = execution.id
         WHERE execution.id = ?
           AND execution.plan_id = ?
           AND reconciliation.id = ?
           AND reconciliation.evidence_sha256 = ?
           AND attestation.id = ?
           AND attestation.reconciliation_evidence_sha256 =
             reconciliation.evidence_sha256
           AND (
             SELECT version
             FROM publication_show_evidence_versions
             WHERE show_id = execution.show_id
           ) = ?
           AND (
             SELECT COALESCE(
               SUM(episode.publication_evidence_version),
               0
             )
             FROM rss_import_execution_items item
             JOIN episodes episode
               ON episode.id = item.target_episode_id
             WHERE item.execution_id = execution.id
           ) = ?`
      ).bind(
        packetId,
        cutover.importedEpisodeStateSha256,
        cutover.feedValidationEvidenceSha256,
        cutover.directoryEvidenceSha256,
        cutover.evidenceSha256,
        cutover.importedEpisodeCount,
        cutover.publicEpisodeCount,
        cutover.certifiedDestinationCount,
        cutover.reobservedDestinationCount,
        cutover.feedItemCount,
        cutover.expectedFeedItemCount,
        cutover.feedValidatedAt,
        cutover.showEvidenceVersion,
        cutover.episodeEvidenceVersionTotal,
        auth.authorization.identity.id,
        context.execution.id,
        planId,
        context.reconciliation.id,
        context.reconciliation.evidence_sha256,
        context.redirectAttestation.id,
        cutover.showEvidenceVersion,
        cutover.episodeEvidenceVersionTotal
      ),
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.cutover_packet_prepared",
        targetType: "rss_import_cutover_packet",
        targetId: packetId,
        metadata: {
          reconciliationId: context.reconciliation.id,
          redirectAttestationId: context.redirectAttestation.id,
          executionId: context.execution.id,
          planId,
          showId: context.execution.show_id,
          evidenceSha256: cutover.evidenceSha256,
          importedEpisodeCount: cutover.importedEpisodeCount,
          certifiedDestinationCount:
            cutover.certifiedDestinationCount,
          reobservedDestinationCount:
            cutover.reobservedDestinationCount,
          redirectMutationPerformed: false,
          providerContactPerformed: false
        }
      })
    ]);
  } catch (error) {
    const raced = await loadCutoverPacketById(env.DB, packetId);
    if (raced && sameCutoverPacket(raced, context, cutover)) {
      return reconciliationResponse(
        request,
        env,
        context,
        reconciliationSnapshot,
        { idempotent: true }
      );
    }
    const racedMatching = await loadMatchingCutoverPacket(
      env.DB,
      context.execution.id,
      expectedEvidenceSha256
    );
    if (racedMatching) {
      return reconciliationConflict(
        request,
        env,
        "rss_import_cutover_packet_conflict"
      );
    }
    throw error;
  }
  if (Number(inserted.meta.changes ?? 0) !== 1) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_cutover_not_ready"
    );
  }
  const created = await loadCutoverPacketById(env.DB, packetId);
  if (!created || !sameCutoverPacket(created, context, cutover)) {
    return reconciliationConflict(
      request,
      env,
      "rss_import_cutover_packet_conflict"
    );
  }
  return reconciliationResponse(
    request,
    env,
    context,
    reconciliationSnapshot,
    {
      idempotent: false,
      status: 201,
      cutoverPacketRecorded: true
    }
  );
}

async function loadReconciliationContext(
  db: D1Database,
  execution: RssImportExecutionRow,
  executionItems: RssImportExecutionItemRow[]
): Promise<ReconciliationContext | null> {
  const [
    show,
    plan,
    reconciliation,
    redirectAttestation,
    itemResult
  ] = await Promise.all([
    db.prepare(
      "SELECT id, slug, rss_slug FROM shows WHERE id = ?"
    ).bind(execution.show_id).first<ShowRow>(),
    db.prepare(
      `SELECT
         id, requested_feed_url_sha256, requested_feed_display_url
       FROM rss_import_plans
       WHERE id = ?`
    ).bind(execution.plan_id).first<PlanRow>(),
    loadReconciliation(db, execution.id),
    loadLatestRedirectAttestation(db, execution.id),
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
         episode.publication_evidence_version
           AS episode_publication_evidence_version,
         episode.source_language AS episode_source_language,
         episode.canonical_url AS episode_canonical_url,
         episode.public_at AS episode_public_at,
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
         ) AS directory_publication_count,
         (
           SELECT job.status
           FROM distribution_jobs job
           WHERE job.episode_id = item.target_episode_id
             AND job.destination = 'rss'
             AND job.publication_revision =
               episode.publication_revision
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) AS rss_job_status,
         (
           SELECT job.completed_at
           FROM distribution_jobs job
           WHERE job.episode_id = item.target_episode_id
             AND job.destination = 'rss'
             AND job.publication_revision =
               episode.publication_revision
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) AS rss_job_completed_at,
         (
           SELECT job.status
           FROM distribution_jobs job
           WHERE job.episode_id = item.target_episode_id
             AND job.destination = 'news'
             AND job.publication_revision =
               episode.publication_revision
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) AS news_job_status,
         (
           SELECT job.completed_at
           FROM distribution_jobs job
           WHERE job.episode_id = item.target_episode_id
             AND job.destination = 'news'
             AND job.publication_revision =
               episode.publication_revision
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) AS news_job_completed_at,
         (
           SELECT publication.status
           FROM site_publications publication
           WHERE publication.episode_id = item.target_episode_id
             AND publication.publication_revision =
               episode.publication_revision
           ORDER BY publication.updated_at DESC, publication.id DESC
           LIMIT 1
         ) AS news_site_status,
         (
           SELECT publication.updated_at
           FROM site_publications publication
           WHERE publication.episode_id = item.target_episode_id
             AND publication.publication_revision =
               episode.publication_revision
           ORDER BY publication.updated_at DESC, publication.id DESC
           LIMIT 1
         ) AS news_site_updated_at
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
    || !plan
    || itemResult.results.length !== executionItems.length
  ) {
    return null;
  }
  return {
    execution,
    items: itemResult.results,
    plan,
    reconciliation,
    redirectAttestation,
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

async function loadLatestRedirectAttestation(
  db: D1Database,
  executionId: string
): Promise<RedirectAttestationRow | null> {
  return db.prepare(
    `SELECT ${REDIRECT_ATTESTATION_COLUMNS}
     FROM rss_import_redirect_attestations
     WHERE execution_id = ?
     ORDER BY attested_at DESC, rowid DESC
     LIMIT 1`
  ).bind(executionId).first<RedirectAttestationRow>();
}

async function loadRedirectAttestationById(
  db: D1Database,
  id: string
): Promise<RedirectAttestationRow | null> {
  return db.prepare(
    `SELECT ${REDIRECT_ATTESTATION_COLUMNS}
     FROM rss_import_redirect_attestations
     WHERE id = ?`
  ).bind(id).first<RedirectAttestationRow>();
}

async function loadMatchingRedirectAttestation(
  db: D1Database,
  executionId: string,
  evidenceSha256: string,
  oldFeedUrlSha256: string,
  newFeedUrlSha256: string,
  redirectMethod: RedirectMethod
): Promise<RedirectAttestationRow | null> {
  return db.prepare(
    `SELECT ${REDIRECT_ATTESTATION_COLUMNS}
     FROM rss_import_redirect_attestations
     WHERE execution_id = ?
       AND reconciliation_evidence_sha256 = ?
       AND old_feed_url_sha256 = ?
       AND new_feed_url_sha256 = ?
       AND redirect_method = ?`
  ).bind(
    executionId,
    evidenceSha256,
    oldFeedUrlSha256,
    newFeedUrlSha256,
    redirectMethod
  ).first<RedirectAttestationRow>();
}

function sameRedirectAttestation(
  row: RedirectAttestationRow,
  expected: {
    reconciliationId: string;
    executionId: string;
    planId: string;
    showId: string;
    evidenceSha256: string;
    oldFeedUrlSha256: string;
    newFeedUrlSha256: string;
    redirectMethod: RedirectMethod;
  }
): boolean {
  return row.reconciliation_id === expected.reconciliationId
    && row.execution_id === expected.executionId
    && row.plan_id === expected.planId
    && row.show_id === expected.showId
    && row.reconciliation_evidence_sha256 === expected.evidenceSha256
    && row.old_feed_url_sha256 === expected.oldFeedUrlSha256
    && row.new_feed_url_sha256 === expected.newFeedUrlSha256
    && row.redirect_method === expected.redirectMethod
    && row.owner_control_confirmed === 1
    && row.permanence_acknowledged === 1
    && row.no_activation_confirmed === 1;
}

async function loadLatestCutoverPacket(
  db: D1Database,
  executionId: string
): Promise<CutoverPacketRow | null> {
  return db.prepare(
    `SELECT ${CUTOVER_PACKET_COLUMNS}
     FROM rss_import_cutover_packets
     WHERE execution_id = ?
     ORDER BY prepared_at DESC, rowid DESC
     LIMIT 1`
  ).bind(executionId).first<CutoverPacketRow>();
}

async function loadCutoverPacketById(
  db: D1Database,
  id: string
): Promise<CutoverPacketRow | null> {
  return db.prepare(
    `SELECT ${CUTOVER_PACKET_COLUMNS}
     FROM rss_import_cutover_packets
     WHERE id = ?`
  ).bind(id).first<CutoverPacketRow>();
}

async function loadMatchingCutoverPacket(
  db: D1Database,
  executionId: string,
  evidenceSha256: string
): Promise<CutoverPacketRow | null> {
  return db.prepare(
    `SELECT ${CUTOVER_PACKET_COLUMNS}
     FROM rss_import_cutover_packets
     WHERE execution_id = ?
       AND evidence_sha256 = ?`
  ).bind(executionId, evidenceSha256).first<CutoverPacketRow>();
}

function sameCutoverPacket(
  row: CutoverPacketRow,
  context: ReconciliationContext,
  snapshot: CutoverSnapshot
): boolean {
  return Boolean(
    context.reconciliation
    && context.redirectAttestation
    && row.reconciliation_id === context.reconciliation.id
    && row.redirect_attestation_id === context.redirectAttestation.id
    && row.execution_id === context.execution.id
    && row.plan_id === context.plan.id
    && row.show_id === context.show.id
    && row.reconciliation_evidence_sha256
      === context.reconciliation.evidence_sha256
    && row.imported_episode_state_sha256
      === snapshot.importedEpisodeStateSha256
    && row.feed_validation_evidence_sha256
      === snapshot.feedValidationEvidenceSha256
    && row.directory_evidence_sha256
      === snapshot.directoryEvidenceSha256
    && row.evidence_sha256 === snapshot.evidenceSha256
    && row.imported_episode_count === snapshot.importedEpisodeCount
    && row.public_episode_count === snapshot.publicEpisodeCount
    && row.certified_destination_count
      === snapshot.certifiedDestinationCount
    && row.reobserved_destination_count
      === snapshot.reobservedDestinationCount
    && row.feed_item_count === snapshot.feedItemCount
    && row.expected_feed_item_count === snapshot.expectedFeedItemCount
    && row.feed_validated_at === snapshot.feedValidatedAt
    && row.show_evidence_version === snapshot.showEvidenceVersion
    && row.episode_evidence_version_total
      === snapshot.episodeEvidenceVersionTotal
    && row.owner_review_confirmed === 1
    && row.no_activation_confirmed === 1
  );
}

async function buildCutoverSnapshot(
  env: PodcastEnv,
  context: ReconciliationContext,
  reconciliationSnapshot: ReconciliationSnapshot
): Promise<CutoverSnapshot> {
  const db = env.DB;
  const [
    feedValidation,
    destinationResult,
    showEvidence,
    expectedFeed
  ] =
    await Promise.all([
      db.prepare(
        `SELECT
           status, feed_url, validator_version, feed_sha256,
           item_count, failure_code, checked_at, validated_at
         FROM show_feed_validations
         WHERE show_id = ?`
      ).bind(context.show.id).first<CutoverFeedValidationRow>(),
      db.prepare(
        `WITH scoped_destinations AS (
           SELECT
             destination.id AS destination_id,
             COALESCE(setup.enabled, destination.enabled) AS enabled,
             COALESCE(
               setup.owner_setup_status,
               destination.owner_setup_status
             ) AS owner_setup_status
           FROM distribution_destinations destination
           LEFT JOIN show_distribution_destinations setup
             ON setup.destination_id = destination.id
            AND setup.show_id = ?
         )
         SELECT
           scoped.destination_id,
           scoped.enabled,
           scoped.owner_setup_status,
           EXISTS (
             SELECT 1
             FROM distribution_observation_events failed
             WHERE failed.show_id = ?
               AND failed.destination_id = scoped.destination_id
               AND failed.status = 'failed'
               AND EXISTS (
                 SELECT 1
                 FROM distribution_observation_events recovered
                 WHERE recovered.show_id = failed.show_id
                   AND recovered.destination_id =
                     failed.destination_id
                   AND recovered.status = 'observed'
                   AND recovered.sequence > failed.sequence
               )
           ) AS failure_recovery_verified,
           (
             SELECT MAX(observed.sequence)
             FROM distribution_observation_events observed
             WHERE observed.show_id = ?
               AND observed.destination_id = scoped.destination_id
               AND observed.status = 'observed'
           ) AS latest_observed_sequence,
           (
             SELECT observed.recorded_at
             FROM distribution_observation_events observed
             WHERE observed.show_id = ?
               AND observed.destination_id = scoped.destination_id
               AND observed.status = 'observed'
             ORDER BY observed.sequence DESC
             LIMIT 1
           ) AS latest_observed_at
         FROM scoped_destinations scoped
         ORDER BY scoped.destination_id`
      ).bind(
        context.show.id,
        context.show.id,
        context.show.id,
        context.show.id
      ).all<CutoverDestinationRow>(),
      db.prepare(
        `SELECT version
         FROM publication_show_evidence_versions
         WHERE show_id = ?`
      ).bind(context.show.id).first<{ version: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS item_count
         FROM episodes
         WHERE show_id = ?
           AND status = 'published'
           AND public_at <= ${SQL_UTC_NOW_RFC3339}
           AND access IN ('public', 'early_access', 'free_mini')
           AND media_status = 'ready'
           AND audio_key IS NOT NULL
           AND guid IS NOT NULL`
      ).bind(context.show.id).first<{ item_count: number }>()
    ]);

  const now = Date.now();
  const items = context.items.map((item) => {
    const publicReleaseReady = item.episode_status === "published"
      && item.episode_media_status === "ready"
      && Boolean(item.episode_audio_key)
      && Number(item.episode_publication_revision) > 0
      && timestamp(item.episode_public_at) > 0
      && timestamp(item.episode_public_at) <= now;
    const rssPublished = item.rss_job_status === "succeeded"
      && timestamp(item.rss_job_completed_at) > 0;
    const newsPublished = item.news_job_status === "succeeded"
      && item.news_site_status === "succeeded"
      && timestamp(item.news_job_completed_at) > 0
      && timestamp(item.news_site_updated_at) > 0;
    const blockers = unique([
      ...(publicReleaseReady
        ? []
        : ["rss_import_cutover_episode_not_public"]),
      ...(rssPublished
        ? []
        : ["rss_import_cutover_rss_not_published"]),
      ...(newsPublished
        ? []
        : ["rss_import_cutover_news_not_published"])
    ]);
    return {
      episodeId: item.target_episode_id,
      slug: item.target_slug,
      publicationRevision: Number(
        item.episode_publication_revision ?? 0
      ),
      publicationEvidenceVersion: Number(
        item.episode_publication_evidence_version ?? 0
      ),
      public: publicReleaseReady,
      rssPublished,
      newsPublished,
      publicationEvidenceAt: Math.max(
        timestamp(item.episode_updated_at),
        timestamp(item.rss_job_completed_at),
        timestamp(item.news_job_completed_at),
        timestamp(item.news_site_updated_at)
      ),
      blockers
    };
  });
  const publicEpisodeCount = items.filter((item) =>
    item.public && item.rssPublished && item.newsPublished
  ).length;
  const importedEpisodeState = items.map((item) => ({
    episodeId: item.episodeId,
    slug: item.slug,
    publicationRevision: item.publicationRevision,
    publicationEvidenceVersion: item.publicationEvidenceVersion,
    public: item.public,
    rssPublished: item.rssPublished,
    newsPublished: item.newsPublished,
    publicationEvidenceAt: item.publicationEvidenceAt
  }));
  const importedEpisodeStateSha256 = await sha256Hex(
    JSON.stringify(importedEpisodeState)
  );
  const latestPublicationEvidenceAt = items.reduce(
    (latest, item) => Math.max(latest, item.publicationEvidenceAt),
    0
  );
  const expectedFeedUrl = redirectNewFeedUrl(env, context.show);
  const configuredFeedUrl = feedValidation?.feed_url ?? null;
  const feedValidatedAt = feedValidation?.validated_at ?? null;
  const expectedFeedItemCount = Number(
    expectedFeed?.item_count ?? 0
  );
  const feedReady = Boolean(
    feedValidation?.status === "valid"
    && feedValidation.feed_sha256
    && feedValidation.item_count !== null
    && configuredFeedUrl === expectedFeedUrl
    && feedValidatedAt
    && timestamp(feedValidatedAt) >= latestPublicationEvidenceAt
    && Number(feedValidation.item_count) === expectedFeedItemCount
    && expectedFeedItemCount >= items.length
  );
  const feedValidationEvidence = {
    status: feedValidation?.status ?? "not_checked",
    feedUrl: configuredFeedUrl,
    expectedFeedPath: `/${context.show.rss_slug}/rss.xml`,
    validatorVersion: feedValidation?.validator_version ?? null,
    feedSha256: feedValidation?.feed_sha256 ?? null,
    itemCount: Number(feedValidation?.item_count ?? 0),
    expectedItemCount: expectedFeedItemCount,
    failureCode: feedValidation?.failure_code ?? null,
    checkedAt: feedValidation?.checked_at ?? null,
    validatedAt: feedValidatedAt,
    currentAfterImportedPublication: feedReady
  };
  const feedValidationEvidenceSha256 = await sha256Hex(
    JSON.stringify(feedValidationEvidence)
  );
  const validatedAtMs = timestamp(feedValidatedAt);
  const destinations = destinationResult.results.map((row) => {
    const enabled = row.enabled === 1;
    const ownerVerified = ["verified", "not_required"].includes(
      row.owner_setup_status
    );
    const failureRecoveryVerified =
      row.failure_recovery_verified === 1;
    const observed = Number(row.latest_observed_sequence ?? 0) > 0;
    const certified = enabled
      && ownerVerified
      && feedReady
      && observed
      && failureRecoveryVerified;
    const reobservedAfterFeedValidation = certified
      && timestamp(row.latest_observed_at) >= validatedAtMs;
    return {
      destinationId: row.destination_id,
      enabled,
      ownerVerified,
      failureRecoveryVerified,
      latestObservedSequence: Number(
        row.latest_observed_sequence ?? 0
      ),
      latestObservedAt: row.latest_observed_at,
      certified,
      reobservedAfterFeedValidation
    };
  });
  const certifiedDestinationCount = destinations.filter(
    (destination) => destination.certified
  ).length;
  const reobservedDestinationCount = destinations.filter(
    (destination) => destination.reobservedAfterFeedValidation
  ).length;
  const directoryEvidenceSha256 = await sha256Hex(
    JSON.stringify(destinations)
  );
  const approvalFresh = reconciliationApprovalFresh(
    context,
    reconciliationSnapshot
  );
  const newFeedUrlSha256 = await sha256Hex(
    expectedFeedUrl
  );
  const redirectAttestationFresh = Boolean(
    approvalFresh
    && context.redirectAttestation
    && context.reconciliation
    && context.redirectAttestation.reconciliation_id
      === context.reconciliation.id
    && context.redirectAttestation.execution_id === context.execution.id
    && context.redirectAttestation.plan_id === context.plan.id
    && context.redirectAttestation.show_id === context.show.id
    && context.redirectAttestation.reconciliation_evidence_sha256
      === reconciliationSnapshot.evidenceSha256
    && context.redirectAttestation.old_feed_url_sha256
      === context.execution.feed_url_sha256
    && context.redirectAttestation.new_feed_url_sha256
      === newFeedUrlSha256
    && context.redirectAttestation.owner_control_confirmed === 1
    && context.redirectAttestation.permanence_acknowledged === 1
    && context.redirectAttestation.no_activation_confirmed === 1
  );
  const blockers = unique([
    ...(approvalFresh
      ? []
      : ["rss_import_owner_reconciliation_required"]),
    ...items.flatMap((item) => item.blockers),
    ...(feedReady
      ? []
      : ["rss_import_cutover_feed_not_current"]),
    ...(certifiedDestinationCount >= CUTOVER_REQUIRED_DESTINATIONS
      ? []
      : ["rss_import_cutover_directory_certification_required"]),
    ...(reobservedDestinationCount >= CUTOVER_REQUIRED_DESTINATIONS
      ? []
      : ["rss_import_cutover_directory_reobservation_required"]),
    ...(redirectAttestationFresh
      ? []
      : ["rss_import_old_host_attestation_required"])
  ]);
  const evidence = {
    schema: CUTOVER_SCHEMA,
    executionId: context.execution.id,
    planId: context.plan.id,
    showId: context.show.id,
    reconciliationId: context.reconciliation?.id ?? null,
    reconciliationEvidenceSha256:
      reconciliationSnapshot.evidenceSha256,
    redirectAttestationId: context.redirectAttestation?.id ?? null,
    redirectMethod:
      context.redirectAttestation?.redirect_method ?? null,
    importedEpisodeStateSha256,
    feedValidationEvidenceSha256,
    directoryEvidenceSha256,
    showEvidenceVersion: Number(showEvidence?.version ?? 0),
    episodeEvidenceVersionTotal: items.reduce(
      (total, item) => total + item.publicationEvidenceVersion,
      0
    )
  };
  return {
    evidenceSha256: await sha256Hex(JSON.stringify(evidence)),
    importedEpisodeStateSha256,
    feedValidationEvidenceSha256,
    directoryEvidenceSha256,
    readyForPacket: blockers.length === 0,
    blockers,
    importedEpisodeCount: items.length,
    publicEpisodeCount,
    feedItemCount: Number(feedValidation?.item_count ?? 0),
    expectedFeedItemCount,
    feedValidatedAt,
    certifiedDestinationCount,
    reobservedDestinationCount,
    requiredDestinationCount: CUTOVER_REQUIRED_DESTINATIONS,
    showEvidenceVersion: Number(showEvidence?.version ?? 0),
    episodeEvidenceVersionTotal: items.reduce(
      (total, item) => total + item.publicationEvidenceVersion,
      0
    ),
    items: items.map((item) => ({
      episodeId: item.episodeId,
      slug: item.slug,
      publicationRevision: item.publicationRevision,
      public: item.public,
      rssPublished: item.rssPublished,
      newsPublished: item.newsPublished,
      blockers: item.blockers
    }))
  };
}

function reconciliationApprovalFresh(
  context: ReconciliationContext,
  snapshot: ReconciliationSnapshot
): boolean {
  return Boolean(
    context.reconciliation
    && context.reconciliation.evidence_sha256
      === snapshot.evidenceSha256
    && snapshot.copyReady
  );
}

function redirectNewFeedUrl(env: PodcastEnv, show: ShowRow): string {
  return `${env.FEED_ORIGIN.replace(/\/$/u, "")}/`
    + `${show.rss_slug}/rss.xml`;
}

async function reconciliationResponse(
  request: Request,
  env: PodcastEnv,
  context: ReconciliationContext,
  snapshot: ReconciliationSnapshot,
  options: {
    idempotent: boolean | null;
    status?: number;
    attestationRecorded?: boolean;
    cutoverPacketRecorded?: boolean;
  }
): Promise<Response> {
  const [cutover, cutoverPacket] = await Promise.all([
    buildCutoverSnapshot(env, context, snapshot),
    loadLatestCutoverPacket(env.DB, context.execution.id)
  ]);
  const approvalFresh = reconciliationApprovalFresh(context, snapshot);
  const importedEpisodesPublic =
    cutover.publicEpisodeCount === cutover.importedEpisodeCount;
  const feedValidatedAfterImport = !cutover.blockers.includes(
    "rss_import_cutover_feed_not_current"
  );
  const newFeedUrl = redirectNewFeedUrl(env, context.show);
  const redirectAttestationFresh = !cutover.blockers.includes(
    "rss_import_old_host_attestation_required"
  );
  const directoryReobservationReady =
    cutover.reobservedDestinationCount
      >= cutover.requiredDestinationCount;
  const packetFresh = Boolean(
    cutoverPacket
    && sameCutoverPacket(cutoverPacket, context, cutover)
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
    ...(directoryReobservationReady
      ? []
      : ["rss_import_directory_reobservation_required"]),
    ...(redirectAttestationFresh
      ? []
      : ["rss_import_old_host_attestation_required"]),
    "rss_import_redirect_activation_unavailable"
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
    cutoverReadiness: {
      schema: CUTOVER_SCHEMA,
      activationAvailable: false,
      evidenceReady: cutover.readyForPacket,
      readyForPacket: cutover.readyForPacket && !packetFresh,
      evidenceSha256: cutover.evidenceSha256,
      importedEpisodeStateSha256:
        cutover.importedEpisodeStateSha256,
      feedValidationEvidenceSha256:
        cutover.feedValidationEvidenceSha256,
      directoryEvidenceSha256:
        cutover.directoryEvidenceSha256,
      importedEpisodeCount: cutover.importedEpisodeCount,
      publicEpisodeCount: cutover.publicEpisodeCount,
      feedItemCount: cutover.feedItemCount,
      expectedFeedItemCount: cutover.expectedFeedItemCount,
      feedValidatedAt: cutover.feedValidatedAt,
      certifiedDestinationCount:
        cutover.certifiedDestinationCount,
      reobservedDestinationCount:
        cutover.reobservedDestinationCount,
      requiredDestinationCount:
        cutover.requiredDestinationCount,
      blockers: cutover.blockers,
      checks: {
        ownerReconciliationApproved: approvalFresh,
        importedEpisodeRevisionsPublished:
          importedEpisodesPublic,
        canonicalFeedCurrent: feedValidatedAfterImport,
        directoryCertificationReady:
          cutover.certifiedDestinationCount
            >= cutover.requiredDestinationCount,
        directoriesReobservedAfterFeed:
          directoryReobservationReady,
        ownerRedirectAttested: redirectAttestationFresh
      },
      items: cutover.items,
      packet: cutoverPacket
        ? {
            id: cutoverPacket.id,
            evidenceSha256: cutoverPacket.evidence_sha256,
            fresh: packetFresh,
            preparedAt: cutoverPacket.prepared_at,
            importedEpisodeCount:
              cutoverPacket.imported_episode_count,
            reobservedDestinationCount:
              cutoverPacket.reobserved_destination_count
          }
        : null
    },
    oldHostRedirectChecklist: {
      activationAvailable: false,
      ready: false,
      attestationAvailable: approvalFresh,
      oldFeedDisplayUrl: context.plan.requested_feed_display_url,
      newFeedUrl,
      attestation: context.redirectAttestation
        ? {
            id: context.redirectAttestation.id,
            redirectMethod:
              context.redirectAttestation.redirect_method,
            fresh: redirectAttestationFresh,
            attestedAt: context.redirectAttestation.attested_at
          }
        : null,
      blockers: redirectBlockers,
      checks: {
        ownerReconciliationApproved: approvalFresh,
        importedEpisodesPublic,
        canonicalFeedRevalidated: feedValidatedAfterImport,
        directoryCertificationReady: directoryReobservationReady,
        ownerRedirectAttested: redirectAttestationFresh
      }
    },
    idempotent: options.idempotent,
    redirectAttestationMutationPerformed:
      options.attestationRecorded === true,
    cutoverPacketMutationPerformed:
      options.cutoverPacketRecorded === true,
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

function validRedirectMethod(value: unknown): RedirectMethod {
  const method = requiredText(value, "redirectMethod", 80);
  if (!REDIRECT_METHODS.includes(method as RedirectMethod)) {
    throw new RequestValidationError(
      "redirectMethod must be provider_managed_redirect or "
      + "self_managed_http_301"
    );
  }
  return method as RedirectMethod;
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
