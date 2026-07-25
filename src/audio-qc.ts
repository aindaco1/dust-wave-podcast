import {
  audioQcReportSha256,
  buildAudioQcManifest,
  validateAudioQcPolicy,
  validateAudioQcReport,
  type AudioQcManifest,
  type AudioQcPolicy,
  type AudioQcReport
} from "@dustwave/media-core/audio-qc";

import {
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { readSignedJsonBody } from "./signed-callback";
import {
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  validIdentifier
} from "./validation";

const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const EDIT_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const POLICY_ROLES: AdminRole[] = ["super_admin", "admin"];
const CALLBACK_MAXIMUM_BYTES = 300_000;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "measurement_failed",
  "report_invalid"
]);

type AudioQcPolicyRow = {
  show_id: string;
  revision: number;
  mono_integrated_lufs: number;
  stereo_integrated_lufs: number;
  integrated_lufs_tolerance: number;
  maximum_true_peak_dbtp: number;
  maximum_dc_offset: number;
  maximum_channel_imbalance_lu: number;
  maximum_leading_silence_ms: number;
  maximum_trailing_silence_ms: number;
  maximum_internal_silence_ms: number;
  silence_threshold_db: number;
  updated_at: string;
};

type AudioQcRunRow = {
  id: string;
  episode_id: string;
  show_id?: string;
  source_upload_id: string;
  source_filename?: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  policy_revision: number;
  policy_json: string;
  processor_manifest_sha256: string;
  status: string;
  source_sha256: string | null;
  report_json: string | null;
  report_sha256: string | null;
  blocker_count: number | null;
  warning_count: number | null;
  duration_ms: number | null;
  integrated_lufs: number | null;
  true_peak_dbtp: number | null;
  processor_version: string | null;
  failure_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type SourceUploadRow = {
  id: string;
  show_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  completed_bytes: number;
  object_etag: string;
};

export async function getAdminEpisodeAudioQc(
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
  const [policy, source, runs] = await Promise.all([
    loadPolicy(env.DB, access.episode.showId),
    loadCurrentSource(env.DB, access.episode.id),
    env.DB.prepare(
      `SELECT
         q.id, q.episode_id, q.source_upload_id, upload.filename AS source_filename,
         q.source_object_key, q.source_object_bytes, q.source_object_etag,
         q.source_mime_type, q.policy_revision, q.policy_json,
         q.processor_manifest_sha256, q.status, q.source_sha256,
         q.report_json, q.report_sha256, q.blocker_count, q.warning_count,
         q.duration_ms, q.integrated_lufs, q.true_peak_dbtp,
         q.processor_version, q.failure_code, q.created_at, q.started_at,
         q.completed_at
       FROM audio_qc_runs q
       JOIN media_uploads upload ON upload.id = q.source_upload_id
       WHERE q.episode_id = ?
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 20`
    ).bind(access.episode.id).all<AudioQcRunRow>()
  ]);
  if (!policy) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_qc_policy_not_found" },
      { status: 409 }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    policy: presentPolicy(policy),
    source: source
      ? {
          uploadId: source.id,
          filename: source.filename,
          mimeType: source.content_type,
          objectBytes: source.completed_bytes,
          etag: source.object_etag
        }
      : null,
    runs: runs.results.map((run, index) =>
      presentRun(run, { includeReport: index === 0 })
    ),
    processor: {
      available: env.ENVIRONMENT === "staging"
        && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET),
      mode: env.ENVIRONMENT === "staging" ? "staging_manual" : "unavailable"
    }
  });
}

export async function updateAdminShowAudioQcPolicy(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: POLICY_ROLES,
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const existing = await loadPolicy(env.DB, showId);
  if (!existing) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const body = await readJsonObject(request, 20_000);
  const baseRevision = positiveInteger(
    body.baseRevision,
    "baseRevision"
  );
  let policy: AudioQcPolicy;
  try {
    policy = validateAudioQcPolicy({
      schemaVersion: "audio-qc-policy-v1",
      revision: baseRevision + 1,
      monoIntegratedLufs: strictNumber(
        body.monoIntegratedLufs,
        "monoIntegratedLufs"
      ),
      stereoIntegratedLufs: strictNumber(
        body.stereoIntegratedLufs,
        "stereoIntegratedLufs"
      ),
      integratedLufsTolerance: strictNumber(
        body.integratedLufsTolerance,
        "integratedLufsTolerance"
      ),
      maximumTruePeakDbtp: strictNumber(
        body.maximumTruePeakDbtp,
        "maximumTruePeakDbtp"
      ),
      maximumDcOffset: strictNumber(
        body.maximumDcOffset,
        "maximumDcOffset"
      ),
      maximumChannelImbalanceLu: strictNumber(
        body.maximumChannelImbalanceLu,
        "maximumChannelImbalanceLu"
      ),
      maximumLeadingSilenceMs: strictInteger(
        body.maximumLeadingSilenceMs,
        "maximumLeadingSilenceMs"
      ),
      maximumTrailingSilenceMs: strictInteger(
        body.maximumTrailingSilenceMs,
        "maximumTrailingSilenceMs"
      ),
      maximumInternalSilenceMs: strictInteger(
        body.maximumInternalSilenceMs,
        "maximumInternalSilenceMs"
      ),
      silenceThresholdDb: strictNumber(
        body.silenceThresholdDb,
        "silenceThresholdDb"
      )
    });
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Audio QC policy is invalid");
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE show_audio_qc_policies
       SET
         revision = ?,
         mono_integrated_lufs = ?,
         stereo_integrated_lufs = ?,
         integrated_lufs_tolerance = ?,
         maximum_true_peak_dbtp = ?,
         maximum_dc_offset = ?,
         maximum_channel_imbalance_lu = ?,
         maximum_leading_silence_ms = ?,
         maximum_trailing_silence_ms = ?,
         maximum_internal_silence_ms = ?,
         silence_threshold_db = ?,
         updated_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE show_id = ? AND revision = ?`
    ).bind(
      policy.revision,
      policy.monoIntegratedLufs,
      policy.stereoIntegratedLufs,
      policy.integratedLufsTolerance,
      policy.maximumTruePeakDbtp,
      policy.maximumDcOffset,
      policy.maximumChannelImbalanceLu,
      policy.maximumLeadingSilenceMs,
      policy.maximumTrailingSilenceMs,
      policy.maximumInternalSilenceMs,
      policy.silenceThresholdDb,
      auth.authorization.identity.id,
      showId,
      baseRevision
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'audio_qc.policy_updated', 'show', ?, ?
       FROM show_audio_qc_policies
       WHERE show_id = ? AND revision = ? AND changes() = 1`
    ).bind(
      auditId,
      auth.authorization.identity.id,
      showId,
      JSON.stringify({
        baseRevision,
        revision: policy.revision,
        schemaVersion: policy.schemaVersion
      }),
      showId,
      policy.revision
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const current = await loadPolicy(env.DB, showId);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "audio_qc_policy_conflict",
        currentRevision: current?.revision ?? null
      },
      { status: 409 }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    policy: presentPolicy({
      ...existing,
      revision: policy.revision,
      mono_integrated_lufs: policy.monoIntegratedLufs,
      stereo_integrated_lufs: policy.stereoIntegratedLufs,
      integrated_lufs_tolerance: policy.integratedLufsTolerance,
      maximum_true_peak_dbtp: policy.maximumTruePeakDbtp,
      maximum_dc_offset: policy.maximumDcOffset,
      maximum_channel_imbalance_lu: policy.maximumChannelImbalanceLu,
      maximum_leading_silence_ms: policy.maximumLeadingSilenceMs,
      maximum_trailing_silence_ms: policy.maximumTrailingSilenceMs,
      maximum_internal_silence_ms: policy.maximumInternalSilenceMs,
      silence_threshold_db: policy.silenceThresholdDb,
      updated_at: new Date().toISOString()
    })
  });
}

export async function queueAdminEpisodeAudioQc(
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
  const runId = validIdentifier(body.runId, "runId");
  const [source, policy] = await Promise.all([
    loadCurrentSource(env.DB, access.episode.id),
    loadPolicy(env.DB, access.episode.showId)
  ]);
  if (!source) {
    return audioQcConflict(request, env, "audio_qc_source_not_ready");
  }
  if (!policy) {
    return audioQcConflict(request, env, "audio_qc_policy_not_found");
  }
  const object = await env.MEDIA_BUCKET.head(source.object_key);
  if (
    !object
    || object.size !== source.completed_bytes
    || object.httpEtag !== source.object_etag
    || object.httpMetadata?.contentType !== source.content_type
  ) {
    return audioQcConflict(request, env, "audio_qc_source_mismatch");
  }
  const manifest = await buildManifest(env, {
    id: runId,
    episode_id: access.episode.id,
    show_id: access.episode.showId,
    source_upload_id: source.id,
    source_object_key: source.object_key,
    source_object_bytes: source.completed_bytes,
    source_object_etag: source.object_etag,
    source_mime_type: source.content_type,
    policy_revision: policy.revision,
    policy_json: JSON.stringify(policyContract(policy)),
    processor_manifest_sha256: "",
    status: "queued",
    source_sha256: null,
    report_json: null,
    report_sha256: null,
    blocker_count: null,
    warning_count: null,
    duration_ms: null,
    integrated_lufs: null,
    true_peak_dbtp: null,
    processor_version: null,
    failure_code: null,
    created_at: "",
    started_at: null,
    completed_at: null
  });
  const prior = await loadRun(env.DB, runId);
  if (prior) {
    if (
      prior.episode_id !== access.episode.id
      || prior.processor_manifest_sha256 !== manifest.manifestSha256
    ) {
      return audioQcConflict(request, env, "audio_qc_run_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      run: presentRun(prior),
      processor: processorDispatch(manifest),
      idempotent: true
    });
  }
  const active = await env.DB.prepare(
    `SELECT id
     FROM audio_qc_runs
     WHERE episode_id = ?
       AND source_object_key = ?
       AND source_object_etag = ?
       AND policy_revision = ?
       AND status IN ('queued', 'running', 'succeeded')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).bind(
    access.episode.id,
    source.object_key,
    source.object_etag,
    policy.revision
  ).first<{ id: string }>();
  if (active) {
    return audioQcConflict(request, env, "audio_qc_run_exists", {
      runId: active.id
    });
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO audio_qc_runs (
         id, episode_id, source_upload_id, source_object_key,
         source_object_bytes, source_object_etag, source_mime_type,
         policy_revision, policy_json, processor_manifest_sha256,
         requested_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      runId,
      access.episode.id,
      source.id,
      source.object_key,
      source.completed_bytes,
      source.object_etag,
      source.content_type,
      policy.revision,
      JSON.stringify(policyContract(policy)),
      manifest.manifestSha256,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'audio_qc.queued', 'audio_qc_run', ?, ?
       FROM audio_qc_runs
       WHERE id = ? AND episode_id = ? AND changes() = 1`
    ).bind(
      auditId,
      access.authorization.identity.id,
      runId,
      JSON.stringify({
        episodeId: access.episode.id,
        sourceUploadId: source.id,
        sourceBytes: source.completed_bytes,
        sourceMimeType: source.content_type,
        policyRevision: policy.revision,
        processorManifestSha256: manifest.manifestSha256
      }),
      runId,
      access.episode.id
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return audioQcConflict(request, env, "audio_qc_run_conflict");
  }
  const run = await loadRun(env.DB, runId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      run: run ? presentRun(run) : null,
      processor: processorDispatch(manifest),
      idempotent: false
    },
    { status: 202 }
  );
}

export async function getAudioQcProcessorManifest(
  request: Request,
  env: PodcastEnv,
  runIdValue: string
): Promise<Response> {
  const signed = await authorizeProcessorRequest(
    request,
    env,
    runIdValue,
    "manifest"
  );
  if (signed instanceof Response) return signed;
  const manifest = await rebuildManifest(env, signed.run);
  if (!manifest) {
    return audioQcConflict(request, env, "audio_qc_manifest_mismatch");
  }
  await env.DB.prepare(
    `UPDATE audio_qc_runs
     SET
       status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       started_at = CASE
         WHEN status = 'queued' THEN datetime('now')
         ELSE started_at
       END
     WHERE id = ? AND status IN ('queued', 'running')`
  ).bind(signed.run.id).run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getAudioQcProcessorSource(
  request: Request,
  env: PodcastEnv,
  runIdValue: string
): Promise<Response> {
  const signed = await authorizeProcessorRequest(
    request,
    env,
    runIdValue,
    "source"
  );
  if (signed instanceof Response) return signed;
  if (!await rebuildManifest(env, signed.run)) {
    return audioQcConflict(request, env, "audio_qc_manifest_mismatch");
  }
  const source = await env.MEDIA_BUCKET.get(
    signed.run.source_object_key,
    {
      onlyIf: new Headers({
        "if-match": signed.run.source_object_etag
      })
    }
  );
  if (
    !source
    || !("body" in source)
    || source.size !== signed.run.source_object_bytes
    || source.httpEtag !== signed.run.source_object_etag
    || source.httpMetadata?.contentType !== signed.run.source_mime_type
  ) {
    return audioQcConflict(request, env, "audio_qc_source_mismatch");
  }
  const headers = new Headers({
    "content-type": signed.run.source_mime_type,
    "content-length": String(source.size),
    etag: source.httpEtag,
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  return new Response(source.body, { status: 200, headers });
}

export async function completeAudioQcRun(
  request: Request,
  env: PodcastEnv,
  runIdValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const runId = validIdentifier(runIdValue, "runId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: CALLBACK_MAXIMUM_BYTES,
    bodyName: "Audio QC processor evidence",
    invalidBodyCode: "invalid_audio_qc_processor_body"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  if (signed.body.runId !== runId) {
    throw new RequestValidationError(
      "runId does not match the callback URL"
    );
  }
  const run = await loadRun(env.DB, runId);
  if (!run) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_qc_run_not_found" },
      { status: 404 }
    );
  }
  const manifest = await rebuildManifest(env, run);
  if (!manifest) {
    return audioQcConflict(request, env, "audio_qc_manifest_mismatch");
  }
  if (signed.body.manifestSha256 !== manifest.manifestSha256) {
    return audioQcConflict(request, env, "audio_qc_manifest_mismatch");
  }
  if (signed.body.status === "failed") {
    const failureCode = String(signed.body.failureCode ?? "");
    if (!FAILURE_CODES.has(failureCode)) {
      throw new RequestValidationError("failureCode is invalid");
    }
    if (run.status === "failed" && run.failure_code === failureCode) {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        run: presentRun(run),
        idempotent: true
      });
    }
    if (run.status === "succeeded" || run.status === "failed") {
      return audioQcConflict(request, env, "audio_qc_completion_conflict");
    }
    const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE audio_qc_runs
         SET
           status = 'failed',
           failure_code = ?,
           completed_at = datetime('now')
         WHERE id = ? AND status IN ('queued', 'running')`
      ).bind(failureCode, runId),
      env.DB.prepare(
        `INSERT INTO admin_audit_events (
           id, action, target_type, target_id, metadata_json
         )
         SELECT ?, 'audio_qc.failed', 'audio_qc_run', ?, ?
         FROM audio_qc_runs
         WHERE id = ? AND status = 'failed' AND changes() = 1`
      ).bind(
        auditId,
        runId,
        JSON.stringify({
          episodeId: run.episode_id,
          failureCode,
          processorManifestSha256: manifest.manifestSha256
        }),
        runId
      )
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      return audioQcConflict(request, env, "audio_qc_completion_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      run: presentRun((await loadRun(env.DB, runId)) as AudioQcRunRow),
      idempotent: false
    });
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("status is invalid");
  }
  const object = await env.MEDIA_BUCKET.head(run.source_object_key);
  if (
    !object
    || object.size !== run.source_object_bytes
    || object.httpEtag !== run.source_object_etag
    || object.httpMetadata?.contentType !== run.source_mime_type
  ) {
    return audioQcConflict(request, env, "audio_qc_source_mismatch");
  }
  let report: AudioQcReport;
  let reportSha256: string;
  try {
    report = await validateAudioQcReport(signed.body.report, manifest);
    reportSha256 = await audioQcReportSha256(report, manifest);
  } catch {
    throw new RequestValidationError(
      "Audio QC report is invalid",
      "invalid_audio_qc_report"
    );
  }
  if (signed.body.reportSha256 !== reportSha256) {
    throw new RequestValidationError(
      "Audio QC report digest is invalid",
      "invalid_audio_qc_report"
    );
  }
  if (run.status === "succeeded" && run.report_sha256 === reportSha256) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      run: presentRun(run),
      idempotent: true
    });
  }
  if (run.status === "succeeded" || run.status === "failed") {
    return audioQcConflict(request, env, "audio_qc_completion_conflict");
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE audio_qc_runs
       SET
         status = 'succeeded',
         source_sha256 = ?,
         report_json = ?,
         report_sha256 = ?,
         blocker_count = ?,
         warning_count = ?,
         duration_ms = ?,
         integrated_lufs = ?,
         true_peak_dbtp = ?,
         processor_version = ?,
         completed_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')
         AND processor_manifest_sha256 = ?
         AND source_object_etag = ?`
    ).bind(
      report.sourceSha256,
      JSON.stringify(report),
      reportSha256,
      report.quality.blockerCount,
      report.quality.warningCount,
      report.measurements.durationMs,
      report.measurements.integratedLufs,
      report.measurements.truePeakDbtp,
      report.processorVersion,
      runId,
      manifest.manifestSha256,
      run.source_object_etag
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'audio_qc.succeeded', 'audio_qc_run', ?, ?
       FROM audio_qc_runs
       WHERE id = ? AND report_sha256 = ? AND changes() = 1`
    ).bind(
      auditId,
      runId,
      JSON.stringify({
        episodeId: run.episode_id,
        policyRevision: run.policy_revision,
        processorManifestSha256: manifest.manifestSha256,
        reportSha256,
        sourceSha256: report.sourceSha256,
        blockerCount: report.quality.blockerCount,
        warningCount: report.quality.warningCount,
        durationMs: report.measurements.durationMs
      }),
      runId,
      reportSha256
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return audioQcConflict(request, env, "audio_qc_completion_conflict");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    run: presentRun((await loadRun(env.DB, runId)) as AudioQcRunRow),
    idempotent: false
  });
}

async function authorizeProcessorRequest(
  request: Request,
  env: PodcastEnv,
  runIdValue: string,
  action: "manifest" | "source"
): Promise<{ run: AudioQcRunRow } | Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const runId = validIdentifier(runIdValue, "runId");
  const signed = await readSignedJsonBody(request, {
    secret: env.MEDIA_PROCESSOR_CALLBACK_SECRET,
    timestampHeader: "x-podcast-processor-timestamp",
    signatureHeader: "x-podcast-processor-signature",
    maximumBytes: 10_000,
    bodyName: `Audio QC processor ${action} request`,
    invalidBodyCode: "invalid_audio_qc_processor_request"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  if (signed.body.runId !== runId || signed.body.action !== action) {
    throw new RequestValidationError(
      `The ${action} request does not match its URL or action`
    );
  }
  const run = await loadRun(env.DB, runId);
  if (!run) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "audio_qc_run_not_found" },
      { status: 404 }
    );
  }
  if (!["queued", "running"].includes(run.status)) {
    return audioQcConflict(request, env, "audio_qc_run_not_open");
  }
  return { run };
}

async function rebuildManifest(
  env: PodcastEnv,
  run: AudioQcRunRow
): Promise<AudioQcManifest | null> {
  const manifest = await buildManifest(env, run);
  return manifest.manifestSha256 === run.processor_manifest_sha256
    ? manifest
    : null;
}

async function buildManifest(
  env: PodcastEnv,
  run: AudioQcRunRow
): Promise<AudioQcManifest> {
  const policy = JSON.parse(run.policy_json) as AudioQcPolicy;
  return buildAudioQcManifest({
    schemaVersion: "audio-qc-job-v1",
    runId: run.id,
    episodeId: run.episode_id,
    showId: run.show_id ?? await showIdForEpisode(env.DB, run.episode_id),
    source: {
      bucketName: env.MEDIA_BUCKET_NAME || "",
      objectKey: run.source_object_key,
      objectBytes: run.source_object_bytes,
      etag: run.source_object_etag,
      mimeType: run.source_mime_type
    },
    policy,
    callbackUrl: `${env.FEED_ORIGIN.replace(/\/$/, "")}`
      + `/v1/processor/audio-qc/${run.id}/complete`
  });
}

async function showIdForEpisode(
  db: D1Database,
  episodeId: string
): Promise<string> {
  const row = await db.prepare(
    `SELECT show_id FROM episodes WHERE id = ?`
  ).bind(episodeId).first<{ show_id: string }>();
  if (!row) throw new Error("Audio QC episode disappeared");
  return row.show_id;
}

async function loadCurrentSource(
  db: D1Database,
  episodeId: string
): Promise<SourceUploadRow | null> {
  return db.prepare(
    `SELECT
       upload.id, upload.show_id, upload.object_key, upload.filename,
       upload.content_type, upload.completed_bytes, upload.object_etag
     FROM episodes episode
     JOIN media_uploads upload
       ON upload.object_key = episode.source_audio_key
      AND upload.episode_id = episode.id
      AND upload.kind = 'source_audio'
      AND upload.status = 'completed'
     WHERE episode.id = ?
       AND upload.completed_bytes IS NOT NULL
       AND upload.object_etag IS NOT NULL
     ORDER BY upload.completed_at DESC, upload.id DESC
     LIMIT 1`
  ).bind(episodeId).first<SourceUploadRow>();
}

async function loadPolicy(
  db: D1Database,
  showId: string
): Promise<AudioQcPolicyRow | null> {
  return db.prepare(
    `SELECT
       show_id, revision, mono_integrated_lufs, stereo_integrated_lufs,
       integrated_lufs_tolerance, maximum_true_peak_dbtp,
       maximum_dc_offset, maximum_channel_imbalance_lu,
       maximum_leading_silence_ms, maximum_trailing_silence_ms,
       maximum_internal_silence_ms, silence_threshold_db, updated_at
     FROM show_audio_qc_policies
     WHERE show_id = ?`
  ).bind(showId).first<AudioQcPolicyRow>();
}

async function loadRun(
  db: D1Database,
  runId: string
): Promise<AudioQcRunRow | null> {
  return db.prepare(
    `SELECT
       q.id, q.episode_id, episode.show_id, q.source_upload_id,
       upload.filename AS source_filename, q.source_object_key,
       q.source_object_bytes, q.source_object_etag, q.source_mime_type,
       q.policy_revision, q.policy_json, q.processor_manifest_sha256,
       q.status, q.source_sha256, q.report_json, q.report_sha256,
       q.blocker_count, q.warning_count, q.duration_ms, q.integrated_lufs,
       q.true_peak_dbtp, q.processor_version, q.failure_code,
       q.created_at, q.started_at, q.completed_at
     FROM audio_qc_runs q
     JOIN episodes episode ON episode.id = q.episode_id
     JOIN media_uploads upload ON upload.id = q.source_upload_id
     WHERE q.id = ?`
  ).bind(runId).first<AudioQcRunRow>();
}

function policyContract(row: AudioQcPolicyRow): AudioQcPolicy {
  return {
    schemaVersion: "audio-qc-policy-v1",
    revision: row.revision,
    monoIntegratedLufs: row.mono_integrated_lufs,
    stereoIntegratedLufs: row.stereo_integrated_lufs,
    integratedLufsTolerance: row.integrated_lufs_tolerance,
    maximumTruePeakDbtp: row.maximum_true_peak_dbtp,
    maximumDcOffset: row.maximum_dc_offset,
    maximumChannelImbalanceLu: row.maximum_channel_imbalance_lu,
    maximumLeadingSilenceMs: row.maximum_leading_silence_ms,
    maximumTrailingSilenceMs: row.maximum_trailing_silence_ms,
    maximumInternalSilenceMs: row.maximum_internal_silence_ms,
    silenceThresholdDb: row.silence_threshold_db
  };
}

function presentPolicy(row: AudioQcPolicyRow) {
  return {
    ...policyContract(row),
    updatedAt: row.updated_at
  };
}

function presentRun(
  row: AudioQcRunRow,
  { includeReport = true }: { includeReport?: boolean } = {}
) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    source: {
      uploadId: row.source_upload_id,
      filename: row.source_filename ?? null,
      objectBytes: row.source_object_bytes,
      etag: row.source_object_etag,
      mimeType: row.source_mime_type
    },
    policyRevision: row.policy_revision,
    processorManifestSha256: row.processor_manifest_sha256,
    status: row.status,
    sourceSha256: row.source_sha256,
    report: includeReport && row.report_json
      ? JSON.parse(row.report_json) as AudioQcReport
      : null,
    reportSha256: row.report_sha256,
    summary: row.status === "succeeded"
      ? {
          blockerCount: row.blocker_count,
          warningCount: row.warning_count,
          durationMs: row.duration_ms,
          integratedLufs: row.integrated_lufs,
          truePeakDbtp: row.true_peak_dbtp
        }
      : null,
    processorVersion: row.processor_version,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function processorDispatch(manifest: AudioQcManifest) {
  return {
    workflow: "process-audio-qc.yml",
    runId: manifest.runId,
    manifestSha256: manifest.manifestSha256
  };
}

function strictNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${field} must be a finite number`);
  }
  return value;
}

function strictInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  return value as number;
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

function audioQcConflict(
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
