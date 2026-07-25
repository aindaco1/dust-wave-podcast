import {
  AUDIO_ENHANCEMENT_PRESETS,
  audioEnhancementReportSha256,
  buildAudioEnhancementManifest,
  validateAudioEnhancementRecipe,
  validateAudioEnhancementReport,
  type AudioEnhancementManifest,
  type AudioEnhancementRecipe,
  type AudioEnhancementReport
} from "@dustwave/media-core/audio-enhancement";
import type {
  AudioQcPolicy,
  AudioQcReport
} from "@dustwave/media-core/audio-qc";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import {
  privateCorsHeaders,
  privateJson
} from "./http";
import {
  requestedMediaRange,
  safeDownloadFilename
} from "./media-range";
import {
  readSignedJsonBody,
  verifySignedText
} from "./signed-callback";
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
const APPROVE_ROLES: AdminRole[] = ["super_admin"];
const PROCESSOR_UPLOAD_PAYLOAD_HEADER =
  "x-podcast-processor-upload-payload";
const MAXIMUM_CALLBACK_BYTES = 125_000;
const MAXIMUM_OUTPUT_BYTES = 40 * 1024 * 1024;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "render_failed",
  "output_invalid"
]);

type WorkingMasterStateRow = {
  episode_id: string;
  revision: number;
  current_master_id: string | null;
  updated_at: string;
};

type WorkingMasterRow = {
  id: string;
  episode_id: string;
  revision: number;
  origin_kind: "source_original" | "enhanced_derivative";
  source_upload_id: string;
  quality_control_run_id: string;
  object_key: string;
  object_bytes: number;
  object_etag: string;
  mime_type: string;
  source_sha256: string;
  quality_control_report_sha256: string;
  approval_reason: string;
  approved_by_admin_user_id: string | null;
  approved_at: string;
};

type EligibleQualityControlRow = {
  id: string;
  episode_id: string;
  show_id: string;
  source_upload_id: string;
  source_filename: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  report_json: string;
  report_sha256: string;
  blocker_count: 0;
  warning_count: number;
  duration_ms: number;
  policy_revision: number;
  policy_json: string;
  current_policy_revision: number;
};

type AudioEnhancementPreviewRow = {
  id: string;
  episode_id: string;
  show_id?: string;
  source_upload_id: string;
  quality_control_run_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_sha256: string;
  quality_control_report_sha256: string;
  recipe_json: string;
  recipe_sha256: string;
  processor_manifest_sha256: string;
  original_object_key: string;
  enhanced_object_key: string;
  status: string;
  original_object_bytes: number | null;
  original_sha256: string | null;
  original_duration_ms: number | null;
  enhanced_object_bytes: number | null;
  enhanced_sha256: string | null;
  enhanced_duration_ms: number | null;
  processor_version: string | null;
  processor_report_json: string | null;
  processor_report_sha256: string | null;
  failure_code: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type ProcessorUploadPayload = {
  jobId: string;
  kind: "original" | "enhanced";
  manifestSha256: string;
  objectBytes: number;
  sha256: string;
};

export async function getAdminEpisodeAudioMaster(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    READ_ROLES
  );
  if (access instanceof Response) return access;
  const [state, masters, eligible, previews] = await Promise.all([
    loadWorkingMasterState(env.DB, access.episode.id),
    env.DB.prepare(
      `SELECT
         id, episode_id, revision, origin_kind, source_upload_id,
         quality_control_run_id, object_key, object_bytes, object_etag,
         mime_type, source_sha256, quality_control_report_sha256,
         approval_reason, approved_by_admin_user_id, approved_at
       FROM episode_working_masters
       WHERE episode_id = ?
       ORDER BY revision DESC
       LIMIT 20`
    ).bind(access.episode.id).all<WorkingMasterRow>(),
    loadLatestEligibleQualityControl(env.DB, access.episode.id),
    env.DB.prepare(
      `${previewSelect()}
       WHERE preview.episode_id = ?
       ORDER BY preview.requested_at DESC, preview.id DESC
       LIMIT 20`
    ).bind(access.episode.id).all<AudioEnhancementPreviewRow>()
  ]);
  if (!state) {
    return masterConflict(request, env, "working_master_state_not_found");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    state: {
      revision: state.revision,
      currentMasterId: state.current_master_id,
      updatedAt: state.updated_at
    },
    current: masters.results.find(
      ({ id }) => id === state.current_master_id
    )
      ? presentMaster(
          masters.results.find(
            ({ id }) => id === state.current_master_id
          ) as WorkingMasterRow,
          true
        )
      : null,
    history: masters.results.map((master) =>
      presentMaster(master, master.id === state.current_master_id)
    ),
    eligibleSource: eligible
      ? {
          qualityControlRunId: eligible.id,
          sourceUploadId: eligible.source_upload_id,
          filename: eligible.source_filename,
          objectBytes: eligible.source_object_bytes,
          mimeType: eligible.source_mime_type,
          sourceSha256: eligible.source_sha256,
          qualityControlReportSha256: eligible.report_sha256,
          warningCount: eligible.warning_count,
          durationMs: eligible.duration_ms,
          policyRevision: eligible.policy_revision
        }
      : null,
    previews: previews.results.map(presentPreview),
    presets: Object.values(AUDIO_ENHANCEMENT_PRESETS),
    safeguards: {
      sourceApprovalRole: "super_admin",
      enhancementPreviewIsMaster: false,
      replacementInvalidatesDerivedApprovals: true
    },
    processor: {
      available: env.ENVIRONMENT === "staging"
        && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET),
      mode: env.ENVIRONMENT === "staging"
        ? "staging_manual"
        : "unavailable"
    }
  });
}

export async function approveAdminEpisodeSourceMaster(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    APPROVE_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const body = await readJsonObject(request, 20_000);
  const masterId = validIdentifier(body.masterId, "masterId");
  const qualityControlRunId = validIdentifier(
    body.qualityControlRunId,
    "qualityControlRunId"
  );
  const baseRevision = nonNegativeInteger(
    body.baseRevision,
    "baseRevision"
  );
  const approvalReason = requiredText(
    body.approvalReason,
    "approvalReason",
    500
  );
  if (body.acknowledgeExactSource !== true) {
    throw new RequestValidationError(
      "acknowledgeExactSource must be true"
    );
  }
  const existing = await loadWorkingMaster(env.DB, masterId);
  if (existing) {
    if (
      existing.episode_id !== access.episode.id
      || existing.quality_control_run_id !== qualityControlRunId
      || existing.revision !== baseRevision + 1
    ) {
      return masterConflict(request, env, "working_master_id_conflict");
    }
    const state = await loadWorkingMasterState(
      env.DB,
      access.episode.id
    );
    return privateJson(request, env.ALLOWED_ORIGINS, {
      state: state ? presentState(state) : null,
      master: presentMaster(
        existing,
        state?.current_master_id === existing.id
      ),
      idempotent: true
    });
  }
  const [state, qualityControl] = await Promise.all([
    loadWorkingMasterState(env.DB, access.episode.id),
    loadEligibleQualityControl(
      env.DB,
      access.episode.id,
      qualityControlRunId
    )
  ]);
  if (!state || state.revision !== baseRevision) {
    return masterConflict(
      request,
      env,
      "working_master_revision_conflict",
      { currentRevision: state?.revision ?? null }
    );
  }
  if (!qualityControl) {
    return masterConflict(
      request,
      env,
      "working_master_quality_control_not_current"
    );
  }
  const source = await env.MEDIA_BUCKET.head(
    qualityControl.source_object_key
  );
  if (
    !source
    || source.size !== qualityControl.source_object_bytes
    || source.httpEtag !== qualityControl.source_object_etag
    || source.httpMetadata?.contentType !== qualityControl.source_mime_type
  ) {
    return masterConflict(
      request,
      env,
      "working_master_source_mismatch"
    );
  }
  const nextRevision = baseRevision + 1;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const approvalGuardId =
    `master_guard_${crypto.randomUUID().replace(/-/g, "")}`;
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
      `INSERT OR IGNORE INTO episode_working_masters (
         id, episode_id, revision, origin_kind, source_upload_id,
         quality_control_run_id, object_key, object_bytes, object_etag,
         mime_type, source_sha256, quality_control_report_sha256,
         approval_reason, approved_by_admin_user_id
       )
       SELECT
         ?, state.episode_id, ?, 'source_original', q.source_upload_id,
         q.id, q.source_object_key, q.source_object_bytes,
         q.source_object_etag, q.source_mime_type, q.source_sha256,
         q.report_sha256, ?, ?
       FROM episode_working_master_states state
       JOIN episodes episode ON episode.id = state.episode_id
       JOIN audio_qc_runs q
         ON q.id = ?
        AND q.episode_id = episode.id
        AND q.status = 'succeeded'
        AND q.blocker_count = 0
        AND q.source_object_key = episode.source_audio_key
       JOIN media_uploads upload
         ON upload.id = q.source_upload_id
        AND upload.episode_id = episode.id
        AND upload.kind = 'source_audio'
        AND upload.status = 'completed'
        AND upload.object_key = q.source_object_key
        AND upload.object_etag = q.source_object_etag
        AND upload.completed_bytes = q.source_object_bytes
       JOIN show_audio_qc_policies policy
         ON policy.show_id = episode.show_id
        AND policy.revision = q.policy_revision
       WHERE state.episode_id = ?
         AND state.revision = ?
         AND q.source_sha256 IS NOT NULL
         AND q.report_sha256 IS NOT NULL`
    ).bind(
      masterId,
      nextRevision,
      approvalReason,
      access.authorization.identity.id,
      qualityControlRunId,
      access.episode.id,
      baseRevision
      ),
      env.DB.prepare(
      `UPDATE episode_working_master_states
       SET
         revision = ?,
         current_master_id = ?,
         updated_at = datetime('now')
       WHERE episode_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM episode_working_masters master
           WHERE master.id = ?
             AND master.episode_id = episode_working_master_states.episode_id
             AND master.revision = ?
         )`
    ).bind(
      nextRevision,
      masterId,
      access.episode.id,
      baseRevision,
      masterId,
      nextRevision
      ),
      env.DB.prepare(
        `INSERT INTO publication_batch_guards (id, update_succeeded)
         VALUES (?, changes())`
      ).bind(approvalGuardId),
      env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'working_master.source_approved',
         'working_master', ?, ?
       FROM episode_working_master_states
       WHERE episode_id = ?
         AND revision = ?
         AND current_master_id = ?`
      ).bind(
        auditId,
        access.authorization.identity.id,
        masterId,
        JSON.stringify({
          episodeId: access.episode.id,
          baseRevision,
          revision: nextRevision,
          qualityControlRunId,
          sourceSha256: qualityControl.source_sha256,
          qualityControlReportSha256: qualityControl.report_sha256,
          originKind: "source_original",
          invalidatedPriorDerivedApprovals: baseRevision > 0
        }),
        access.episode.id,
        nextRevision,
        masterId
      ),
      env.DB.prepare(
        `DELETE FROM publication_batch_guards
         WHERE id = ?`
      ).bind(approvalGuardId)
    ]);
  } catch (error) {
    const message = String(error);
    if (
      message.includes("publication_batch_guards")
      || message.includes("update_succeeded")
    ) {
      return masterConflict(
        request,
        env,
        "working_master_approval_conflict",
        {
          currentRevision: (
            await loadWorkingMasterState(env.DB, access.episode.id)
          )?.revision ?? null
        }
      );
    }
    throw error;
  }
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || Number(results[1]?.meta?.changes ?? 0) !== 1
  ) {
    return masterConflict(
      request,
      env,
      "working_master_approval_conflict",
      {
        currentRevision: (
          await loadWorkingMasterState(env.DB, access.episode.id)
        )?.revision ?? null
      }
    );
  }
  const [approved, currentState] = await Promise.all([
    loadWorkingMaster(env.DB, masterId),
    loadWorkingMasterState(env.DB, access.episode.id)
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    state: currentState ? presentState(currentState) : null,
    master: approved ? presentMaster(approved, true) : null,
    idempotent: false
  });
}

export async function queueAdminAudioEnhancementPreview(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const body = await readJsonObject(request, 20_000);
  const jobId = validIdentifier(body.jobId, "jobId");
  const qualityControlRunId = validIdentifier(
    body.qualityControlRunId,
    "qualityControlRunId"
  );
  const qualityControl = await loadEligibleQualityControl(
    env.DB,
    access.episode.id,
    qualityControlRunId
  );
  if (!qualityControl) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_quality_control_not_current"
    );
  }
  const report = JSON.parse(qualityControl.report_json) as AudioQcReport;
  const policy = JSON.parse(qualityControl.policy_json) as AudioQcPolicy;
  let recipe: AudioEnhancementRecipe;
  try {
    recipe = validateAudioEnhancementRecipe({
      schemaVersion: "audio-enhancement-recipe-v1",
      presetId: body.presetId,
      previewStartMs: strictInteger(
        body.previewStartMs,
        "previewStartMs"
      ),
      previewDurationMs: strictInteger(
        body.previewDurationMs,
        "previewDurationMs"
      ),
      targetIntegratedLufs: report.quality.targetIntegratedLufs,
      maximumTruePeakDbtp: policy.maximumTruePeakDbtp
    }, { sourceDurationMs: qualityControl.duration_ms });
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError(
      "Audio enhancement recipe is invalid"
    );
  }
  const recipeSha256 = await sha256Hex(JSON.stringify(recipe));
  const candidate: AudioEnhancementPreviewRow = {
    id: jobId,
    episode_id: access.episode.id,
    show_id: access.episode.showId,
    source_upload_id: qualityControl.source_upload_id,
    quality_control_run_id: qualityControl.id,
    source_object_key: qualityControl.source_object_key,
    source_object_bytes: qualityControl.source_object_bytes,
    source_object_etag: qualityControl.source_object_etag,
    source_mime_type: qualityControl.source_mime_type,
    source_sha256: qualityControl.source_sha256,
    quality_control_report_sha256: qualityControl.report_sha256,
    recipe_json: JSON.stringify(recipe),
    recipe_sha256: recipeSha256,
    processor_manifest_sha256: "",
    original_object_key: previewObjectKey(
      access.episode.showId,
      access.episode.id,
      jobId,
      "original"
    ),
    enhanced_object_key: previewObjectKey(
      access.episode.showId,
      access.episode.id,
      jobId,
      "enhanced"
    ),
    status: "queued",
    original_object_bytes: null,
    original_sha256: null,
    original_duration_ms: null,
    enhanced_object_bytes: null,
    enhanced_sha256: null,
    enhanced_duration_ms: null,
    processor_version: null,
    processor_report_json: null,
    processor_report_sha256: null,
    failure_code: null,
    requested_at: "",
    started_at: null,
    completed_at: null,
    updated_at: ""
  };
  const manifest = await buildEnhancementManifest(env, candidate);
  const existing = await loadPreview(env.DB, jobId);
  if (existing) {
    if (
      existing.episode_id !== access.episode.id
      || existing.processor_manifest_sha256 !== manifest.manifestSha256
    ) {
      return masterConflict(
        request,
        env,
        "audio_enhancement_job_id_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      preview: presentPreview(existing),
      processor: enhancementDispatch(manifest),
      idempotent: true
    });
  }
  const duplicate = await env.DB.prepare(
    `SELECT id
     FROM audio_enhancement_previews
     WHERE episode_id = ?
       AND source_object_etag = ?
       AND quality_control_report_sha256 = ?
       AND recipe_sha256 = ?
     LIMIT 1`
  ).bind(
    access.episode.id,
    qualityControl.source_object_etag,
    qualityControl.report_sha256,
    recipeSha256
  ).first<{ id: string }>();
  if (duplicate) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_preview_exists",
      { jobId: duplicate.id }
    );
  }
  const source = await env.MEDIA_BUCKET.head(
    qualityControl.source_object_key
  );
  if (
    !source
    || source.size !== qualityControl.source_object_bytes
    || source.httpEtag !== qualityControl.source_object_etag
    || source.httpMetadata?.contentType !== qualityControl.source_mime_type
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_source_mismatch"
    );
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO audio_enhancement_previews (
         id, episode_id, source_upload_id, quality_control_run_id,
         source_object_key, source_object_bytes, source_object_etag,
         source_mime_type, source_sha256, quality_control_report_sha256,
         recipe_json, recipe_sha256, processor_manifest_sha256,
         original_object_key, enhanced_object_key,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      jobId,
      access.episode.id,
      qualityControl.source_upload_id,
      qualityControl.id,
      qualityControl.source_object_key,
      qualityControl.source_object_bytes,
      qualityControl.source_object_etag,
      qualityControl.source_mime_type,
      qualityControl.source_sha256,
      qualityControl.report_sha256,
      JSON.stringify(recipe),
      recipeSha256,
      manifest.manifestSha256,
      candidate.original_object_key,
      candidate.enhanced_object_key,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'audio_enhancement.preview_queued',
         'audio_enhancement_preview', ?, ?
       FROM audio_enhancement_previews
       WHERE id = ? AND episode_id = ? AND changes() = 1`
    ).bind(
      auditId,
      access.authorization.identity.id,
      jobId,
      JSON.stringify({
        episodeId: access.episode.id,
        qualityControlRunId: qualityControl.id,
        qualityControlReportSha256: qualityControl.report_sha256,
        recipeSha256,
        presetId: recipe.presetId,
        previewStartMs: recipe.previewStartMs,
        previewDurationMs: recipe.previewDurationMs,
        processorManifestSha256: manifest.manifestSha256
      }),
      jobId,
      access.episode.id
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_queue_conflict"
    );
  }
  const queued = await loadPreview(env.DB, jobId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      preview: queued ? presentPreview(queued) : null,
      processor: enhancementDispatch(manifest),
      idempotent: false
    },
    { status: 202 }
  );
}

export async function getAudioEnhancementProcessorManifest(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const authorized = await authorizeEnhancementProcessor(
    request,
    env,
    jobIdValue,
    "manifest"
  );
  if (authorized instanceof Response) return authorized;
  const manifest = await rebuildEnhancementManifest(
    env,
    authorized.preview
  );
  if (!manifest) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_manifest_mismatch"
    );
  }
  await env.DB.prepare(
    `UPDATE audio_enhancement_previews
     SET
       status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       started_at = CASE
         WHEN status = 'queued' THEN datetime('now')
         ELSE started_at
       END,
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'running')`
  ).bind(authorized.preview.id).run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getAudioEnhancementProcessorSource(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const authorized = await authorizeEnhancementProcessor(
    request,
    env,
    jobIdValue,
    "source"
  );
  if (authorized instanceof Response) return authorized;
  if (!await rebuildEnhancementManifest(env, authorized.preview)) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_manifest_mismatch"
    );
  }
  const source = await env.MEDIA_BUCKET.get(
    authorized.preview.source_object_key,
    {
      onlyIf: new Headers({
        "if-match": authorized.preview.source_object_etag
      })
    }
  );
  if (
    !source
    || !("body" in source)
    || source.size !== authorized.preview.source_object_bytes
    || source.httpEtag !== authorized.preview.source_object_etag
    || source.httpMetadata?.contentType
      !== authorized.preview.source_mime_type
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_source_mismatch"
    );
  }
  const headers = new Headers({
    "content-type": authorized.preview.source_mime_type,
    "content-length": String(source.size),
    etag: source.httpEtag,
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  return new Response(source.body, { status: 200, headers });
}

export async function uploadAudioEnhancementProcessorOutput(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  kindValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const jobId = validIdentifier(jobIdValue, "jobId");
  const kind = outputKind(kindValue);
  if (!env.MEDIA_PROCESSOR_CALLBACK_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const encodedPayload =
    request.headers.get(PROCESSOR_UPLOAD_PAYLOAD_HEADER) ?? "";
  if (
    !encodedPayload
    || encodedPayload.length > 2_000
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
  ) {
    return processorAuthError(request, env, "invalid_signature");
  }
  const signed = await verifySignedText(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    message: encodedPayload
  });
  if (!signed.ok) {
    return processorAuthError(request, env, "invalid_signature");
  }
  const payload = parseUploadPayload(encodedPayload);
  if (payload.jobId !== jobId || payload.kind !== kind) {
    throw new RequestValidationError(
      "The enhancement output does not match its URL"
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    request.headers.get("content-type") !== "audio/mpeg"
    || contentLength !== payload.objectBytes
    || !request.body
  ) {
    throw new RequestValidationError(
      "The enhancement output body does not match its signed payload"
    );
  }
  const preview = await loadPreview(env.DB, jobId);
  if (!preview) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_enhancement_preview_not_found" },
      { status: 404 }
    );
  }
  if (
    !["queued", "running"].includes(preview.status)
    || payload.manifestSha256 !== preview.processor_manifest_sha256
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_upload_conflict"
    );
  }
  const objectKey = kind === "original"
    ? preview.original_object_key
    : preview.enhanced_object_key;
  const stored = await env.MEDIA_BUCKET.put(objectKey, request.body, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: {
      sha256: payload.sha256,
      "enhancement-manifest-sha256": payload.manifestSha256,
      "enhancement-output-kind": kind
    },
    sha256: payload.sha256
  });
  if (
    !stored
    || stored.size !== payload.objectBytes
    || stored.httpMetadata?.contentType !== "audio/mpeg"
    || stored.checksums.toJSON().sha256 !== payload.sha256
    || stored.customMetadata?.sha256 !== payload.sha256
    || stored.customMetadata?.["enhancement-manifest-sha256"]
      !== payload.manifestSha256
    || stored.customMetadata?.["enhancement-output-kind"] !== kind
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_output_mismatch"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    object: {
      kind,
      objectBytes: stored.size,
      sha256: payload.sha256,
      mimeType: "audio/mpeg",
      manifestSha256: payload.manifestSha256
    },
    checksumVerified: true
  });
}

export async function completeAudioEnhancementPreview(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const jobId = validIdentifier(jobIdValue, "jobId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: MAXIMUM_CALLBACK_BYTES,
    bodyName: "Audio enhancement processor evidence",
    invalidBodyCode: "invalid_audio_enhancement_processor_body"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  if (signed.body.jobId !== jobId) {
    throw new RequestValidationError(
      "jobId does not match the callback URL"
    );
  }
  const preview = await loadPreview(env.DB, jobId);
  if (!preview) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_enhancement_preview_not_found" },
      { status: 404 }
    );
  }
  const manifest = await rebuildEnhancementManifest(env, preview);
  if (
    !manifest
    || signed.body.manifestSha256 !== manifest.manifestSha256
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_manifest_mismatch"
    );
  }
  if (signed.body.status === "failed") {
    const failureCode = String(signed.body.failureCode ?? "");
    if (!FAILURE_CODES.has(failureCode)) {
      throw new RequestValidationError("failureCode is invalid");
    }
    if (
      preview.status === "failed"
      && preview.failure_code === failureCode
    ) {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        preview: presentPreview(preview),
        idempotent: true
      });
    }
    if (preview.status === "ready" || preview.status === "failed") {
      return masterConflict(
        request,
        env,
        "audio_enhancement_completion_conflict"
      );
    }
    const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE audio_enhancement_previews
         SET
           status = 'failed',
           failure_code = ?,
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND status IN ('queued', 'running')`
      ).bind(failureCode, jobId),
      env.DB.prepare(
        `INSERT INTO admin_audit_events (
           id, action, target_type, target_id, metadata_json
         )
         SELECT ?, 'audio_enhancement.preview_failed',
           'audio_enhancement_preview', ?, ?
         FROM audio_enhancement_previews
         WHERE id = ? AND status = 'failed' AND changes() = 1`
      ).bind(
        auditId,
        jobId,
        JSON.stringify({
          episodeId: preview.episode_id,
          failureCode,
          processorManifestSha256: manifest.manifestSha256
        }),
        jobId
      )
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      return masterConflict(
        request,
        env,
        "audio_enhancement_completion_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      preview: presentPreview(
        (await loadPreview(env.DB, jobId)) as AudioEnhancementPreviewRow
      ),
      idempotent: false
    });
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("status is invalid");
  }
  let report: AudioEnhancementReport;
  let reportSha256: string;
  try {
    report = await validateAudioEnhancementReport(
      signed.body.report,
      manifest
    );
    reportSha256 = await audioEnhancementReportSha256(report, manifest);
  } catch {
    throw new RequestValidationError(
      "Audio enhancement report is invalid",
      "invalid_audio_enhancement_report"
    );
  }
  if (signed.body.reportSha256 !== reportSha256) {
    throw new RequestValidationError(
      "Audio enhancement report digest is invalid",
      "invalid_audio_enhancement_report"
    );
  }
  if (
    preview.status === "ready"
    && preview.processor_report_sha256 === reportSha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      preview: presentPreview(preview),
      idempotent: true
    });
  }
  if (preview.status === "ready" || preview.status === "failed") {
    return masterConflict(
      request,
      env,
      "audio_enhancement_completion_conflict"
    );
  }
  const [source, original, enhanced] = await Promise.all([
    env.MEDIA_BUCKET.head(preview.source_object_key),
    env.MEDIA_BUCKET.head(preview.original_object_key),
    env.MEDIA_BUCKET.head(preview.enhanced_object_key)
  ]);
  if (
    !source
    || source.size !== preview.source_object_bytes
    || source.httpEtag !== preview.source_object_etag
    || source.httpMetadata?.contentType !== preview.source_mime_type
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_source_mismatch"
    );
  }
  if (
    !validStoredOutput(
      original,
      report.outputs.original,
      manifest.manifestSha256,
      "original"
    )
    || !validStoredOutput(
      enhanced,
      report.outputs.enhanced,
      manifest.manifestSha256,
      "enhanced"
    )
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_output_mismatch"
    );
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE audio_enhancement_previews
       SET
         status = 'ready',
         original_object_bytes = ?,
         original_sha256 = ?,
         original_duration_ms = ?,
         enhanced_object_bytes = ?,
         enhanced_sha256 = ?,
         enhanced_duration_ms = ?,
         processor_version = ?,
         processor_report_json = ?,
         processor_report_sha256 = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('queued', 'running')
         AND processor_manifest_sha256 = ?
         AND source_object_etag = ?`
    ).bind(
      report.outputs.original.objectBytes,
      report.outputs.original.sha256,
      report.outputs.original.durationMs,
      report.outputs.enhanced.objectBytes,
      report.outputs.enhanced.sha256,
      report.outputs.enhanced.durationMs,
      report.processorVersion,
      JSON.stringify(report),
      reportSha256,
      jobId,
      manifest.manifestSha256,
      preview.source_object_etag
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'audio_enhancement.preview_ready',
         'audio_enhancement_preview', ?, ?
       FROM audio_enhancement_previews
       WHERE id = ?
         AND processor_report_sha256 = ?
         AND changes() = 1`
    ).bind(
      auditId,
      jobId,
      JSON.stringify({
        episodeId: preview.episode_id,
        recipeSha256: preview.recipe_sha256,
        processorManifestSha256: manifest.manifestSha256,
        processorReportSha256: reportSha256,
        sourceSha256: preview.source_sha256,
        originalSha256: report.outputs.original.sha256,
        enhancedSha256: report.outputs.enhanced.sha256
      }),
      jobId,
      reportSha256
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_completion_conflict"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    preview: presentPreview(
      (await loadPreview(env.DB, jobId)) as AudioEnhancementPreviewRow
    ),
    idempotent: false
  });
}

export async function serveAdminAudioEnhancementPreview(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  kindValue: string
): Promise<Response> {
  const jobId = validIdentifier(jobIdValue, "jobId");
  const kind = outputKind(kindValue);
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES
  });
  if (!auth.ok) return auth.response;
  const preview = await loadPreview(env.DB, jobId);
  if (
    !preview
    || preview.status !== "ready"
    || !preview.show_id
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      READ_ROLES,
      preview.show_id
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_enhancement_preview_not_found" },
      { status: 404 }
    );
  }
  const objectKey = kind === "original"
    ? preview.original_object_key
    : preview.enhanced_object_key;
  const objectBytes = kind === "original"
    ? preview.original_object_bytes
    : preview.enhanced_object_bytes;
  const sha256 = kind === "original"
    ? preview.original_sha256
    : preview.enhanced_sha256;
  if (!objectBytes || !sha256) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_output_mismatch"
    );
  }
  const objectHead = await env.MEDIA_BUCKET.head(objectKey);
  if (
    !validStoredOutput(
      objectHead,
      {
        objectKey,
        objectBytes,
        sha256,
        mimeType: "audio/mpeg",
        durationMs: kind === "original"
          ? preview.original_duration_ms as number
          : preview.enhanced_duration_ms as number
      },
      preview.processor_manifest_sha256,
      kind
    )
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_output_mismatch"
    );
  }
  const headers = previewMediaHeaders(
    request,
    env,
    objectHead!.httpEtag
  );
  if (new URL(request.url).searchParams.get("download") === "1") {
    headers.set(
      "content-disposition",
      `attachment; filename="${safeDownloadFilename(
        `${jobId}-${kind}.mp3`
      )}"`
    );
  } else {
    headers.set("content-disposition", "inline");
  }
  if (request.headers.get("if-none-match") === objectHead!.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(objectBytes));
    return new Response(null, { headers });
  }
  const range = requestedMediaRange(
    request,
    objectBytes,
    objectHead!.httpEtag
  );
  if (range === "invalid") {
    headers.set("content-range", `bytes */${objectBytes}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await env.MEDIA_BUCKET.get(objectKey, {
    ...(range ? { range } : {}),
    onlyIf: new Headers({ "if-match": objectHead!.httpEtag })
  });
  if (
    !object
    || !("body" in object)
    || object.size !== objectBytes
    || object.httpEtag !== objectHead!.httpEtag
  ) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_output_mismatch"
    );
  }
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-length", String(length));
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${objectBytes}`
    );
  } else {
    headers.set("content-length", String(objectBytes));
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers
  });
}

async function authorizeEnhancementProcessor(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  action: "manifest" | "source"
): Promise<{ preview: AudioEnhancementPreviewRow } | Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const jobId = validIdentifier(jobIdValue, "jobId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: 10_000,
    bodyName: `Audio enhancement ${action} request`,
    invalidBodyCode: "invalid_audio_enhancement_processor_request"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  if (signed.body.jobId !== jobId || signed.body.action !== action) {
    throw new RequestValidationError(
      `The ${action} request does not match its URL or action`
    );
  }
  const preview = await loadPreview(env.DB, jobId);
  if (!preview) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_enhancement_preview_not_found" },
      { status: 404 }
    );
  }
  if (!["queued", "running"].includes(preview.status)) {
    return masterConflict(
      request,
      env,
      "audio_enhancement_preview_not_open"
    );
  }
  return { preview };
}

async function buildEnhancementManifest(
  env: PodcastEnv,
  preview: AudioEnhancementPreviewRow
): Promise<AudioEnhancementManifest> {
  return buildAudioEnhancementManifest({
    schemaVersion: "audio-enhancement-job-v1",
    jobId: preview.id,
    episodeId: preview.episode_id,
    showId: preview.show_id
      ?? await showIdForEpisode(env.DB, preview.episode_id),
    source: {
      bucketName: env.MEDIA_BUCKET_NAME || "",
      objectKey: preview.source_object_key,
      objectBytes: preview.source_object_bytes,
      etag: preview.source_object_etag,
      mimeType: preview.source_mime_type
    },
    qualityControl: {
      runId: preview.quality_control_run_id,
      reportSha256: preview.quality_control_report_sha256,
      sourceSha256: preview.source_sha256,
      durationMs: qualityControlDuration(
        await qualityControlForPreview(env.DB, preview)
      ),
      blockerCount: 0
    },
    recipe: JSON.parse(preview.recipe_json) as AudioEnhancementRecipe,
    outputs: {
      original: {
        objectKey: preview.original_object_key,
        mimeType: "audio/mpeg"
      },
      enhanced: {
        objectKey: preview.enhanced_object_key,
        mimeType: "audio/mpeg"
      }
    },
    callbackUrl: `${env.FEED_ORIGIN.replace(/\/$/, "")}`
      + `/v1/processor/audio-enhancements/${preview.id}/complete`
  });
}

async function rebuildEnhancementManifest(
  env: PodcastEnv,
  preview: AudioEnhancementPreviewRow
): Promise<AudioEnhancementManifest | null> {
  const manifest = await buildEnhancementManifest(env, preview);
  return manifest.manifestSha256 === preview.processor_manifest_sha256
    ? manifest
    : null;
}

async function qualityControlForPreview(
  db: D1Database,
  preview: AudioEnhancementPreviewRow
): Promise<{ duration_ms: number } | null> {
  return db.prepare(
    `SELECT duration_ms
     FROM audio_qc_runs
     WHERE id = ?
       AND episode_id = ?
       AND status = 'succeeded'
       AND blocker_count = 0
       AND report_sha256 = ?
       AND source_sha256 = ?`
  ).bind(
    preview.quality_control_run_id,
    preview.episode_id,
    preview.quality_control_report_sha256,
    preview.source_sha256
  ).first<{ duration_ms: number }>();
}

function qualityControlDuration(
  row: { duration_ms: number } | null
): number {
  if (!row?.duration_ms) {
    throw new Error("Audio enhancement QC evidence disappeared");
  }
  return row.duration_ms;
}

async function loadEligibleQualityControl(
  db: D1Database,
  episodeId: string,
  qualityControlRunId: string
): Promise<EligibleQualityControlRow | null> {
  return db.prepare(
    `${eligibleQualityControlSelect()}
     AND q.id = ? AND q.episode_id = ?`
  ).bind(
    qualityControlRunId,
    episodeId
  ).first<EligibleQualityControlRow>();
}

async function loadLatestEligibleQualityControl(
  db: D1Database,
  episodeId: string
): Promise<EligibleQualityControlRow | null> {
  return db.prepare(
    `${eligibleQualityControlSelect()}
     AND q.episode_id = ?
     ORDER BY q.completed_at DESC, q.id DESC
     LIMIT 1`
  ).bind(episodeId).first<EligibleQualityControlRow>();
}

function eligibleQualityControlSelect(): string {
  return `SELECT
      q.id, q.episode_id, episode.show_id, q.source_upload_id,
      upload.filename AS source_filename, q.source_object_key,
      q.source_object_bytes, q.source_object_etag, q.source_mime_type,
      q.source_sha256, q.report_json, q.report_sha256, q.blocker_count,
      q.warning_count, q.duration_ms, q.policy_revision, q.policy_json,
      policy.revision AS current_policy_revision
    FROM audio_qc_runs q
    JOIN episodes episode
      ON episode.id = q.episode_id
     AND episode.source_audio_key = q.source_object_key
    JOIN media_uploads upload
      ON upload.id = q.source_upload_id
     AND upload.episode_id = episode.id
     AND upload.kind = 'source_audio'
     AND upload.status = 'completed'
     AND upload.object_key = q.source_object_key
     AND upload.object_etag = q.source_object_etag
     AND upload.completed_bytes = q.source_object_bytes
    JOIN show_audio_qc_policies policy
      ON policy.show_id = episode.show_id
     AND policy.revision = q.policy_revision
    WHERE q.status = 'succeeded'
      AND q.blocker_count = 0
      AND q.source_sha256 IS NOT NULL
      AND q.report_json IS NOT NULL
      AND q.report_sha256 IS NOT NULL`;
}

async function loadWorkingMasterState(
  db: D1Database,
  episodeId: string
): Promise<WorkingMasterStateRow | null> {
  return db.prepare(
    `SELECT episode_id, revision, current_master_id, updated_at
     FROM episode_working_master_states
     WHERE episode_id = ?`
  ).bind(episodeId).first<WorkingMasterStateRow>();
}

async function loadWorkingMaster(
  db: D1Database,
  masterId: string
): Promise<WorkingMasterRow | null> {
  return db.prepare(
    `SELECT
       id, episode_id, revision, origin_kind, source_upload_id,
       quality_control_run_id, object_key, object_bytes, object_etag,
       mime_type, source_sha256, quality_control_report_sha256,
       approval_reason, approved_by_admin_user_id, approved_at
     FROM episode_working_masters
     WHERE id = ?`
  ).bind(masterId).first<WorkingMasterRow>();
}

async function loadPreview(
  db: D1Database,
  jobId: string
): Promise<AudioEnhancementPreviewRow | null> {
  return db.prepare(
    `${previewSelect()} WHERE preview.id = ?`
  ).bind(jobId).first<AudioEnhancementPreviewRow>();
}

function previewSelect(): string {
  return `SELECT
      preview.id, preview.episode_id, episode.show_id,
      preview.source_upload_id, preview.quality_control_run_id,
      preview.source_object_key, preview.source_object_bytes,
      preview.source_object_etag, preview.source_mime_type,
      preview.source_sha256, preview.quality_control_report_sha256,
      preview.recipe_json, preview.recipe_sha256,
      preview.processor_manifest_sha256, preview.original_object_key,
      preview.enhanced_object_key, preview.status,
      preview.original_object_bytes, preview.original_sha256,
      preview.original_duration_ms, preview.enhanced_object_bytes,
      preview.enhanced_sha256, preview.enhanced_duration_ms,
      preview.processor_version, preview.processor_report_json,
      preview.processor_report_sha256, preview.failure_code,
      preview.requested_at, preview.started_at, preview.completed_at,
      preview.updated_at
    FROM audio_enhancement_previews preview
    JOIN episodes episode ON episode.id = preview.episode_id`;
}

async function showIdForEpisode(
  db: D1Database,
  episodeId: string
): Promise<string> {
  const row = await db.prepare(
    `SELECT show_id FROM episodes WHERE id = ?`
  ).bind(episodeId).first<{ show_id: string }>();
  if (!row) throw new Error("Audio enhancement episode disappeared");
  return row.show_id;
}

function presentState(row: WorkingMasterStateRow) {
  return {
    revision: row.revision,
    currentMasterId: row.current_master_id,
    updatedAt: row.updated_at
  };
}

function presentMaster(row: WorkingMasterRow, current: boolean) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    revision: row.revision,
    originKind: row.origin_kind,
    sourceUploadId: row.source_upload_id,
    qualityControlRunId: row.quality_control_run_id,
    objectBytes: row.object_bytes,
    mimeType: row.mime_type,
    sourceSha256: row.source_sha256,
    qualityControlReportSha256: row.quality_control_report_sha256,
    approvalReason: row.approval_reason,
    approvedByAdminUserId: row.approved_by_admin_user_id,
    approvedAt: row.approved_at,
    current
  };
}

function presentPreview(row: AudioEnhancementPreviewRow) {
  const recipe = JSON.parse(row.recipe_json) as AudioEnhancementRecipe;
  return {
    id: row.id,
    episodeId: row.episode_id,
    qualityControlRunId: row.quality_control_run_id,
    recipe,
    recipeSha256: row.recipe_sha256,
    processorManifestSha256: row.processor_manifest_sha256,
    status: row.status,
    original: row.status === "ready"
      ? {
          objectBytes: row.original_object_bytes,
          sha256: row.original_sha256,
          durationMs: row.original_duration_ms,
          mediaUrl:
            `/v1/admin/audio-enhancements/${row.id}/media/original`
        }
      : null,
    enhanced: row.status === "ready"
      ? {
          objectBytes: row.enhanced_object_bytes,
          sha256: row.enhanced_sha256,
          durationMs: row.enhanced_duration_ms,
          mediaUrl:
            `/v1/admin/audio-enhancements/${row.id}/media/enhanced`
        }
      : null,
    processorVersion: row.processor_version,
    processorReportSha256: row.processor_report_sha256,
    failureCode: row.failure_code,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    warning:
      "Preview only. It cannot become the working master without a "
      + "full-length derivative and a new quality-control pass."
  };
}

function enhancementDispatch(manifest: AudioEnhancementManifest) {
  return {
    workflow: "process-audio-enhancement-preview.yml",
    jobId: manifest.jobId,
    manifestSha256: manifest.manifestSha256
  };
}

function previewObjectKey(
  showId: string,
  episodeId: string,
  jobId: string,
  kind: "original" | "enhanced"
): string {
  return `podcasts/${showId}/${episodeId}/audio_enhancement/`
    + `${jobId}/${jobId}-${kind}.mp3`;
}

function parseUploadPayload(encoded: string): ProcessorUploadPayload {
  let value: unknown;
  try {
    const normalized = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    value = JSON.parse(atob(normalized));
  } catch {
    throw new RequestValidationError(
      "The enhancement upload payload is invalid"
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(
      "The enhancement upload payload is invalid"
    );
  }
  const body = value as Record<string, unknown>;
  const objectBytes = strictInteger(body.objectBytes, "objectBytes");
  const sha256 = String(body.sha256 ?? "");
  const manifestSha256 = String(body.manifestSha256 ?? "");
  if (
    objectBytes <= 0
    || objectBytes > MAXIMUM_OUTPUT_BYTES
    || !/^[a-f0-9]{64}$/.test(sha256)
    || !/^[a-f0-9]{64}$/.test(manifestSha256)
  ) {
    throw new RequestValidationError(
      "The enhancement upload payload is invalid"
    );
  }
  return {
    jobId: validIdentifier(body.jobId, "jobId"),
    kind: outputKind(body.kind),
    manifestSha256,
    objectBytes,
    sha256
  };
}

function outputKind(value: unknown): "original" | "enhanced" {
  if (value !== "original" && value !== "enhanced") {
    throw new RequestValidationError(
      "kind must be original or enhanced"
    );
  }
  return value;
}

function validStoredOutput(
  object: R2Object | null,
  output: {
    objectKey: string;
    objectBytes: number;
    sha256: string;
    mimeType: "audio/mpeg";
    durationMs: number;
  },
  manifestSha256: string,
  kind: "original" | "enhanced"
): boolean {
  return Boolean(
    object
    && object.key === output.objectKey
    && object.size === output.objectBytes
    && object.httpMetadata?.contentType === output.mimeType
    && object.checksums.toJSON().sha256 === output.sha256
    && object.customMetadata?.sha256 === output.sha256
    && object.customMetadata?.["enhancement-manifest-sha256"]
      === manifestSha256
    && object.customMetadata?.["enhancement-output-kind"] === kind
  );
}

function previewMediaHeaders(
  request: Request,
  env: PodcastEnv,
  etag: string
): Headers {
  const headers = new Headers({
    ...privateCorsHeaders(request, env.ALLOWED_ORIGINS),
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store, max-age=0",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-site",
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  headers.set(
    "access-control-expose-headers",
    "accept-ranges,content-disposition,content-length,content-range,etag"
  );
  return headers;
}

function strictInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = strictInteger(value, field);
  if (result < 0) {
    throw new RequestValidationError(
      `${field} must be zero or a positive integer`
    );
  }
  return result;
}

function processorAuthError(
  request: Request,
  env: PodcastEnv,
  reason: "secret_missing" | "invalid_signature"
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      error: reason === "secret_missing"
        ? "not_found"
        : "invalid_processor_signature"
    },
    { status: reason === "secret_missing" ? 404 : 401 }
  );
}

function masterConflict(
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
