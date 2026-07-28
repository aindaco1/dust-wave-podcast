import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import {
  prepareAdminAudit,
  recordAdminAudit
} from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  loadRssImportPlanEvidence,
  reconcileRssImportPlanSource,
  type ImportPlanItemRow
} from "./rss-import-plans";
import {
  openSensitiveValue,
  sealSensitiveValue
} from "./sealed-value";
import type { PodcastJob } from "./types";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier,
  validSlug
} from "./validation";

const EXECUTION_MODE = "staging_copy";
const MAXIMUM_AUDIO_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_AUDIO_REDIRECTS = 2;
const AUDIO_COPY_TIMEOUT_MS = 10 * 60 * 1_000;
const MAXIMUM_ATTEMPTS = 5;
const SOURCE_URL_RETENTION_DAYS = 7;
const SOURCE_URL_RETAINED =
  "not_retained:rss_import_execution_complete:v1";
const SOURCE_URL_EXPIRED =
  "not_retained:rss_import_execution_expired:v1";
const SOURCE_URL_CONTRACT = {
  keyContext: "podcast-rss-import-source-v1",
  additionalDataContext: "podcast-rss-import-execution-v1"
};

export type RssImportExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed";

export type RssImportExecutionRow = {
  id: string;
  plan_id: string;
  show_id: string;
  feed_url_ciphertext: string;
  feed_url_sha256: string;
  feed_sha256: string;
  selection_sha256: string;
  status: RssImportExecutionStatus;
  expected_item_count: number;
  copied_item_count: number;
  draft_item_count: number;
  failed_item_count: number;
  requested_by_admin_user_id: string;
  source_url_expires_at: string;
  last_error_code: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type RssImportExecutionItemRow = {
  execution_id: string;
  plan_id: string;
  source_identity_sha256: string;
  ordinal: number;
  target_episode_id: string;
  target_slug: string;
  source_language: "en" | "es";
  target_object_key: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempt_count: number;
  queue_sent_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  response_resolved_url_sha256: string | null;
  copied_bytes: number | null;
  copied_sha256: string | null;
  copied_etag: string | null;
  copied_mime_type: string | null;
  episode_id: string | null;
  last_error_code: string | null;
};

type ExecutionRequestItem = {
  sourceIdentitySha256: string;
  targetSlug: string;
  sourceLanguage: "en" | "es";
};

type ProcessingRow = RssImportExecutionItemRow & {
  show_id: string;
  feed_url_ciphertext: string;
  feed_url_sha256: string;
  requested_by_admin_user_id: string;
  plan_status: string;
  plan_item_title: string;
  plan_item_summary: string;
  plan_item_published_at: string;
  plan_item_duration_seconds: number | null;
  plan_item_explicit: number | null;
  plan_item_metadata_sha256: string;
  plan_item_enclosure_url_sha256: string;
  plan_item_enclosure_mime_type: string;
  plan_item_enclosure_bytes: number;
  show_slug: string;
};

type CopiedAudio = {
  bytes: number;
  sha256: string;
  etag: string;
  mimeType: string;
  resolvedUrlSha256: string;
};

export async function createAdminRssImportExecution(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  if (!rssImportExecutionEnabled(env)) {
    return executionUnavailable(request, env);
  }
  const secret = requiredExecutionSecret(env);
  const planId = validIdentifier(planIdValue, "planId");
  const evidence = await loadRssImportPlanEvidence(env.DB, planId);
  if (!evidence) return executionNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId: evidence.plan.show_id
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  if (evidence.plan.status !== "reviewed") {
    return executionConflict(
      request,
      env,
      "rss_import_plan_not_reviewed"
    );
  }

  const body = await readJsonObject(request, 20_000);
  requireExactKeys(body, [
    "executionId",
    "feedUrl",
    "expectedFeedSha256",
    "expectedSelectionSha256",
    "executionConfirmed",
    "items"
  ]);
  if (body.executionConfirmed !== true) {
    throw new RequestValidationError(
      "The private-copy and draft-creation execution must be confirmed.",
      "rss_import_execution_confirmation_required"
    );
  }
  const executionId = validIdentifier(body.executionId, "executionId");
  const feedUrl = requiredText(body.feedUrl, "feedUrl", 2_000);
  const expectedFeedSha256 = validSha256(
    body.expectedFeedSha256,
    "expectedFeedSha256"
  );
  const expectedSelectionSha256 = validSha256(
    body.expectedSelectionSha256,
    "expectedSelectionSha256"
  );
  if (
    evidence.plan.feed_sha256 !== expectedFeedSha256
    || evidence.plan.selection_sha256 !== expectedSelectionSha256
    || evidence.plan.requested_feed_url_sha256 !== await sha256Hex(feedUrl)
  ) {
    return executionConflict(request, env, "rss_import_plan_changed");
  }
  const requestedItems = executionRequestItems(body.items, evidence.items);
  const existing = await loadRssImportExecutionEvidence(env.DB, planId);
  if (existing) {
    if (
      existing.execution.id !== executionId
      || existing.execution.feed_url_sha256 !== await sha256Hex(feedUrl)
      || !sameExecutionMapping(existing.items, requestedItems)
    ) {
      return executionConflict(
        request,
        env,
        "rss_import_execution_conflict"
      );
    }
    await sendQueuedExecutionItems(env, executionId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      execution: presentExecution(existing.execution, existing.items),
      idempotent: true,
      publicationMutationPerformed: false,
      redirectMutationPerformed: false,
      providerContactPerformed: false
    });
  }

  await reconcileRssImportPlanSource(feedUrl, evidence);
  const show = await env.DB.prepare(
    `SELECT id, slug
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(evidence.plan.show_id).first<{
    id: string;
    slug: string;
  }>();
  if (!show) return executionNotFound(request, env);
  await ensureSlugsAvailable(
    env.DB,
    show.id,
    requestedItems.map(({ targetSlug }) => targetSlug)
  );
  const sealedFeedUrl = await sealSensitiveValue(
    feedUrl,
    executionId,
    secret,
    SOURCE_URL_CONTRACT
  );
  const executionItems = requestedItems.map((item, ordinal) => {
    const targetEpisodeId =
      `episode_${crypto.randomUUID().replace(/-/gu, "")}`;
    return {
      ...item,
      ordinal,
      targetEpisodeId,
      targetObjectKey: importedSourceObjectKey(
        env,
        show.id,
        targetEpisodeId,
        executionId,
        evidence.items.find(({ source_identity_sha256 }) =>
          source_identity_sha256 === item.sourceIdentitySha256
        )?.enclosure_mime_type ?? "audio/mpeg"
      )
    };
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rss_import_executions (
         id, plan_id, show_id, feed_url_ciphertext, feed_url_sha256,
         feed_sha256, selection_sha256, expected_item_count,
         requested_by_admin_user_id, source_url_expires_at
       )
       SELECT
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         datetime('now', '+${SOURCE_URL_RETENTION_DAYS} days')
       WHERE EXISTS (
         SELECT 1
         FROM rss_import_plans
         WHERE id = ? AND status = 'reviewed'
       )`
      ).bind(
        executionId,
        planId,
        show.id,
        sealedFeedUrl,
        await sha256Hex(feedUrl),
        evidence.plan.feed_sha256,
        evidence.plan.selection_sha256,
        executionItems.length,
        auth.authorization.identity.id,
        planId
      ),
      ...executionItems.map((item) =>
        env.DB.prepare(
          `INSERT INTO rss_import_execution_items (
           execution_id, plan_id, source_identity_sha256, ordinal,
           target_episode_id, target_slug, source_language,
           target_object_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          executionId,
          planId,
          item.sourceIdentitySha256,
          item.ordinal,
          item.targetEpisodeId,
          item.targetSlug,
          item.sourceLanguage,
          item.targetObjectKey
        )
      ),
      prepareAdminAudit(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "rss_import.execution_created",
        targetType: "rss_import_execution",
        targetId: executionId,
        metadata: {
          planId,
          showId: show.id,
          feedSha256: evidence.plan.feed_sha256,
          selectionSha256: evidence.plan.selection_sha256,
          expectedItemCount: executionItems.length,
          sourceUrlRetentionDays: SOURCE_URL_RETENTION_DAYS,
          publicationMutationPerformed: false
        }
      })
    ]);
  } catch (error) {
    const concurrent = await loadRssImportExecutionEvidence(env.DB, planId);
    if (concurrent) {
      if (
        concurrent.execution.id === executionId
        && concurrent.execution.feed_url_sha256 === await sha256Hex(feedUrl)
        && sameExecutionMapping(concurrent.items, requestedItems)
      ) {
        await sendQueuedExecutionItems(env, executionId);
        return privateJson(request, env.ALLOWED_ORIGINS, {
          execution: presentExecution(
            concurrent.execution,
            concurrent.items
          ),
          idempotent: true,
          publicationMutationPerformed: false,
          redirectMutationPerformed: false,
          providerContactPerformed: false
        });
      }
      return executionConflict(
        request,
        env,
        "rss_import_execution_conflict"
      );
    }
    const currentPlan = await env.DB.prepare(
      "SELECT status FROM rss_import_plans WHERE id = ?"
    ).bind(planId).first<{ status: string }>();
    if (currentPlan?.status !== "reviewed") {
      return executionConflict(
        request,
        env,
        "rss_import_plan_not_reviewed"
      );
    }
    throw error;
  }
  await sendQueuedExecutionItems(env, executionId);
  const created = await loadRssImportExecutionEvidence(env.DB, planId);
  if (!created) {
    return executionConflict(
      request,
      env,
      "rss_import_execution_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    execution: presentExecution(created.execution, created.items),
    idempotent: false,
    publicationMutationPerformed: false,
    redirectMutationPerformed: false,
    providerContactPerformed: false
  }, { status: 202 });
}

export async function getAdminRssImportExecution(
  request: Request,
  env: PodcastEnv,
  planIdValue: string
): Promise<Response> {
  const planId = validIdentifier(planIdValue, "planId");
  const evidence = await loadRssImportPlanEvidence(env.DB, planId);
  if (!evidence) return executionNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin", "admin", "producer", "analyst"],
    showId: evidence.plan.show_id
  });
  if (!auth.ok) return auth.response;
  const execution = await loadRssImportExecutionEvidence(env.DB, planId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    execution: execution
      ? presentExecution(execution.execution, execution.items)
      : null,
    executionAvailable: rssImportExecutionEnabled(env),
    publicationMutationPerformed: false,
    redirectMutationPerformed: false,
    providerContactPerformed: false
  });
}

export async function scheduleRssImportExecutions(
  env: PodcastEnv
): Promise<void> {
  if (!rssImportExecutionEnabled(env)) return;
  await env.DB.prepare(
    `UPDATE rss_import_execution_items
     SET
       status = 'failed',
       last_error_code = 'rss_import_worker_interrupted',
       completed_at = datetime('now')
     WHERE status = 'running'
       AND started_at <= datetime('now', '-15 minutes')`
  ).run();
  await env.DB.prepare(
    `UPDATE rss_import_executions
     SET
       feed_url_ciphertext = ?,
       last_error_code = 'rss_import_source_url_expired',
       updated_at = datetime('now')
     WHERE source_url_expires_at <= datetime('now')
       AND feed_url_ciphertext LIKE 'aes-gcm-v1:%'`
  ).bind(SOURCE_URL_EXPIRED).run();
  const executions = await env.DB.prepare(
    `SELECT DISTINCT execution_id
     FROM rss_import_execution_items
     WHERE status IN ('queued', 'failed')
       AND attempt_count < ?
       AND (
         queue_sent_at IS NULL
         OR queue_sent_at <= datetime('now', '-10 minutes')
       )
     ORDER BY execution_id
     LIMIT 25`
  ).bind(MAXIMUM_ATTEMPTS).all<{ execution_id: string }>();
  for (const { execution_id } of executions.results) {
    await sendQueuedExecutionItems(env, execution_id);
  }
  await refreshAllExecutionStates(env.DB);
}

export async function processRssImportExecutionItem(
  env: PodcastEnv,
  job: PodcastJob
): Promise<void> {
  if (
    !rssImportExecutionEnabled(env)
    || !job.rssImportExecutionId
    || !job.rssImportSourceIdentitySha256
  ) {
    throw new Error("rss_import_execution_job_disabled");
  }
  const secret = requiredExecutionSecret(env);
  const row = await loadProcessingRow(
    env.DB,
    job.rssImportExecutionId,
    job.rssImportSourceIdentitySha256
  );
  if (!row || row.status === "succeeded") return;
  if (
    row.show_id !== job.showId
    || row.plan_status !== "reviewed"
    || row.attempt_count >= MAXIMUM_ATTEMPTS
  ) {
    return;
  }
  if (
    row.feed_url_ciphertext === SOURCE_URL_EXPIRED
    || row.feed_url_ciphertext === SOURCE_URL_RETAINED
  ) {
    await failExecutionItem(
      env,
      row,
      "rss_import_source_url_unavailable"
    );
    return;
  }
  const claim = await env.DB.prepare(
    `UPDATE rss_import_execution_items
     SET
       status = 'running',
       attempt_count = attempt_count + 1,
       started_at = datetime('now'),
       completed_at = NULL,
       last_error_code = NULL
     WHERE execution_id = ?
       AND source_identity_sha256 = ?
       AND status IN ('queued', 'failed')
       AND attempt_count < ?`
  ).bind(
    row.execution_id,
    row.source_identity_sha256,
    MAXIMUM_ATTEMPTS
  ).run();
  if (Number(claim.meta.changes ?? 0) !== 1) return;
  await env.DB.prepare(
    `UPDATE rss_import_executions
     SET
       status = 'running',
       started_at = COALESCE(started_at, datetime('now')),
       completed_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(row.execution_id).run();

  let copied = false;
  try {
    const feedUrl = await openSensitiveValue(
      row.feed_url_ciphertext,
      row.execution_id,
      secret,
      SOURCE_URL_CONTRACT
    );
    if (!feedUrl || await sha256Hex(feedUrl) !== row.feed_url_sha256) {
      throw executionError("rss_import_source_url_unavailable");
    }
    const evidence = await loadRssImportPlanEvidence(env.DB, row.plan_id);
    if (!evidence) throw executionError("rss_import_plan_not_found");
    const reconciled = await reconcileRssImportPlanSource(feedUrl, evidence);
    const source = reconciled.preview.episodes.find(({ sourceIdentitySha256 }) =>
      sourceIdentitySha256 === row.source_identity_sha256
    );
    if (
      !source?.migrationReady
      || !source.enclosure.url
      || source.enclosure.bytes !== row.plan_item_enclosure_bytes
      || source.enclosure.mimeType !== row.plan_item_enclosure_mime_type
      || await sha256Hex(source.enclosure.url)
        !== row.plan_item_enclosure_url_sha256
    ) {
      throw executionError("rss_import_source_item_changed");
    }
    const copiedAudio = await copySourceAudio(
      env,
      row,
      source.enclosure.url,
      source.enclosure.mimeType,
      source.enclosure.bytes
    );
    copied = true;
    const uploadId = importUploadId(row.target_episode_id);
    const filename = `${row.target_slug}.${
      extensionForMimeType(copiedAudio.mimeType)
    }`;
    const canonicalUrl = `${env.SITE_ORIGIN.replace(/\/$/u, "")}`
      + `/news/podcasts/${row.show_slug}/${row.target_slug}/`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO episodes (
           id, show_id, slug, title, summary, content_html,
           status, access, public_at, canonical_url, guid,
           source_audio_key, duration_seconds, explicit,
           media_status, source_language
         ) VALUES (
           ?, ?, ?, ?, ?, '', 'draft', 'public', ?, ?, ?,
           ?, ?, ?, 'processing', ?
         )`
      ).bind(
        row.target_episode_id,
        row.show_id,
        row.target_slug,
        row.plan_item_title,
        row.plan_item_summary,
        row.plan_item_published_at,
        canonicalUrl,
        `urn:dustwave:rss-import:${row.source_identity_sha256}`,
        row.target_object_key,
        row.plan_item_duration_seconds,
        row.plan_item_explicit === 1 ? 1 : 0,
        row.source_language
      ),
      env.DB.prepare(
        `INSERT INTO media_uploads (
           id, show_id, episode_id, kind, object_key, r2_upload_id,
           filename, content_type, expected_bytes, status,
           completed_bytes, object_etag, initiated_by_admin_user_id,
           completed_at
         ) VALUES (
           ?, ?, ?, 'source_audio', ?, ?, ?, ?, ?, 'completed',
           ?, ?, ?, datetime('now')
         )`
      ).bind(
        uploadId,
        row.show_id,
        row.target_episode_id,
        row.target_object_key,
        `rss-import:${row.execution_id}`,
        filename,
        copiedAudio.mimeType,
        copiedAudio.bytes,
        copiedAudio.bytes,
        copiedAudio.etag,
        row.requested_by_admin_user_id
      ),
      env.DB.prepare(
        `UPDATE rss_import_execution_items
         SET
           status = 'succeeded',
           response_resolved_url_sha256 = ?,
           copied_bytes = ?,
           copied_sha256 = ?,
           copied_etag = ?,
           copied_mime_type = ?,
           episode_id = target_episode_id,
           last_error_code = NULL,
           completed_at = datetime('now')
         WHERE execution_id = ?
           AND source_identity_sha256 = ?
           AND status = 'running'`
      ).bind(
        copiedAudio.resolvedUrlSha256,
        copiedAudio.bytes,
        copiedAudio.sha256,
        copiedAudio.etag,
        copiedAudio.mimeType,
        row.execution_id,
        row.source_identity_sha256
      ),
      prepareAdminAudit(env.DB, {
        adminUserId: row.requested_by_admin_user_id,
        action: "rss_import.item_succeeded",
        targetType: "episode",
        targetId: row.target_episode_id,
        metadata: {
          executionId: row.execution_id,
          planId: row.plan_id,
          showId: row.show_id,
          sourceIdentitySha256: row.source_identity_sha256,
          sourceMetadataSha256: row.plan_item_metadata_sha256,
          copiedBytes: copiedAudio.bytes,
          copiedSha256: copiedAudio.sha256,
          copiedMimeType: copiedAudio.mimeType,
          episodeStatus: "draft",
          mediaStatus: "processing",
          publicationMutationPerformed: false
        }
      })
    ]);
    await refreshExecutionState(env.DB, row.execution_id);
  } catch (error) {
    if (copied) {
      await bestEffortDelete(env.MEDIA_BUCKET, row.target_object_key);
    }
    const code = stableExecutionError(error);
    await failExecutionItem(env, row, code);
    throw error;
  }
}

async function copySourceAudio(
  env: PodcastEnv,
  row: ProcessingRow,
  requestedUrl: string,
  expectedMimeType: string,
  expectedBytes: number
): Promise<CopiedAudio> {
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes < 1
    || expectedBytes > MAXIMUM_AUDIO_BYTES
  ) {
    throw executionError("rss_import_audio_size_unsupported");
  }
  const source = await fetchImportAudio(
    requestedUrl,
    expectedMimeType,
    expectedBytes
  );
  if (!source.response.body) {
    throw executionError("rss_import_audio_body_missing");
  }
  let observedBytes = 0;
  const counted = source.response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedBytes += chunk.byteLength;
        if (observedBytes > expectedBytes) {
          throw executionError("rss_import_audio_size_mismatch");
        }
        controller.enqueue(chunk);
      }
    })
  );
  const [storageBody, digestBody] = counted.tee();
  const digestStream = new crypto.DigestStream("SHA-256");
  const digestCompletion = digestBody.pipeTo(digestStream);
  const [putResult, pipeResult, digestResult] = await Promise.allSettled([
    env.MEDIA_BUCKET.put(row.target_object_key, storageBody, {
        httpMetadata: { contentType: expectedMimeType },
        customMetadata: {
          kind: "rss_import_source_audio",
          executionId: row.execution_id,
          planId: row.plan_id,
          episodeId: row.target_episode_id,
          sourceIdentitySha256: row.source_identity_sha256
        }
      }),
    digestCompletion,
    digestStream.digest
  ]);
  if (
    putResult.status === "rejected"
    || pipeResult.status === "rejected"
    || digestResult.status === "rejected"
  ) {
    await bestEffortDelete(env.MEDIA_BUCKET, row.target_object_key);
    if ([putResult, pipeResult, digestResult].some((result) =>
      result.status === "rejected"
      && result.reason instanceof Error
      && result.reason.message === "rss_import_audio_size_mismatch"
    )) {
      throw executionError("rss_import_audio_size_mismatch");
    }
    throw executionError("rss_import_audio_copy_failed");
  }
  const object = putResult.value;
  const digest = digestResult.value;
  if (
    !object
    || observedBytes !== expectedBytes
    || object.size !== expectedBytes
  ) {
    await bestEffortDelete(env.MEDIA_BUCKET, row.target_object_key);
    throw executionError("rss_import_audio_size_mismatch");
  }
  return {
    bytes: observedBytes,
    sha256: bytesToHex(digest),
    etag: object.httpEtag,
    mimeType: expectedMimeType,
    resolvedUrlSha256: await sha256Hex(source.resolvedUrl)
  };
}

async function bestEffortDelete(
  bucket: R2Bucket,
  objectKey: string
): Promise<void> {
  try {
    await bucket.delete(objectKey);
  } catch {
    // The deterministic private key is overwritten by a retry and is never
    // exposed through public media delivery before the D1 batch succeeds.
  }
}

async function fetchImportAudio(
  requestedUrl: string,
  expectedMimeType: string,
  expectedBytes: number
): Promise<{ response: Response; resolvedUrl: string }> {
  let currentUrl = requestedUrl;
  const visited = new Set<string>();
  for (
    let redirectCount = 0;
    redirectCount <= MAXIMUM_AUDIO_REDIRECTS;
    redirectCount += 1
  ) {
    if (visited.has(currentUrl)) {
      throw executionError("rss_import_audio_redirect_loop");
    }
    visited.add(currentUrl);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(AUDIO_COPY_TIMEOUT_MS),
        headers: {
          accept: `${expectedMimeType}, audio/*;q=0.8`,
          "user-agent": "DustWavePodcastMigration/1.0"
        }
      });
    } catch {
      throw executionError("rss_import_audio_fetch_failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= MAXIMUM_AUDIO_REDIRECTS) {
        throw executionError("rss_import_audio_redirect_limit");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw executionError("rss_import_audio_redirect_invalid");
      }
      try {
        currentUrl = validatedSourceUrl(
          new URL(location, currentUrl).toString()
        );
      } catch {
        throw executionError("rss_import_audio_redirect_invalid");
      }
      await response.body?.cancel();
      continue;
    }
    if (response.status !== 200) {
      throw executionError("rss_import_audio_response_not_successful");
    }
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).split(";", 1)[0].trim().toLowerCase();
    if (contentType !== expectedMimeType) {
      throw executionError("rss_import_audio_content_type_changed");
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = Number(contentLengthHeader);
    if (
      contentLengthHeader !== null
      && Number.isSafeInteger(contentLength)
      && contentLength >= 0
      && contentLength !== expectedBytes
    ) {
      throw executionError("rss_import_audio_size_mismatch");
    }
    return { response, resolvedUrl: currentUrl };
  }
  throw executionError("rss_import_audio_redirect_limit");
}

function validatedSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw executionError("rss_import_audio_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hash
    || hostname.length > 253
    || !hostname.includes(".")
    || hostname === "metadata.google.internal"
    || hostname.includes(":")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)
    || [
      ".example", ".home", ".internal", ".invalid", ".lan", ".local",
      ".localhost", ".test"
    ].some((suffix) => hostname.endsWith(suffix))
  ) {
    throw executionError("rss_import_audio_url_invalid");
  }
  return url.toString();
}

async function sendQueuedExecutionItems(
  env: PodcastEnv,
  executionId: string
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT item.source_identity_sha256, execution.show_id
     FROM rss_import_execution_items item
     JOIN rss_import_executions execution
       ON execution.id = item.execution_id
     WHERE item.execution_id = ?
       AND item.status IN ('queued', 'failed')
       AND item.attempt_count < ?
       AND execution.feed_url_ciphertext LIKE 'aes-gcm-v1:%'
       AND (
         item.queue_sent_at IS NULL
         OR item.queue_sent_at <= datetime('now', '-10 minutes')
       )
     ORDER BY item.ordinal
     LIMIT 25`
  ).bind(executionId, MAXIMUM_ATTEMPTS).all<{
    source_identity_sha256: string;
    show_id: string;
  }>();
  for (const row of rows.results) {
    try {
      await env.JOBS.send({
        id: `rss_import_${executionId}_${
          row.source_identity_sha256.slice(0, 16)
        }`,
        type: "execute-rss-import-item",
        showId: row.show_id,
        rssImportExecutionId: executionId,
        rssImportSourceIdentitySha256: row.source_identity_sha256,
        requestedAt: new Date().toISOString()
      });
      await env.DB.prepare(
        `UPDATE rss_import_execution_items
         SET queue_sent_at = datetime('now')
         WHERE execution_id = ? AND source_identity_sha256 = ?`
      ).bind(executionId, row.source_identity_sha256).run();
    } catch {
      // Durable queued state remains eligible for the scheduled dispatcher.
    }
  }
}

async function failExecutionItem(
  env: PodcastEnv,
  row: Pick<
    ProcessingRow,
    | "execution_id"
    | "source_identity_sha256"
    | "target_episode_id"
    | "requested_by_admin_user_id"
    | "plan_id"
    | "show_id"
  >,
  code: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE rss_import_execution_items
     SET
       status = 'failed',
       last_error_code = ?,
       completed_at = datetime('now')
     WHERE execution_id = ?
       AND source_identity_sha256 = ?
       AND status != 'succeeded'`
  ).bind(code, row.execution_id, row.source_identity_sha256).run();
  await refreshExecutionState(env.DB, row.execution_id);
  await recordAdminAudit(env.DB, {
    adminUserId: row.requested_by_admin_user_id,
    action: "rss_import.item_failed",
    targetType: "rss_import_execution",
    targetId: row.execution_id,
    metadata: {
      planId: row.plan_id,
      showId: row.show_id,
      sourceIdentitySha256: row.source_identity_sha256,
      targetEpisodeId: row.target_episode_id,
      failureCode: code,
      publicationMutationPerformed: false
    }
  });
}

async function refreshAllExecutionStates(db: D1Database): Promise<void> {
  const rows = await db.prepare(
    `SELECT id FROM rss_import_executions
     WHERE status IN ('queued', 'running', 'partial', 'failed')
     LIMIT 100`
  ).all<{ id: string }>();
  for (const { id } of rows.results) await refreshExecutionState(db, id);
}

async function refreshExecutionState(
  db: D1Database,
  executionId: string
): Promise<void> {
  await db.prepare(
    `UPDATE rss_import_executions
     SET
       copied_item_count = (
         SELECT COUNT(*)
         FROM rss_import_execution_items
         WHERE execution_id = ? AND status = 'succeeded'
       ),
       draft_item_count = (
         SELECT COUNT(*)
         FROM rss_import_execution_items
         WHERE execution_id = ?
           AND status = 'succeeded'
           AND episode_id IS NOT NULL
       ),
       failed_item_count = (
         SELECT COUNT(*)
         FROM rss_import_execution_items
         WHERE execution_id = ? AND status = 'failed'
       ),
       status = CASE
         WHEN (
           SELECT COUNT(*)
           FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'succeeded'
         ) = expected_item_count THEN 'succeeded'
         WHEN EXISTS (
           SELECT 1 FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'running'
         ) THEN 'running'
         WHEN EXISTS (
           SELECT 1 FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'queued'
         ) THEN 'queued'
         WHEN EXISTS (
           SELECT 1 FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'succeeded'
         ) THEN 'partial'
         ELSE 'failed'
       END,
       completed_at = CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM rss_import_execution_items
           WHERE execution_id = ? AND status IN ('queued', 'running')
         ) THEN datetime('now')
         ELSE NULL
       END,
       feed_url_ciphertext = CASE
         WHEN (
           SELECT COUNT(*)
           FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'succeeded'
         ) = expected_item_count THEN ?
         ELSE feed_url_ciphertext
       END,
       last_error_code = CASE
         WHEN EXISTS (
           SELECT 1 FROM rss_import_execution_items
           WHERE execution_id = ? AND status = 'failed'
         ) THEN 'rss_import_item_failed'
         ELSE NULL
       END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    executionId,
    executionId,
    executionId,
    executionId,
    executionId,
    executionId,
    executionId,
    executionId,
    executionId,
    SOURCE_URL_RETAINED,
    executionId,
    executionId
  ).run();
}

export async function loadRssImportExecutionEvidence(
  db: D1Database,
  planId: string
): Promise<{
  execution: RssImportExecutionRow;
  items: RssImportExecutionItemRow[];
} | null> {
  const execution = await db.prepare(
    `SELECT
       id, plan_id, show_id, feed_url_ciphertext, feed_url_sha256,
       feed_sha256, selection_sha256, status, expected_item_count,
       copied_item_count, draft_item_count, failed_item_count,
       requested_by_admin_user_id, source_url_expires_at,
       last_error_code, requested_at, started_at, completed_at, updated_at
     FROM rss_import_executions
     WHERE plan_id = ?`
  ).bind(planId).first<RssImportExecutionRow>();
  if (!execution) return null;
  return {
    execution,
    items: await loadExecutionItems(db, execution.id)
  };
}

async function loadExecutionItems(
  db: D1Database,
  executionId: string
): Promise<RssImportExecutionItemRow[]> {
  const rows = await db.prepare(
    `SELECT
       execution_id, plan_id, source_identity_sha256, ordinal,
       target_episode_id, target_slug, source_language, target_object_key,
       status, attempt_count, queue_sent_at, started_at, completed_at,
       response_resolved_url_sha256, copied_bytes, copied_sha256,
       copied_etag, copied_mime_type, episode_id, last_error_code
     FROM rss_import_execution_items
     WHERE execution_id = ?
     ORDER BY ordinal`
  ).bind(executionId).all<RssImportExecutionItemRow>();
  return rows.results;
}

async function loadProcessingRow(
  db: D1Database,
  executionId: string,
  sourceIdentitySha256: string
): Promise<ProcessingRow | null> {
  return db.prepare(
    `SELECT
       item.execution_id, item.plan_id, item.source_identity_sha256,
       item.ordinal, item.target_episode_id, item.target_slug,
       item.source_language, item.target_object_key,
       item.status, item.attempt_count, item.queue_sent_at,
       item.started_at, item.completed_at,
       item.response_resolved_url_sha256, item.copied_bytes,
       item.copied_sha256, item.copied_etag, item.copied_mime_type,
       item.episode_id, item.last_error_code,
       execution.show_id, execution.feed_url_ciphertext,
       execution.feed_url_sha256,
       execution.requested_by_admin_user_id,
       plan.status AS plan_status,
       plan_item.title AS plan_item_title,
       plan_item.summary AS plan_item_summary,
       plan_item.published_at AS plan_item_published_at,
       plan_item.duration_seconds AS plan_item_duration_seconds,
       plan_item.explicit AS plan_item_explicit,
       plan_item.metadata_sha256 AS plan_item_metadata_sha256,
       plan_item.enclosure_url_sha256 AS plan_item_enclosure_url_sha256,
       plan_item.enclosure_mime_type AS plan_item_enclosure_mime_type,
       plan_item.enclosure_bytes AS plan_item_enclosure_bytes,
       show_record.slug AS show_slug
     FROM rss_import_execution_items item
     JOIN rss_import_executions execution
       ON execution.id = item.execution_id
     JOIN rss_import_plans plan ON plan.id = execution.plan_id
     JOIN rss_import_plan_items plan_item
       ON plan_item.plan_id = item.plan_id
      AND plan_item.source_identity_sha256 = item.source_identity_sha256
     JOIN shows show_record ON show_record.id = execution.show_id
     WHERE item.execution_id = ?
       AND item.source_identity_sha256 = ?`
  ).bind(executionId, sourceIdentitySha256).first<ProcessingRow>();
}

function executionRequestItems(
  value: unknown,
  planItems: ImportPlanItemRow[]
): ExecutionRequestItem[] {
  if (!Array.isArray(value) || value.length !== planItems.length) {
    throw new RequestValidationError(
      "Execution items must map every selected plan item exactly once.",
      "rss_import_execution_mapping_invalid"
    );
  }
  const expected = new Set(
    planItems.map(({ source_identity_sha256 }) => source_identity_sha256)
  );
  const slugs = new Set<string>();
  const identities = new Set<string>();
  const items = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RequestValidationError(
        `items[${index}] must be an object`
      );
    }
    const item = candidate as Record<string, unknown>;
    requireExactKeys(item, [
      "sourceIdentitySha256",
      "targetSlug",
      "sourceLanguage"
    ]);
    const sourceIdentitySha256 = validSha256(
      item.sourceIdentitySha256,
      `items[${index}].sourceIdentitySha256`
    );
    const targetSlug = validSlug(
      item.targetSlug,
      `items[${index}].targetSlug`
    );
    const sourceLanguage = requiredText(
      item.sourceLanguage,
      `items[${index}].sourceLanguage`,
      2
    );
    if (!["en", "es"].includes(sourceLanguage)) {
      throw new RequestValidationError(
        `items[${index}].sourceLanguage must be en or es`
      );
    }
    if (
      !expected.has(sourceIdentitySha256)
      || identities.has(sourceIdentitySha256)
      || slugs.has(targetSlug)
    ) {
      throw new RequestValidationError(
        "Execution identities and target slugs must be exact and unique.",
        "rss_import_execution_mapping_invalid"
      );
    }
    identities.add(sourceIdentitySha256);
    slugs.add(targetSlug);
    return {
      sourceIdentitySha256,
      targetSlug,
      sourceLanguage: sourceLanguage as "en" | "es"
    };
  });
  if (identities.size !== expected.size) {
    throw new RequestValidationError(
      "Execution mapping does not match the reviewed selection.",
      "rss_import_execution_mapping_invalid"
    );
  }
  return items;
}

async function ensureSlugsAvailable(
  db: D1Database,
  showId: string,
  slugs: string[]
): Promise<void> {
  const placeholders = slugs.map(() => "?").join(", ");
  const existing = await db.prepare(
    `SELECT slug FROM episodes
     WHERE show_id = ? AND slug IN (${placeholders})
     LIMIT 1`
  ).bind(showId, ...slugs).first<{ slug: string }>();
  if (existing) {
    throw new RequestValidationError(
      "A target episode slug is already in use.",
      "rss_import_target_slug_conflict",
      409
    );
  }
}

function sameExecutionMapping(
  stored: RssImportExecutionItemRow[],
  expected: ExecutionRequestItem[]
): boolean {
  const expectedByIdentity = new Map(expected.map((item) => [
    item.sourceIdentitySha256,
    item
  ]));
  return stored.length === expected.length
    && stored.every((item) => {
      const candidate = expectedByIdentity.get(
        item.source_identity_sha256
      );
      return candidate?.targetSlug === item.target_slug
        && candidate.sourceLanguage === item.source_language;
    });
}

function presentExecution(
  execution: RssImportExecutionRow,
  items: RssImportExecutionItemRow[]
): Record<string, unknown> {
  return {
    id: execution.id,
    planId: execution.plan_id,
    showId: execution.show_id,
    status: execution.status,
    expectedItemCount: execution.expected_item_count,
    copiedItemCount: execution.copied_item_count,
    draftItemCount: execution.draft_item_count,
    failedItemCount: execution.failed_item_count,
    sourceUrlRetained:
      execution.feed_url_ciphertext.startsWith("aes-gcm-v1:"),
    sourceUrlExpiresAt: execution.source_url_expires_at,
    lastErrorCode: execution.last_error_code,
    items: items.map((item) => ({
      sourceIdentitySha256: item.source_identity_sha256,
      ordinal: item.ordinal,
      targetEpisodeId: item.target_episode_id,
      targetSlug: item.target_slug,
      sourceLanguage: item.source_language,
      status: item.status,
      attemptCount: item.attempt_count,
      copiedBytes: item.copied_bytes,
      copiedSha256: item.copied_sha256,
      copiedMimeType: item.copied_mime_type,
      episodeId: item.episode_id,
      lastErrorCode: item.last_error_code,
      completedAt: item.completed_at
    })),
    requestedAt: execution.requested_at,
    startedAt: execution.started_at,
    completedAt: execution.completed_at,
    updatedAt: execution.updated_at
  };
}

function importedSourceObjectKey(
  env: PodcastEnv,
  showId: string,
  episodeId: string,
  executionId: string,
  mimeType: string
): string {
  return [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/gu, ""),
    showId,
    episodeId,
    "source_audio",
    `rss-import-${executionId}.${extensionForMimeType(mimeType)}`
  ].join("/");
}

function importUploadId(
  targetEpisodeId: string
): string {
  return `upload_rss_${targetEpisodeId}`;
}

function extensionForMimeType(value: string): string {
  return {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-flac": "flac",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav"
  }[value] ?? "audio";
}

export function rssImportExecutionEnabled(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && env.RSS_IMPORT_EXECUTION_MODE === EXECUTION_MODE;
}

function requiredExecutionSecret(env: PodcastEnv): string {
  const secret = env.RSS_IMPORT_URL_SECRET || "";
  if (secret.length < 32) {
    throw new Error("rss_import_url_secret_not_configured");
  }
  return secret;
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
      "The RSS import execution request has unsupported fields."
    );
  }
}

function executionError(code: string): Error {
  const error = new Error(code);
  error.name = "RssImportExecutionError";
  return error;
}

function stableExecutionError(error: unknown): string {
  if (error instanceof RequestValidationError) return error.code;
  if (
    error instanceof Error
    && /^[a-z0-9_]{1,120}$/u.test(error.message)
  ) {
    return error.message;
  }
  return "rss_import_execution_failed";
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function executionNotFound(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rss_import_execution_not_found" },
    { status: 404 }
  );
}

function executionUnavailable(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rss_import_execution_unavailable" },
    { status: 404 }
  );
}

function executionConflict(
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
