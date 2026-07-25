import {
  ALIGNMENT_PROCESSOR_SCHEMA,
  ALIGNMENT_PROCESSOR_VERSION,
  buildAlignmentProcessorManifest,
  buildAlignmentTranscriptProjection,
  MAXIMUM_ALIGNMENT_RESULT_BYTES,
  validateAlignmentRunnerResult,
  type AlignmentProcessorManifest,
  type AlignmentRunnerAdapterIdentity,
  type AlignmentTranscriptProjection
} from "@dustwave/timed-text/alignment";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { AdminRole } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { readSignedJsonBody } from "./signed-callback";
import { normalizeTranscriptCues } from "./transcripts";
import {
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
const APPROVE_ROLES: AdminRole[] = ["super_admin", "admin"];
const RUNNER_REPOSITORY = "aindaco1/dust-wave-alignment-runner";
const RUNNER_REVISION = "3c5ab054fdad375901eb186f32d7aed6cdb40413";
const RUNNER_DIGEST =
  "sha256:5b07bbf315bd62a3c445a7a5a476bf642f91aa1c781173aa1f4e4e8021a51178";
const PROCESSOR_CALLBACK_MAXIMUM_BYTES = MAXIMUM_ALIGNMENT_RESULT_BYTES;
const RESULT_INSERT_BATCH_SIZE = 100;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "transcript_invalid",
  "adapter_failed",
  "result_invalid",
  "storage_failed"
]);

const ADAPTERS: Record<string, AlignmentRunnerAdapterIdentity> = {
  whisperx: {
    name: "whisperx",
    version: "3.8.6",
    model: "default",
    modelVersion: "default-en-es-v1",
    settingsVersion: "whisperx-align-v1",
    runnerDigest: RUNNER_DIGEST
  },
  "stable-ts": {
    name: "stable-ts",
    version: "2.19.1",
    model: "base",
    modelVersion: "openai-whisper-base",
    settingsVersion: "stable-ts-align-v1",
    runnerDigest: RUNNER_DIGEST
  }
};

type AlignmentSourceRow = {
  transcript_id: string;
  episode_id: string;
  show_id: string;
  language: string;
  transcript_status: string;
  transcript_revision: number;
  approved_revision: number | null;
  transcript_content_json: string;
  transcript_content_sha256: string;
  current_master_id: string | null;
  working_master_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_audio_sha256: string;
  source_duration_ms: number;
};

type AlignmentJobRow = {
  id: string;
  request_id: string;
  alignment_revision_id: string;
  transcript_id: string;
  episode_id: string;
  show_id: string;
  working_master_id: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_duration_ms: number;
  source_audio_sha256: string;
  transcript_revision: number;
  transcript_content_sha256: string;
  transcript_projection_json: string;
  transcript_projection_sha256: string;
  language: string;
  adapter: string;
  adapter_version: string;
  model: string;
  model_version: string;
  settings_version: string;
  runner_revision: string;
  runner_digest: string;
  processor_manifest_sha256: string;
  result_object_key: string;
  input_fingerprint: string;
  status: string;
  attempt_count: number;
  result_manifest_sha256: string | null;
  quality_report_json: string | null;
  failure_code: string | null;
  last_error: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  current_master_id: string | null;
  current_transcript_revision: number | null;
  current_transcript_sha256: string | null;
  current_transcript_status: string | null;
  alignment_status: string;
  benchmark_run_id: string | null;
};

export async function listAdminEpisodeAlignmentJobs(
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
  const [sources, jobs] = await Promise.all([
    env.DB.prepare(
      `${alignmentSourceSelect()} WHERE transcript.episode_id = ?
       ORDER BY transcript.language`
    ).bind(access.episode.id).all<AlignmentSourceRow>(),
    env.DB.prepare(
      `${alignmentJobSelect()} WHERE job.episode_id = ?
       ORDER BY job.requested_at DESC, job.id DESC
       LIMIT 30`
    ).bind(access.episode.id).all<AlignmentJobRow>()
  ]);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: access.episode.id,
    candidates: sources.results.map(presentAlignmentSource),
    jobs: jobs.results.map(presentAlignmentJob),
    processor: {
      available: env.ENVIRONMENT === "staging"
        && Boolean(env.MEDIA_PROCESSOR_CALLBACK_SECRET),
      mode: env.ENVIRONMENT === "staging"
        ? "staging_manual"
        : "unavailable",
      workflow: "process-alignment.yml",
      runnerRepository: RUNNER_REPOSITORY,
      runnerRevision: RUNNER_REVISION
    },
    gate: {
      bilingualBenchmarkRequired: true,
      minimumAlignedWordRatio: 0.98,
      interpolatedTimingPasses: false,
      wordControlsRemainLockedUntilPassed: true
    }
  });
}

export async function queueAdminEpisodeAlignmentJob(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  if (
    env.ENVIRONMENT !== "staging"
    || !env.MEDIA_PROCESSOR_CALLBACK_SECRET
  ) {
    return alignmentConflict(request, env, "alignment_processor_unavailable");
  }
  const body = await readJsonObject(request, 30_000);
  const requestId = validIdentifier(body.requestId, "requestId");
  const expectedWorkingMasterId = validIdentifier(
    body.expectedWorkingMasterId,
    "expectedWorkingMasterId"
  );
  const expectedTranscriptRevision = positiveInteger(
    body.expectedTranscriptRevision,
    "expectedTranscriptRevision"
  );
  const language = alignmentLanguage(body.language);
  const adapter = alignmentAdapter(body.adapter);
  const source = await loadAlignmentSource(
    env.DB,
    access.episode.id,
    language
  );
  if (!source?.current_master_id) {
    return alignmentConflict(
      request,
      env,
      "alignment_working_master_required"
    );
  }
  if (
    source.current_master_id !== expectedWorkingMasterId
    || source.working_master_id !== expectedWorkingMasterId
  ) {
    return alignmentConflict(
      request,
      env,
      "alignment_working_master_changed",
      { currentWorkingMasterId: source.current_master_id }
    );
  }
  if (
    source.transcript_status !== "approved"
    || source.transcript_revision !== expectedTranscriptRevision
    || source.approved_revision !== expectedTranscriptRevision
  ) {
    return alignmentConflict(
      request,
      env,
      "alignment_approved_transcript_required",
      { currentTranscriptRevision: source.transcript_revision }
    );
  }
  const projection = await projectionForSource(source);
  const inputFingerprint = await sha256Hex(JSON.stringify({
    schemaVersion: 2,
    workingMasterId: source.working_master_id,
    sourceAudioSha256: source.source_audio_sha256,
    transcriptId: source.transcript_id,
    transcriptRevision: source.transcript_revision,
    transcriptContentSha256: source.transcript_content_sha256,
    transcriptProjectionSha256: projection.projectionSha256,
    language,
    adapter,
    runnerRevision: RUNNER_REVISION
  }));
  const existing = await findAlignmentJob(
    env.DB,
    requestId,
    inputFingerprint
  );
  if (existing) {
    if (
      existing.request_id === requestId
      && existing.input_fingerprint !== inputFingerprint
    ) {
      return alignmentConflict(
        request,
        env,
        "alignment_request_id_conflict"
      );
    }
    const retry = await reopenRetryableAlignment(env.DB, existing);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentAlignmentJob(retry),
      idempotent: true,
      delivery: retry.status === "queued"
        ? "processor_required"
        : "existing"
    });
  }

  const jobId = `alignment_job_${inputFingerprint.slice(0, 32)}`;
  const alignmentRevisionId =
    `alignment_revision_${inputFingerprint.slice(0, 32)}`;
  const resultObjectKey =
    `podcasts/${source.show_id}/${source.episode_id}/alignment/`
    + `${jobId}/result.json`;
  const candidate = alignmentJobCandidate({
    source,
    projection,
    adapter,
    requestId,
    inputFingerprint,
    jobId,
    alignmentRevisionId,
    resultObjectKey
  });
  const processorManifest = await buildProcessorManifest(env, candidate);
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_alignment_revisions (
         id, transcript_id, source_audio_sha256,
         transcript_revision_sha256, language, adapter, adapter_version,
         model, model_version, settings_version, runner_digest, status,
         result_manifest_key, quality_report_json, input_fingerprint
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, '{}', ?
       )`
    ).bind(
      alignmentRevisionId,
      source.transcript_id,
      source.source_audio_sha256,
      source.transcript_content_sha256,
      language,
      adapter.name,
      adapter.version,
      adapter.model,
      adapter.modelVersion,
      adapter.settingsVersion,
      adapter.runnerDigest,
      resultObjectKey,
      inputFingerprint
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_alignment_jobs (
         id, request_id, alignment_revision_id, transcript_id, episode_id,
         working_master_id, source_object_key, source_object_bytes,
         source_object_etag, source_mime_type, source_duration_ms,
         source_audio_sha256, transcript_revision,
         transcript_content_sha256, transcript_projection_json,
         transcript_projection_sha256, language, adapter, adapter_version,
         model, model_version, settings_version, runner_revision,
         runner_digest, processor_manifest_sha256, result_object_key,
         input_fingerprint, requested_by_admin_user_id
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?
       )`
    ).bind(
      jobId,
      requestId,
      alignmentRevisionId,
      source.transcript_id,
      source.episode_id,
      source.working_master_id,
      source.source_object_key,
      source.source_object_bytes,
      source.source_object_etag,
      source.source_mime_type,
      source.source_duration_ms,
      source.source_audio_sha256,
      source.transcript_revision,
      source.transcript_content_sha256,
      JSON.stringify(projection),
      projection.projectionSha256,
      language,
      adapter.name,
      adapter.version,
      adapter.model,
      adapter.modelVersion,
      adapter.settingsVersion,
      RUNNER_REVISION,
      adapter.runnerDigest,
      processorManifest.manifestSha256,
      resultObjectKey,
      inputFingerprint,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'alignment.queued', 'transcript_alignment_job', id, ?
       FROM transcript_alignment_jobs
       WHERE id = ? AND request_id = ?`
    ).bind(
      auditId,
      access.authorization.identity.id,
      JSON.stringify({
        episodeId: source.episode_id,
        transcriptId: source.transcript_id,
        transcriptRevision: source.transcript_revision,
        transcriptContentSha256: source.transcript_content_sha256,
        transcriptProjectionSha256: projection.projectionSha256,
        workingMasterId: source.working_master_id,
        sourceAudioSha256: source.source_audio_sha256,
        language,
        adapter: adapter.name,
        adapterVersion: adapter.version,
        runnerRevision: RUNNER_REVISION,
        inputFingerprint,
        wordCount: projection.wordCount
      }),
      jobId,
      requestId
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    const raced = await findAlignmentJob(
      env.DB,
      requestId,
      inputFingerprint
    );
    if (!raced) {
      return alignmentConflict(request, env, "alignment_queue_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentAlignmentJob(raced),
      idempotent: true,
      delivery: "existing"
    });
  }
  const created = await loadAlignmentJob(env.DB, jobId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      job: created ? presentAlignmentJob(created) : null,
      idempotent: false,
      delivery: "processor_required"
    },
    { status: 202 }
  );
}

export async function approveAdminEpisodeAlignment(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  jobIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    APPROVE_ROLES,
    { requireCsrf: true }
  );
  if (access instanceof Response) return access;
  const jobId = validIdentifier(jobIdValue, "jobId");
  const body = await readJsonObject(request, 10_000);
  const approvalId = validIdentifier(body.approvalId, "approvalId");
  const job = await loadAlignmentJob(env.DB, jobId);
  if (!job || job.episode_id !== access.episode.id) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "alignment_job_not_found" },
      { status: 404 }
    );
  }
  const existing = await env.DB.prepare(
    `SELECT id, alignment_revision_id
     FROM transcript_alignment_approvals
     WHERE id = ? OR alignment_revision_id = ?`
  ).bind(approvalId, job.alignment_revision_id).first<{
    id: string;
    alignment_revision_id: string;
  }>();
  if (existing) {
    if (
      existing.id !== approvalId
      || existing.alignment_revision_id !== job.alignment_revision_id
    ) {
      return alignmentConflict(
        request,
        env,
        "alignment_approval_conflict"
      );
    }
    const current = await loadAlignmentJob(env.DB, jobId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: current ? presentAlignmentJob(current) : null,
      idempotent: true
    });
  }
  const quality = parseQuality(job.quality_report_json);
  if (
    job.status !== "ready"
    || job.alignment_status !== "needs_review"
    || !quality?.structurallyEligible
    || job.current_master_id !== job.working_master_id
    || job.current_transcript_revision !== job.transcript_revision
    || job.current_transcript_sha256 !== job.transcript_content_sha256
    || job.current_transcript_status !== "approved"
  ) {
    return alignmentConflict(request, env, "alignment_not_approvable");
  }
  if (!job.benchmark_run_id) {
    return alignmentConflict(
      request,
      env,
      "alignment_bilingual_benchmark_required"
    );
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_alignment_approvals (
         id, alignment_revision_id, benchmark_run_id, admin_user_id
       ) VALUES (?, ?, ?, ?)`
    ).bind(
      approvalId,
      job.alignment_revision_id,
      job.benchmark_run_id,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `UPDATE transcript_alignment_revisions
       SET
         status = 'passed',
         approved_at = datetime('now'),
         approved_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND status = 'needs_review'
         AND EXISTS (
           SELECT 1
           FROM transcript_alignment_approvals approval
           WHERE approval.id = ?
             AND approval.alignment_revision_id =
               transcript_alignment_revisions.id
         )`
    ).bind(
      access.authorization.identity.id,
      job.alignment_revision_id,
      approvalId
    ),
    env.DB.prepare(
      `UPDATE transcripts
       SET
         alignment_score = ?,
         aligned_word_ratio = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND content_sha256 = ?
         AND status = 'approved'
         AND changes() = 1`
    ).bind(
      quality.alignedWordRatio,
      quality.alignedWordRatio,
      job.transcript_id,
      job.transcript_revision,
      job.transcript_content_sha256
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'alignment.approved', 'transcript_alignment_revision',
              revision.id, ?
       FROM transcript_alignment_revisions revision
       WHERE revision.id = ? AND revision.status = 'passed'`
    ).bind(
      auditId,
      access.authorization.identity.id,
      JSON.stringify({
        episodeId: job.episode_id,
        transcriptId: job.transcript_id,
        transcriptRevision: job.transcript_revision,
        transcriptContentSha256: job.transcript_content_sha256,
        alignmentRevisionId: job.alignment_revision_id,
        resultManifestSha256: job.result_manifest_sha256,
        benchmarkRunId: job.benchmark_run_id,
        alignedWordRatio: quality.alignedWordRatio
      }),
      job.alignment_revision_id
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return alignmentConflict(request, env, "alignment_approval_conflict");
  }
  const approved = await loadAlignmentJob(env.DB, jobId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: approved ? presentAlignmentJob(approved) : null,
    idempotent: false
  });
}

export async function getAlignmentProcessorManifest(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const context = await authorizeAlignmentProcessor(
    request,
    env,
    jobIdValue,
    "manifest"
  );
  if (context instanceof Response) return context;
  const manifest = await rebuildProcessorManifest(env, context);
  if (!manifest) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_manifest_mismatch"
    );
  }
  const claimed = await env.DB.prepare(
    `UPDATE transcript_alignment_jobs
     SET
       status = 'running',
       attempt_count = attempt_count + 1,
       started_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status = 'queued' AND attempt_count < 5`
  ).bind(context.id).run();
  if (
    context.status === "queued"
    && Number(claimed.meta?.changes ?? 0) !== 1
  ) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_attempts_exhausted"
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getAlignmentProcessorSource(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string
): Promise<Response> {
  const context = await authorizeAlignmentProcessor(
    request,
    env,
    jobIdValue,
    "source"
  );
  if (context instanceof Response) return context;
  if (!await rebuildProcessorManifest(env, context)) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_manifest_mismatch"
    );
  }
  const source = await env.MEDIA_BUCKET.get(context.source_object_key, {
    onlyIf: new Headers({ "if-match": context.source_object_etag })
  });
  if (
    !source
    || !("body" in source)
    || source.size !== context.source_object_bytes
    || !r2EtagMatches(source, context.source_object_etag)
    || source.httpMetadata?.contentType !== context.source_mime_type
  ) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_source_mismatch"
    );
  }
  return new Response(source.body, {
    status: 200,
    headers: {
      "content-type": context.source_mime_type,
      "content-length": String(source.size),
      etag: source.httpEtag,
      "cache-control": "private, no-store, max-age=0",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-site",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

export async function completeAlignmentProcessorJob(
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
    maximumBytes: PROCESSOR_CALLBACK_MAXIMUM_BYTES,
    bodyName: "Alignment processor evidence",
    invalidBodyCode: "invalid_alignment_processor_body"
  });
  if (!signed.ok) {
    return processorAuthError(request, env);
  }
  const job = await loadAlignmentJob(env.DB, jobId);
  if (!job) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "alignment_job_not_found" },
      { status: 404 }
    );
  }
  if (
    signed.body.jobId !== job.id
    || signed.body.alignmentRevisionId !== job.alignment_revision_id
    || signed.body.processorManifestSha256
      !== job.processor_manifest_sha256
  ) {
    throw new RequestValidationError(
      "Alignment processor evidence identity is invalid"
    );
  }
  if (signed.body.status === "failed") {
    return completeAlignmentFailure(request, env, job, signed.body);
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("Alignment processor status is invalid");
  }
  const resultBody = signed.body.result as
    | Record<string, unknown>
    | undefined;
  if (
    job.status === "ready"
    && resultBody?.manifestSha256 === job.result_manifest_sha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentAlignmentJob(job),
      idempotent: true
    });
  }
  if (!["queued", "running"].includes(job.status)) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_completion_conflict"
    );
  }
  if (
    job.current_master_id !== job.working_master_id
    || job.current_transcript_revision !== job.transcript_revision
    || job.current_transcript_sha256 !== job.transcript_content_sha256
    || job.current_transcript_status !== "approved"
  ) {
    await markAlignmentStale(env.DB, job);
    return alignmentConflict(
      request,
      env,
      "alignment_processor_inputs_changed"
    );
  }
  const projection = parseProjection(job.transcript_projection_json);
  let validated;
  try {
    validated = await validateAlignmentRunnerResult(resultBody, {
      jobId: job.id,
      alignmentRevisionId: job.alignment_revision_id,
      sourceAudioSha256: job.source_audio_sha256,
      sourceDurationMs: job.source_duration_ms,
      projection,
      adapter: adapterFromJob(job)
    });
  } catch (error) {
    await markAlignmentFailed(
      env.DB,
      job,
      "result_invalid",
      error instanceof Error ? error.message : "Alignment result is invalid."
    );
    throw error;
  }
  if (validated.quality.invalidWordCount > 0) {
    await markAlignmentFailed(
      env.DB,
      job,
      "result_invalid",
      "Alignment result contains invalid word intervals."
    );
    return alignmentConflict(request, env, "alignment_result_invalid");
  }
  const resultJson = JSON.stringify(resultBody);
  const resultSha256 = await sha256Hex(resultJson);
  await putImmutableAlignmentResult(
    env.MEDIA_BUCKET,
    job.result_object_key,
    resultJson,
    resultSha256,
    job
  );
  await persistAlignmentWords(env.DB, job, validated.manifest.candidateWords);
  const qualityJson = JSON.stringify(validated.quality);
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE transcript_alignment_revisions
       SET
         status = 'needs_review',
         adapter_version = ?,
         result_manifest_key = ?,
         quality_report_json = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status = 'processing'
         AND transcript_revision_sha256 = ?`
    ).bind(
      validated.manifest.adapter.version,
      job.result_object_key,
      qualityJson,
      job.alignment_revision_id,
      job.transcript_content_sha256
    ),
    env.DB.prepare(
      `UPDATE transcript_alignment_jobs
       SET
         status = 'ready',
         result_manifest_sha256 = ?,
         quality_report_json = ?,
         failure_code = NULL,
         last_error = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('queued', 'running')
         AND (
           SELECT COUNT(*)
           FROM transcript_words word
           WHERE word.alignment_revision_id = ?
         ) = ?`
    ).bind(
      validated.manifestSha256,
      qualityJson,
      job.id,
      job.alignment_revision_id,
      validated.manifest.candidateWords.length
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'alignment.completed', 'transcript_alignment_job', id, ?
       FROM transcript_alignment_jobs
       WHERE id = ? AND status = 'ready' AND changes() = 1`
    ).bind(
      auditId,
      JSON.stringify({
        episodeId: job.episode_id,
        transcriptId: job.transcript_id,
        transcriptRevision: job.transcript_revision,
        transcriptContentSha256: job.transcript_content_sha256,
        transcriptProjectionSha256: job.transcript_projection_sha256,
        workingMasterId: job.working_master_id,
        sourceAudioSha256: job.source_audio_sha256,
        alignmentRevisionId: job.alignment_revision_id,
        resultManifestSha256: validated.manifestSha256,
        adapter: job.adapter,
        adapterVersion: job.adapter_version,
        runnerRevision: job.runner_revision,
        wordCount: validated.quality.wordCount,
        alignedWordCount: validated.quality.alignedWordCount,
        unalignedWordCount: validated.quality.unalignedWordCount,
        interpolatedWordCount: validated.quality.interpolatedWordCount,
        structurallyEligible: validated.quality.structurallyEligible
      }),
      job.id
    )
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || Number(results[1]?.meta?.changes ?? 0) !== 1
  ) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_completion_conflict"
    );
  }
  const ready = await loadAlignmentJob(env.DB, job.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: ready ? presentAlignmentJob(ready) : null,
    idempotent: false
  });
}

async function authorizeAlignmentProcessor(
  request: Request,
  env: PodcastEnv,
  jobIdValue: string,
  action: "manifest" | "source"
): Promise<AlignmentJobRow | Response> {
  if (
    env.ENVIRONMENT !== "staging"
    || !env.MEDIA_PROCESSOR_CALLBACK_SECRET
  ) {
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
    bodyName: `Alignment processor ${action} request`,
    invalidBodyCode: "invalid_alignment_processor_request"
  });
  if (!signed.ok) return processorAuthError(request, env);
  if (signed.body.jobId !== jobId || signed.body.action !== action) {
    throw new RequestValidationError(
      `The alignment ${action} request does not match its URL`
    );
  }
  const job = await loadAlignmentJob(env.DB, jobId);
  if (!job) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "alignment_job_not_found" },
      { status: 404 }
    );
  }
  if (!["queued", "running"].includes(job.status)) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_job_not_open"
    );
  }
  return job;
}

async function buildProcessorManifest(
  env: PodcastEnv,
  job: AlignmentJobRow
): Promise<AlignmentProcessorManifest> {
  const origin = env.FEED_ORIGIN.replace(/\/$/, "");
  return buildAlignmentProcessorManifest({
    schemaVersion: ALIGNMENT_PROCESSOR_SCHEMA,
    processorVersion: ALIGNMENT_PROCESSOR_VERSION,
    jobId: job.id,
    alignmentRevisionId: job.alignment_revision_id,
    episodeId: job.episode_id,
    showId: job.show_id,
    transcriptId: job.transcript_id,
    workingMasterId: job.working_master_id,
    language: alignmentLanguage(job.language),
    source: {
      objectKey: job.source_object_key,
      objectBytes: job.source_object_bytes,
      etag: job.source_object_etag,
      mimeType: job.source_mime_type as AlignmentProcessorManifest[
        "source"
      ]["mimeType"],
      sha256: job.source_audio_sha256,
      durationMs: job.source_duration_ms
    },
    transcript: parseProjection(job.transcript_projection_json),
    adapter: adapterFromJob(job),
    runner: {
      repository: RUNNER_REPOSITORY,
      revision: job.runner_revision
    },
    output: {
      maximumResultBytes: MAXIMUM_ALIGNMENT_RESULT_BYTES
    },
    sourceUrl:
      `${origin}/v1/processor/alignments/${job.id}/source`,
    callbackUrl:
      `${origin}/v1/processor/alignments/${job.id}/complete`
  });
}

async function rebuildProcessorManifest(
  env: PodcastEnv,
  job: AlignmentJobRow
): Promise<AlignmentProcessorManifest | null> {
  const manifest = await buildProcessorManifest(env, job);
  return manifest.manifestSha256 === job.processor_manifest_sha256
    ? manifest
    : null;
}

async function completeAlignmentFailure(
  request: Request,
  env: PodcastEnv,
  job: AlignmentJobRow,
  body: Record<string, unknown>
): Promise<Response> {
  const failureCode = String(body.failureCode ?? "");
  if (!FAILURE_CODES.has(failureCode)) {
    throw new RequestValidationError("Alignment failureCode is invalid");
  }
  if (job.status === "failed" && job.failure_code === failureCode) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentAlignmentJob(job),
      idempotent: true
    });
  }
  if (!["queued", "running"].includes(job.status)) {
    return alignmentConflict(
      request,
      env,
      "alignment_processor_completion_conflict"
    );
  }
  await markAlignmentFailed(
    env.DB,
    job,
    failureCode,
    "The signed alignment processor reported a bounded failure."
  );
  const failed = await loadAlignmentJob(env.DB, job.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    job: failed ? presentAlignmentJob(failed) : null,
    idempotent: false
  });
}

async function persistAlignmentWords(
  db: D1Database,
  job: AlignmentJobRow,
  words: Array<{
    wordId: string;
    cueId: string;
    text: string;
    startsAtMs: number | null;
    endsAtMs: number | null;
    confidence: number | null;
    timingOrigin: string | null;
    unalignedReason: string | null;
  }>
): Promise<void> {
  for (let offset = 0; offset < words.length; offset += RESULT_INSERT_BATCH_SIZE) {
    const batch = words
      .slice(offset, offset + RESULT_INSERT_BATCH_SIZE)
      .map((word, index) => ({
        ...word,
        position: offset + index,
        timingStatus:
          word.startsAtMs === null || word.timingOrigin === "interpolated"
            ? "unaligned"
            : "aligned"
      }));
    await db.prepare(
      `INSERT OR IGNORE INTO transcript_words (
         id, transcript_id, position, word, starts_at_ms, ends_at_ms,
         confidence, alignment_revision_id, cue_id, timing_status,
         timing_origin, unaligned_reason
       )
       SELECT
         json_extract(value, '$.wordId'), ?,
         json_extract(value, '$.position'),
         json_extract(value, '$.text'),
         json_extract(value, '$.startsAtMs'),
         json_extract(value, '$.endsAtMs'),
         json_extract(value, '$.confidence'), ?,
         json_extract(value, '$.cueId'),
         json_extract(value, '$.timingStatus'),
         json_extract(value, '$.timingOrigin'),
         json_extract(value, '$.unalignedReason')
       FROM json_each(?)`
    ).bind(
      job.transcript_id,
      job.alignment_revision_id,
      JSON.stringify(batch)
    ).run();
  }
  const evidence = await db.prepare(
    `SELECT COUNT(*) AS word_count,
            COUNT(DISTINCT position) AS position_count,
            MIN(position) AS minimum_position,
            MAX(position) AS maximum_position
     FROM transcript_words
     WHERE alignment_revision_id = ?`
  ).bind(job.alignment_revision_id).first<{
    word_count: number;
    position_count: number;
    minimum_position: number | null;
    maximum_position: number | null;
  }>();
  if (
    evidence?.word_count !== words.length
    || evidence.position_count !== words.length
    || evidence.minimum_position !== 0
    || evidence.maximum_position !== words.length - 1
  ) {
    throw new Error("Alignment word projection storage is incomplete");
  }
}

async function putImmutableAlignmentResult(
  bucket: R2Bucket,
  key: string,
  body: string,
  sha256: string,
  job: AlignmentJobRow
): Promise<void> {
  const objectBytes = new TextEncoder().encode(body).byteLength;
  if (objectBytes < 1 || objectBytes > MAXIMUM_ALIGNMENT_RESULT_BYTES) {
    throw new Error("Alignment result artifact exceeds its byte contract");
  }
  const existing = await bucket.head(key);
  if (existing) {
    if (
      existing.size !== objectBytes
      || existing.checksums.toJSON().sha256 !== sha256
      || existing.customMetadata?.sha256 !== sha256
      || existing.customMetadata?.["alignment-job-id"] !== job.id
    ) {
      throw new Error("Alignment result artifact changed");
    }
    return;
  }
  const stored = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store, max-age=0"
    },
    customMetadata: {
      sha256,
      "alignment-job-id": job.id,
      "alignment-revision-id": job.alignment_revision_id,
      "source-audio-sha256": job.source_audio_sha256,
      "transcript-content-sha256": job.transcript_content_sha256
    },
    sha256
  });
  const verified = stored ?? await bucket.head(key);
  if (
    !verified
    || verified.size !== objectBytes
    || verified.checksums.toJSON().sha256 !== sha256
    || verified.customMetadata?.sha256 !== sha256
  ) {
    throw new Error("Alignment result artifact storage could not be verified");
  }
}

async function markAlignmentFailed(
  db: D1Database,
  job: AlignmentJobRow,
  failureCode: string,
  message: string
): Promise<void> {
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.batch([
    db.prepare(
      `UPDATE transcript_alignment_jobs
       SET
         status = 'failed',
         failure_code = ?,
         last_error = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')`
    ).bind(failureCode, message.slice(0, 500), job.id),
    db.prepare(
      `UPDATE transcript_alignment_revisions
       SET status = 'failed', completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ? AND status = 'processing'`
    ).bind(job.alignment_revision_id),
    db.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'alignment.failed', 'transcript_alignment_job', id, ?
       FROM transcript_alignment_jobs
       WHERE id = ? AND status = 'failed'`
    ).bind(
      auditId,
      JSON.stringify({
        episodeId: job.episode_id,
        transcriptId: job.transcript_id,
        alignmentRevisionId: job.alignment_revision_id,
        failureCode
      }),
      job.id
    )
  ]);
}

async function markAlignmentStale(
  db: D1Database,
  job: AlignmentJobRow
): Promise<void> {
  const transcriptChanged =
    job.current_transcript_revision !== job.transcript_revision
    || job.current_transcript_sha256 !== job.transcript_content_sha256;
  const failureCode = transcriptChanged
    ? "transcript_changed"
    : "working_master_changed";
  await db.batch([
    db.prepare(
      `UPDATE transcript_alignment_jobs
       SET
         status = 'stale',
         failure_code = ?,
         last_error = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'running', 'ready')`
    ).bind(
      failureCode,
      transcriptChanged
        ? "The reviewed transcript changed."
        : "The approved working master changed.",
      job.id
    ),
    db.prepare(
      `UPDATE transcript_alignment_revisions
       SET status = 'superseded', updated_at = datetime('now')
       WHERE id = ? AND status IN ('processing', 'needs_review', 'passed')`
    ).bind(job.alignment_revision_id)
  ]);
}

async function reopenRetryableAlignment(
  db: D1Database,
  job: AlignmentJobRow
): Promise<AlignmentJobRow> {
  if (
    job.status === "failed"
    && job.attempt_count < 5
    && !["source_invalid", "transcript_invalid"].includes(
      job.failure_code ?? ""
    )
  ) {
    await db.batch([
      db.prepare(
        `UPDATE transcript_alignment_jobs
         SET
           status = 'queued',
           result_manifest_sha256 = NULL,
           quality_report_json = NULL,
           failure_code = NULL,
           last_error = NULL,
           started_at = NULL,
           completed_at = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND status = 'failed' AND attempt_count < 5`
      ).bind(job.id),
      db.prepare(
        `UPDATE transcript_alignment_revisions
         SET
           status = 'processing',
           quality_report_json = '{}',
           completed_at = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND status = 'failed'`
      ).bind(job.alignment_revision_id)
    ]);
    return (await loadAlignmentJob(db, job.id)) as AlignmentJobRow;
  }
  return job;
}

async function loadAlignmentSource(
  db: D1Database,
  episodeId: string,
  language: string
): Promise<AlignmentSourceRow | null> {
  return db.prepare(
    `${alignmentSourceSelect()}
     WHERE transcript.episode_id = ? AND transcript.language = ?`
  ).bind(episodeId, language).first<AlignmentSourceRow>();
}

function alignmentSourceSelect(): string {
  return `SELECT
      transcript.id AS transcript_id,
      transcript.episode_id,
      episode.show_id,
      transcript.language,
      transcript.status AS transcript_status,
      transcript.revision AS transcript_revision,
      transcript.approved_revision,
      transcript.content_json AS transcript_content_json,
      transcript.content_sha256 AS transcript_content_sha256,
      state.current_master_id,
      master.id AS working_master_id,
      master.object_key AS source_object_key,
      master.object_bytes AS source_object_bytes,
      master.object_etag AS source_object_etag,
      master.mime_type AS source_mime_type,
      master.source_sha256 AS source_audio_sha256,
      qc.duration_ms AS source_duration_ms
    FROM transcripts transcript
    JOIN episodes episode ON episode.id = transcript.episode_id
    LEFT JOIN episode_working_master_states state
      ON state.episode_id = transcript.episode_id
    LEFT JOIN episode_working_masters master
      ON master.id = state.current_master_id
     AND master.episode_id = transcript.episode_id
    LEFT JOIN audio_qc_runs qc
      ON qc.id = master.quality_control_run_id
     AND qc.status = 'succeeded'
     AND qc.blocker_count = 0`;
}

async function projectionForSource(
  source: AlignmentSourceRow
): Promise<AlignmentTranscriptProjection> {
  let parsed;
  try {
    parsed = JSON.parse(source.transcript_content_json);
  } catch {
    throw new RequestValidationError(
      "The approved transcript content is invalid",
      "alignment_transcript_invalid"
    );
  }
  if (
    parsed?.schemaVersion !== 1
    || parsed.language !== source.language
    || !Array.isArray(parsed.cues)
  ) {
    throw new RequestValidationError(
      "The approved transcript content is invalid",
      "alignment_transcript_invalid"
    );
  }
  const cues = normalizeTranscriptCues(
    parsed.cues,
    source.source_duration_ms
  );
  return buildAlignmentTranscriptProjection({
    transcriptId: source.transcript_id,
    contentSha256: source.transcript_content_sha256,
    language: alignmentLanguage(source.language),
    cues
  });
}

async function findAlignmentJob(
  db: D1Database,
  requestId: string,
  inputFingerprint: string
): Promise<AlignmentJobRow | null> {
  return db.prepare(
    `${alignmentJobSelect()}
     WHERE job.request_id = ? OR job.input_fingerprint = ?
     ORDER BY CASE WHEN job.request_id = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(requestId, inputFingerprint, requestId).first<AlignmentJobRow>();
}

async function loadAlignmentJob(
  db: D1Database,
  jobId: string
): Promise<AlignmentJobRow | null> {
  return db.prepare(
    `${alignmentJobSelect()} WHERE job.id = ?`
  ).bind(jobId).first<AlignmentJobRow>();
}

function alignmentJobSelect(): string {
  return `SELECT
      job.id, job.request_id, job.alignment_revision_id, job.transcript_id,
      job.episode_id, episode.show_id, job.working_master_id,
      job.source_object_key, job.source_object_bytes, job.source_object_etag,
      job.source_mime_type, job.source_duration_ms, job.source_audio_sha256,
      job.transcript_revision, job.transcript_content_sha256,
      job.transcript_projection_json, job.transcript_projection_sha256,
      job.language, job.adapter, job.adapter_version, job.model,
      job.model_version, job.settings_version, job.runner_revision,
      job.runner_digest, job.processor_manifest_sha256,
      job.result_object_key, job.input_fingerprint, job.status,
      job.attempt_count, job.result_manifest_sha256,
      job.quality_report_json, job.failure_code, job.last_error,
      job.requested_at, job.started_at, job.completed_at, job.updated_at,
      state.current_master_id,
      transcript.revision AS current_transcript_revision,
      transcript.content_sha256 AS current_transcript_sha256,
      transcript.status AS current_transcript_status,
      revision.status AS alignment_status,
      (
        SELECT benchmark.id
        FROM alignment_benchmark_runs benchmark
        WHERE benchmark.status = 'passed'
          AND benchmark.clean_environment_reproduced = 1
          AND benchmark.adapter = job.adapter
          AND benchmark.adapter_version = job.adapter_version
          AND benchmark.model = job.model
          AND benchmark.model_version = job.model_version
          AND benchmark.settings_version = job.settings_version
          AND benchmark.runner_digest = job.runner_digest
        ORDER BY benchmark.completed_at DESC, benchmark.id DESC
        LIMIT 1
      ) AS benchmark_run_id
    FROM transcript_alignment_jobs job
    JOIN episodes episode ON episode.id = job.episode_id
    JOIN transcripts transcript ON transcript.id = job.transcript_id
    JOIN transcript_alignment_revisions revision
      ON revision.id = job.alignment_revision_id
    LEFT JOIN episode_working_master_states state
      ON state.episode_id = job.episode_id`;
}

function alignmentJobCandidate({
  source,
  projection,
  adapter,
  requestId,
  inputFingerprint,
  jobId,
  alignmentRevisionId,
  resultObjectKey
}: {
  source: AlignmentSourceRow;
  projection: AlignmentTranscriptProjection;
  adapter: AlignmentRunnerAdapterIdentity;
  requestId: string;
  inputFingerprint: string;
  jobId: string;
  alignmentRevisionId: string;
  resultObjectKey: string;
}): AlignmentJobRow {
  return {
    id: jobId,
    request_id: requestId,
    alignment_revision_id: alignmentRevisionId,
    transcript_id: source.transcript_id,
    episode_id: source.episode_id,
    show_id: source.show_id,
    working_master_id: source.working_master_id,
    source_object_key: source.source_object_key,
    source_object_bytes: source.source_object_bytes,
    source_object_etag: source.source_object_etag,
    source_mime_type: source.source_mime_type,
    source_duration_ms: source.source_duration_ms,
    source_audio_sha256: source.source_audio_sha256,
    transcript_revision: source.transcript_revision,
    transcript_content_sha256: source.transcript_content_sha256,
    transcript_projection_json: JSON.stringify(projection),
    transcript_projection_sha256: projection.projectionSha256,
    language: source.language,
    adapter: adapter.name,
    adapter_version: adapter.version,
    model: adapter.model,
    model_version: adapter.modelVersion,
    settings_version: adapter.settingsVersion,
    runner_revision: RUNNER_REVISION,
    runner_digest: RUNNER_DIGEST,
    processor_manifest_sha256: "",
    result_object_key: resultObjectKey,
    input_fingerprint: inputFingerprint,
    status: "queued",
    attempt_count: 0,
    result_manifest_sha256: null,
    quality_report_json: null,
    failure_code: null,
    last_error: null,
    requested_at: "",
    started_at: null,
    completed_at: null,
    updated_at: "",
    current_master_id: source.current_master_id,
    current_transcript_revision: source.transcript_revision,
    current_transcript_sha256: source.transcript_content_sha256,
    current_transcript_status: source.transcript_status,
    alignment_status: "processing",
    benchmark_run_id: null
  };
}

function presentAlignmentSource(
  source: AlignmentSourceRow
): Record<string, unknown> {
  return {
    transcriptId: source.transcript_id,
    language: source.language,
    transcriptStatus: source.transcript_status,
    transcriptRevision: source.transcript_revision,
    approvedRevision: source.approved_revision,
    transcriptContentSha256: source.transcript_content_sha256,
    currentWorkingMasterId: source.current_master_id,
    workingMasterSha256: source.source_audio_sha256,
    sourceDurationMs: source.source_duration_ms,
    eligible:
      source.transcript_status === "approved"
      && source.approved_revision === source.transcript_revision
      && Boolean(source.current_master_id)
  };
}

function presentAlignmentJob(job: AlignmentJobRow): Record<string, unknown> {
  return {
    id: job.id,
    requestId: job.request_id,
    alignmentRevisionId: job.alignment_revision_id,
    transcriptId: job.transcript_id,
    transcriptRevision: job.transcript_revision,
    transcriptContentSha256: job.transcript_content_sha256,
    transcriptProjectionSha256: job.transcript_projection_sha256,
    workingMasterId: job.working_master_id,
    sourceAudioSha256: job.source_audio_sha256,
    language: job.language,
    adapter: {
      name: job.adapter,
      version: job.adapter_version,
      model: job.model,
      modelVersion: job.model_version,
      settingsVersion: job.settings_version
    },
    runner: {
      repository: RUNNER_REPOSITORY,
      revision: job.runner_revision,
      digest: job.runner_digest
    },
    status: job.status,
    alignmentStatus: job.alignment_status,
    attemptCount: job.attempt_count,
    resultManifestSha256: job.result_manifest_sha256,
    quality: parseQuality(job.quality_report_json),
    benchmark: {
      passedRunId: job.benchmark_run_id,
      requiredForApproval: true
    },
    workflow: ["queued", "running"].includes(job.status)
      ? {
          repository: "aindaco1/dust-wave-podcast",
          filename: "process-alignment.yml",
          input: { job_id: job.id }
        }
      : null,
    failure: job.failure_code
      ? { code: job.failure_code, message: job.last_error }
      : null,
    requestedAt: job.requested_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    updatedAt: job.updated_at
  };
}

function adapterFromJob(job: AlignmentJobRow): AlignmentRunnerAdapterIdentity {
  return {
    name: job.adapter as AlignmentRunnerAdapterIdentity["name"],
    version: job.adapter_version,
    model: job.model,
    modelVersion: job.model_version,
    settingsVersion: job.settings_version,
    runnerDigest: job.runner_digest as `sha256:${string}`
  };
}

function alignmentAdapter(value: unknown): AlignmentRunnerAdapterIdentity {
  const key = String(value ?? "whisperx");
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new RequestValidationError(
      "adapter must be whisperx or stable-ts"
    );
  }
  return { ...adapter };
}

function alignmentLanguage(value: unknown): "en" | "es" {
  if (value !== "en" && value !== "es") {
    throw new RequestValidationError("language must be en or es");
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return Number(value);
}

function parseProjection(value: string): AlignmentTranscriptProjection {
  try {
    return JSON.parse(value) as AlignmentTranscriptProjection;
  } catch {
    throw new Error("Stored alignment transcript projection is invalid");
  }
}

function parseQuality(
  value: string | null
): {
  alignedWordRatio: number;
  structurallyEligible: boolean;
  [key: string]: unknown;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed
      && typeof parsed === "object"
      && Number.isFinite(parsed.alignedWordRatio)
      && typeof parsed.structurallyEligible === "boolean"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function alignmentConflict(
  request: Request,
  env: PodcastEnv,
  code: string,
  details: Record<string, unknown> = {}
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: code, ...details },
    { status: 409 }
  );
}

function processorAuthError(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "invalid_processor_signature" },
    { status: 401 }
  );
}

function r2EtagMatches(
  object: Pick<R2Object, "etag" | "httpEtag">,
  expected: string
): boolean {
  return object.etag === expected
    || object.httpEtag === expected
    || object.httpEtag === `"${expected}"`
    || `"${object.etag}"` === expected;
}
