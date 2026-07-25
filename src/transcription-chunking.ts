import {
  buildTranscriptionChunkProcessorManifest,
  DEFAULT_TRANSCRIPTION_CHUNK_POLICY,
  MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
  TRANSCRIPTION_CHUNK_PROCESSOR_SCHEMA,
  TRANSCRIPTION_CHUNK_PROCESSOR_VERSION,
  validateTranscriptionChunkPlan,
  type TranscriptionChunk,
  type TranscriptionChunkPlan,
  type TranscriptionChunkPolicy,
  type TranscriptionChunkProcessorManifest
} from "@dustwave/timed-text/chunking";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  readSignedJsonBody,
  verifySignedText
} from "./signed-callback";
import {
  RequestValidationError,
  validIdentifier
} from "./validation";

const PROCESSOR_UPLOAD_PAYLOAD_HEADER = "x-podcast-processor-payload";
const MAXIMUM_CALLBACK_BYTES = 750_000;
const MAXIMUM_REPORT_CHUNKS = 256;
const FAILURE_CODES = new Set([
  "processor_failed",
  "source_invalid",
  "plan_invalid",
  "chunk_invalid",
  "upload_failed"
]);

export { MAXIMUM_TRANSCRIPTION_CHUNK_BYTES };

export type ChunkableTranscriptionJob = {
  id: string;
  episode_id: string;
  show_id: string;
  working_master_id: string;
  working_master_sha256: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  source_mime_type: string;
  source_duration_ms: number;
  language: string;
  input_fingerprint: string;
  status: string;
  attempt_count: number;
};

export type TranscriptionChunkRunRow = {
  id: string;
  transcription_job_id: string;
  processor_manifest_sha256: string;
  policy_json: string;
  status: string;
  attempt_count: number;
  plan_json: string | null;
  plan_sha256: string | null;
  report_sha256: string | null;
  processor_version: string | null;
  chunk_count: number | null;
  total_output_bytes: number | null;
  failure_code: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type PreparedTranscriptionChunkRow = {
  run_id: string;
  chunk_index: number;
  core_starts_at_ms: number;
  core_ends_at_ms: number;
  media_starts_at_ms: number;
  media_ends_at_ms: number;
  encoded_duration_ms: number;
  boundary_kind: "silence" | "duration" | "end";
  object_key: string;
  object_bytes: number;
  object_etag: string;
  mime_type: "audio/mpeg";
  sha256: string;
  provider_status: string;
  provider_attempt_count: number;
  provider_raw_object_key: string;
  provider_raw_sha256: string | null;
  provider_request_id: string | null;
  last_error: string | null;
};

type ChunkProcessorContext = ChunkableTranscriptionJob & {
  run: TranscriptionChunkRunRow;
};

export async function ensureTranscriptionChunkRun(
  env: PodcastEnv,
  job: ChunkableTranscriptionJob
): Promise<TranscriptionChunkRunRow> {
  const runId = chunkRunId(job);
  const policyJson = JSON.stringify(DEFAULT_TRANSCRIPTION_CHUNK_POLICY);
  const candidate = await buildProcessorManifest(env, job, runId);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO transcription_chunk_runs (
       id, transcription_job_id, processor_manifest_sha256, policy_json
     ) VALUES (?, ?, ?, ?)`
  ).bind(
    runId,
    job.id,
    candidate.manifestSha256,
    policyJson
  ).run();
  let run = await loadTranscriptionChunkRun(env.DB, job.id);
  if (!run) {
    throw new Error("Transcription chunk run could not be created");
  }
  if (
    run.processor_manifest_sha256 !== candidate.manifestSha256
    || run.policy_json !== policyJson
  ) {
    throw new Error("Immutable transcription chunk manifest conflict");
  }
  if (
    run.status === "failed"
    && run.attempt_count < 5
    && job.status !== "stale"
  ) {
    await env.DB.prepare(
      `UPDATE transcription_chunk_runs
       SET
         status = 'queued',
         plan_json = NULL,
         plan_sha256 = NULL,
         report_sha256 = NULL,
         processor_version = NULL,
         chunk_count = NULL,
         total_output_bytes = NULL,
         failure_code = NULL,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'failed' AND attempt_count < 5`
    ).bind(run.id).run();
    run = (await loadTranscriptionChunkRun(env.DB, job.id)) as
      TranscriptionChunkRunRow;
  }
  return run;
}

export async function loadTranscriptionChunkRun(
  db: D1Database,
  jobId: string
): Promise<TranscriptionChunkRunRow | null> {
  return db.prepare(
    `SELECT
       id, transcription_job_id, processor_manifest_sha256, policy_json,
       status, attempt_count, plan_json, plan_sha256, report_sha256,
       processor_version, chunk_count, total_output_bytes, failure_code,
       last_error, created_at, started_at, completed_at, updated_at
     FROM transcription_chunk_runs
     WHERE transcription_job_id = ?`
  ).bind(jobId).first<TranscriptionChunkRunRow>();
}

export async function listPreparedTranscriptionChunks(
  db: D1Database,
  jobId: string
): Promise<PreparedTranscriptionChunkRow[]> {
  const rows = await db.prepare(
    `SELECT
       chunk.run_id, chunk.chunk_index, chunk.core_starts_at_ms,
       chunk.core_ends_at_ms, chunk.media_starts_at_ms,
       chunk.media_ends_at_ms, chunk.encoded_duration_ms,
       chunk.boundary_kind, chunk.object_key,
       chunk.object_bytes, chunk.object_etag, chunk.mime_type, chunk.sha256,
       chunk.provider_status, chunk.provider_attempt_count,
       chunk.provider_raw_object_key, chunk.provider_raw_sha256,
       chunk.provider_request_id, chunk.last_error
     FROM transcription_chunks chunk
     JOIN transcription_chunk_runs run ON run.id = chunk.run_id
     WHERE run.transcription_job_id = ? AND run.status = 'ready'
     ORDER BY chunk.chunk_index`
  ).bind(jobId).all<PreparedTranscriptionChunkRow>();
  return rows.results;
}

export function presentTranscriptionChunkRun(
  run: TranscriptionChunkRunRow | null
): Record<string, unknown> | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    attemptCount: run.attempt_count,
    processorManifestSha256: run.processor_manifest_sha256,
    planSha256: run.plan_sha256,
    reportSha256: run.report_sha256,
    processorVersion: run.processor_version,
    chunkCount: run.chunk_count,
    totalOutputBytes: run.total_output_bytes,
    failure: run.failure_code
      ? { code: run.failure_code, message: run.last_error }
      : null,
    workflow: {
      repository: "aindaco1/dust-wave-podcast",
      filename: "process-transcription-chunks.yml",
      input: { run_id: run.id }
    },
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    updatedAt: run.updated_at
  };
}

export async function getTranscriptionChunkProcessorManifest(
  request: Request,
  env: PodcastEnv,
  runIdValue: string
): Promise<Response> {
  const context = await authorizeProcessorAction(
    request,
    env,
    runIdValue,
    "manifest"
  );
  if (context instanceof Response) return context;
  const manifest = await rebuildProcessorManifest(env, context);
  if (!manifest) {
    return chunkConflict(request, env, "transcription_chunk_manifest_mismatch");
  }
  await env.DB.prepare(
    `UPDATE transcription_chunk_runs
     SET
       status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       attempt_count = CASE
         WHEN status = 'queued' THEN attempt_count + 1
         ELSE attempt_count
       END,
       started_at = CASE
         WHEN status = 'queued' THEN datetime('now')
         ELSE started_at
       END,
       updated_at = datetime('now')
     WHERE id = ?
       AND status IN ('queued', 'running')
       AND attempt_count < 5`
  ).bind(context.run.id).run();
  const refreshed = await loadProcessorContext(env.DB, context.run.id);
  if (
    !refreshed
    || (
      refreshed.run.status === "queued"
      && refreshed.run.attempt_count >= 5
    )
  ) {
    return chunkConflict(request, env, "transcription_chunk_attempts_exhausted");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    processorManifest: manifest
  });
}

export async function getTranscriptionChunkProcessorSource(
  request: Request,
  env: PodcastEnv,
  runIdValue: string
): Promise<Response> {
  const context = await authorizeProcessorAction(
    request,
    env,
    runIdValue,
    "source"
  );
  if (context instanceof Response) return context;
  if (!await rebuildProcessorManifest(env, context)) {
    return chunkConflict(request, env, "transcription_chunk_manifest_mismatch");
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
    return chunkConflict(request, env, "transcription_chunk_source_mismatch");
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

export async function uploadTranscriptionChunkProcessorOutput(
  request: Request,
  env: PodcastEnv,
  runIdValue: string,
  indexValue: string
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging" || !env.MEDIA_PROCESSOR_CALLBACK_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const runId = validIdentifier(runIdValue, "runId");
  const chunkIndex = boundedInteger(indexValue, 0, 255, "chunkIndex");
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
  if (payload.runId !== runId || payload.chunkIndex !== chunkIndex) {
    throw new RequestValidationError(
      "The transcription chunk does not match its URL"
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    request.headers.get("content-type") !== "audio/mpeg"
    || contentLength !== payload.objectBytes
    || !request.body
  ) {
    throw new RequestValidationError(
      "The transcription chunk body does not match its signed payload"
    );
  }
  const context = await loadProcessorContext(env.DB, runId);
  if (!context) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcription_chunk_run_not_found" },
      { status: 404 }
    );
  }
  if (
    !["queued", "running"].includes(context.run.status)
    || payload.manifestSha256
      !== context.run.processor_manifest_sha256
  ) {
    return chunkConflict(request, env, "transcription_chunk_upload_conflict");
  }
  const objectKey = chunkObjectKey(context, chunkIndex);
  const existing = await env.MEDIA_BUCKET.head(objectKey);
  if (existing) {
    if (!validUploadedChunk(
      existing,
      payload,
      context.run.processor_manifest_sha256,
      chunkIndex
    )) {
      return chunkConflict(request, env, "transcription_chunk_upload_conflict");
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      object: {
        chunkIndex,
        objectBytes: existing.size,
        sha256: payload.sha256,
        mimeType: "audio/mpeg"
      },
      checksumVerified: true,
      idempotent: true
    });
  }
  const stored = await env.MEDIA_BUCKET.put(objectKey, request.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "audio/mpeg",
      cacheControl: "private, no-store, max-age=0"
    },
    customMetadata: {
      sha256: payload.sha256,
      "transcription-chunk-manifest-sha256": payload.manifestSha256,
      "transcription-chunk-index": String(chunkIndex)
    },
    sha256: payload.sha256
  });
  const verified = stored ?? await env.MEDIA_BUCKET.head(objectKey);
  if (
    !verified
    || !validUploadedChunk(
      verified,
      payload,
      context.run.processor_manifest_sha256,
      chunkIndex
    )
  ) {
    return chunkConflict(request, env, "transcription_chunk_upload_mismatch");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    object: {
      chunkIndex,
      objectBytes: verified.size,
      sha256: payload.sha256,
      mimeType: "audio/mpeg"
    },
    checksumVerified: true,
    idempotent: false
  });
}

export async function completeTranscriptionChunkRun(
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
    maximumBytes: MAXIMUM_CALLBACK_BYTES,
    bodyName: "Transcription chunk processor evidence",
    invalidBodyCode: "invalid_transcription_chunk_processor_body"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  const context = await loadProcessorContext(env.DB, runId);
  if (!context) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcription_chunk_run_not_found" },
      { status: 404 }
    );
  }
  if (
    signed.body.runId !== runId
    || signed.body.jobId !== context.id
    || signed.body.manifestSha256
      !== context.run.processor_manifest_sha256
  ) {
    throw new RequestValidationError(
      "Transcription chunk evidence does not match its URL or manifest"
    );
  }
  if (signed.body.status === "failed") {
    return completeChunkFailure(request, env, context, signed.body);
  }
  if (signed.body.status !== "succeeded") {
    throw new RequestValidationError("status is invalid");
  }
  const report = await validateChunkReport(env, context, signed.body);
  if (
    context.run.status === "ready"
    && context.run.report_sha256 === report.reportSha256
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      run: presentTranscriptionChunkRun(context.run),
      idempotent: true
    });
  }
  if (!["queued", "running"].includes(context.run.status)) {
    return chunkConflict(request, env, "transcription_chunk_completion_conflict");
  }
  const chunkRowsJson = JSON.stringify(report.chunks.map((chunk) => ({
    ...chunk,
    providerRawObjectKey:
      `${transcriptionArtifactPrefix(context)}/chunks/`
      + `${String(chunk.chunkIndex).padStart(3, "0")}/provider-response.json`
  })));
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcription_chunks (
         run_id, chunk_index, core_starts_at_ms, core_ends_at_ms,
         media_starts_at_ms, media_ends_at_ms, encoded_duration_ms,
         boundary_kind, object_key,
         object_bytes, object_etag, mime_type, sha256,
         provider_raw_object_key
       )
       SELECT
         ?, json_extract(value, '$.chunkIndex'),
         json_extract(value, '$.coreStartsAtMs'),
         json_extract(value, '$.coreEndsAtMs'),
         json_extract(value, '$.mediaStartsAtMs'),
         json_extract(value, '$.mediaEndsAtMs'),
         json_extract(value, '$.encodedDurationMs'),
         json_extract(value, '$.boundaryKind'),
         json_extract(value, '$.objectKey'),
         json_extract(value, '$.objectBytes'),
         json_extract(value, '$.objectEtag'),
         'audio/mpeg',
         json_extract(value, '$.sha256'),
         json_extract(value, '$.providerRawObjectKey')
       FROM json_each(?)`
    ).bind(runId, chunkRowsJson),
    env.DB.prepare(
      `UPDATE transcription_chunk_runs
       SET
         status = 'ready',
         plan_json = ?,
         plan_sha256 = ?,
         report_sha256 = ?,
         processor_version = ?,
         chunk_count = ?,
         total_output_bytes = ?,
         failure_code = NULL,
         last_error = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('queued', 'running')
         AND processor_manifest_sha256 = ?
         AND (
           SELECT COUNT(*)
           FROM transcription_chunks chunk
           WHERE chunk.run_id = transcription_chunk_runs.id
         ) = ?
         AND NOT EXISTS (
           SELECT 1
           FROM transcription_chunks chunk
           JOIN json_each(?) evidence
             ON json_extract(evidence.value, '$.chunkIndex')
               = chunk.chunk_index
           WHERE chunk.run_id = transcription_chunk_runs.id
             AND (
               chunk.core_starts_at_ms
                 != json_extract(evidence.value, '$.coreStartsAtMs')
               OR chunk.core_ends_at_ms
                 != json_extract(evidence.value, '$.coreEndsAtMs')
               OR chunk.media_starts_at_ms
                 != json_extract(evidence.value, '$.mediaStartsAtMs')
               OR chunk.media_ends_at_ms
                 != json_extract(evidence.value, '$.mediaEndsAtMs')
               OR chunk.encoded_duration_ms
                 != json_extract(evidence.value, '$.encodedDurationMs')
               OR chunk.boundary_kind
                 != json_extract(evidence.value, '$.boundaryKind')
               OR chunk.object_key
                 != json_extract(evidence.value, '$.objectKey')
               OR chunk.object_bytes
                 != json_extract(evidence.value, '$.objectBytes')
               OR chunk.object_etag
                 != json_extract(evidence.value, '$.objectEtag')
               OR chunk.sha256 != json_extract(evidence.value, '$.sha256')
             )
         )`
    ).bind(
      JSON.stringify(report.plan),
      report.planSha256,
      report.reportSha256,
      report.processorVersion,
      report.chunks.length,
      report.totalOutputBytes,
      runId,
      context.run.processor_manifest_sha256,
      report.chunks.length,
      chunkRowsJson
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'transcription.chunks_ready',
              'transcription_chunk_run', id, ?
       FROM transcription_chunk_runs
       WHERE id = ? AND status = 'ready' AND changes() = 1`
    ).bind(
      auditId,
      JSON.stringify({
        jobId: context.id,
        episodeId: context.episode_id,
        workingMasterId: context.working_master_id,
        workingMasterSha256: context.working_master_sha256,
        processorManifestSha256: context.run.processor_manifest_sha256,
        planSha256: report.planSha256,
        reportSha256: report.reportSha256,
        processorVersion: report.processorVersion,
        chunkCount: report.chunks.length,
        totalOutputBytes: report.totalOutputBytes
      }),
      runId
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return chunkConflict(request, env, "transcription_chunk_completion_conflict");
  }
  await env.JOBS.send({
    id: context.id,
    type: "transcribe",
    showId: context.show_id,
    episodeId: context.episode_id,
    requestedAt: new Date().toISOString()
  }).catch(() => undefined);
  const ready = await loadTranscriptionChunkRun(env.DB, context.id);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    run: presentTranscriptionChunkRun(ready),
    idempotent: false
  });
}

async function authorizeProcessorAction(
  request: Request,
  env: PodcastEnv,
  runIdValue: string,
  action: "manifest" | "source"
): Promise<ChunkProcessorContext | Response> {
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
    bodyName: `Transcription chunk ${action} request`,
    invalidBodyCode: "invalid_transcription_chunk_processor_request"
  });
  if (!signed.ok) {
    return processorAuthError(request, env, signed.reason);
  }
  if (signed.body.runId !== runId || signed.body.action !== action) {
    throw new RequestValidationError(
      `The ${action} request does not match its URL or action`
    );
  }
  const context = await loadProcessorContext(env.DB, runId);
  if (!context) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcription_chunk_run_not_found" },
      { status: 404 }
    );
  }
  if (!["queued", "running"].includes(context.run.status)) {
    return chunkConflict(request, env, "transcription_chunk_run_not_open");
  }
  return context;
}

async function buildProcessorManifest(
  env: PodcastEnv,
  job: ChunkableTranscriptionJob,
  runId: string
): Promise<TranscriptionChunkProcessorManifest> {
  const origin = env.FEED_ORIGIN.replace(/\/$/, "");
  return buildTranscriptionChunkProcessorManifest({
    schemaVersion: TRANSCRIPTION_CHUNK_PROCESSOR_SCHEMA,
    processorVersion: TRANSCRIPTION_CHUNK_PROCESSOR_VERSION,
    runId,
    jobId: job.id,
    episodeId: job.episode_id,
    showId: job.show_id,
    workingMasterId: job.working_master_id,
    language: job.language as "en" | "es",
    source: {
      objectKey: job.source_object_key,
      objectBytes: job.source_object_bytes,
      etag: job.source_object_etag,
      mimeType: job.source_mime_type as
        | "audio/mpeg"
        | "audio/mp4"
        | "audio/wav"
        | "audio/x-wav"
        | "audio/flac"
        | "audio/x-flac",
      sha256: job.working_master_sha256,
      durationMs: job.source_duration_ms
    },
    policy: { ...DEFAULT_TRANSCRIPTION_CHUNK_POLICY },
    output: {
      keyPrefix: transcriptionChunkKeyPrefix(job),
      mimeType: "audio/mpeg" as const,
      maximumObjectBytes: MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
      uploadUrlTemplate:
        `${origin}/v1/processor/transcription-chunks/${runId}/chunks/{index}`
    },
    sourceUrl:
      `${origin}/v1/processor/transcription-chunks/${runId}/source`,
    callbackUrl:
      `${origin}/v1/processor/transcription-chunks/${runId}/complete`
  });
}

async function rebuildProcessorManifest(
  env: PodcastEnv,
  context: ChunkProcessorContext
): Promise<TranscriptionChunkProcessorManifest | null> {
  const manifest = await buildProcessorManifest(env, context, context.run.id);
  return manifest.manifestSha256
    === context.run.processor_manifest_sha256
    ? manifest
    : null;
}

async function loadProcessorContext(
  db: D1Database,
  runId: string
): Promise<ChunkProcessorContext | null> {
  const row = await db.prepare(
    `SELECT
       job.id, job.episode_id, episode.show_id, job.working_master_id,
       job.working_master_sha256, job.source_object_key,
       job.source_object_bytes, job.source_object_etag, job.source_mime_type,
       job.source_duration_ms, job.language, job.input_fingerprint,
       job.status, job.attempt_count,
       run.id AS run_id, run.transcription_job_id,
       run.processor_manifest_sha256, run.policy_json,
       run.status AS run_status, run.attempt_count AS run_attempt_count,
       run.plan_json, run.plan_sha256, run.report_sha256,
       run.processor_version, run.chunk_count, run.total_output_bytes,
       run.failure_code, run.last_error, run.created_at, run.started_at,
       run.completed_at, run.updated_at
     FROM transcription_chunk_runs run
     JOIN transcription_jobs job ON job.id = run.transcription_job_id
     JOIN episodes episode ON episode.id = job.episode_id
     WHERE run.id = ?`
  ).bind(runId).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    episode_id: String(row.episode_id),
    show_id: String(row.show_id),
    working_master_id: String(row.working_master_id),
    working_master_sha256: String(row.working_master_sha256),
    source_object_key: String(row.source_object_key),
    source_object_bytes: Number(row.source_object_bytes),
    source_object_etag: String(row.source_object_etag),
    source_mime_type: String(row.source_mime_type),
    source_duration_ms: Number(row.source_duration_ms),
    language: String(row.language),
    input_fingerprint: String(row.input_fingerprint),
    status: String(row.status),
    attempt_count: Number(row.attempt_count),
    run: {
      id: String(row.run_id),
      transcription_job_id: String(row.transcription_job_id),
      processor_manifest_sha256: String(row.processor_manifest_sha256),
      policy_json: String(row.policy_json),
      status: String(row.run_status),
      attempt_count: Number(row.run_attempt_count),
      plan_json: nullableString(row.plan_json),
      plan_sha256: nullableString(row.plan_sha256),
      report_sha256: nullableString(row.report_sha256),
      processor_version: nullableString(row.processor_version),
      chunk_count: nullableNumber(row.chunk_count),
      total_output_bytes: nullableNumber(row.total_output_bytes),
      failure_code: nullableString(row.failure_code),
      last_error: nullableString(row.last_error),
      created_at: String(row.created_at),
      started_at: nullableString(row.started_at),
      completed_at: nullableString(row.completed_at),
      updated_at: String(row.updated_at)
    }
  };
}

async function validateChunkReport(
  env: PodcastEnv,
  context: ChunkProcessorContext,
  body: Record<string, unknown>
): Promise<{
  plan: TranscriptionChunkPlan;
  planSha256: string;
  reportSha256: string;
  processorVersion: string;
  totalOutputBytes: number;
  chunks: Array<{
    chunkIndex: number;
    coreStartsAtMs: number;
    coreEndsAtMs: number;
    mediaStartsAtMs: number;
    mediaEndsAtMs: number;
    encodedDurationMs: number;
    boundaryKind: TranscriptionChunk["boundaryKind"];
    objectKey: string;
    objectBytes: number;
    objectEtag: string;
    sha256: string;
  }>;
}> {
  if (
    body.schemaVersion !== TRANSCRIPTION_CHUNK_PROCESSOR_SCHEMA
    || body.processorVersion !== TRANSCRIPTION_CHUNK_PROCESSOR_VERSION
    || body.sourceSha256 !== context.working_master_sha256
    || Number(body.sourceDurationMs) !== context.source_duration_ms
  ) {
    throw new RequestValidationError(
      "Transcription chunk processor identity is invalid"
    );
  }
  let plan: TranscriptionChunkPlan;
  try {
    plan = validateTranscriptionChunkPlan(body.plan, {
      sourceDurationMs: context.source_duration_ms,
      policy: JSON.parse(context.run.policy_json) as TranscriptionChunkPolicy
    });
  } catch {
    throw new RequestValidationError(
      "Transcription chunk plan is invalid",
      "invalid_transcription_chunk_plan"
    );
  }
  if (
    !Array.isArray(body.chunks)
    || body.chunks.length !== plan.chunks.length
    || body.chunks.length > MAXIMUM_REPORT_CHUNKS
  ) {
    throw new RequestValidationError(
      "Transcription chunk inventory is invalid"
    );
  }
  const chunks = [];
  let totalOutputBytes = 0;
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const expected = plan.chunks[index];
    const evidence = body.chunks[index] as Record<string, unknown> | null;
    const objectBytes = boundedInteger(
      evidence?.objectBytes,
      1,
      MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
      `chunk ${index + 1} objectBytes`
    );
    const sha256 = digest(evidence?.sha256, `chunk ${index + 1} sha256`);
    const expectedDurationMs =
      expected.mediaEndsAtMs - expected.mediaStartsAtMs;
    const encodedDurationMs = boundedInteger(
      evidence?.encodedDurationMs,
      Math.max(1, expectedDurationMs - 2_000),
      expectedDurationMs + 2_000,
      `chunk ${index + 1} encodedDurationMs`
    );
    if (Number(evidence?.chunkIndex) !== index) {
      throw new RequestValidationError(
        `Transcription chunk ${index + 1} index is invalid`
      );
    }
    const objectKey = chunkObjectKey(context, index);
    const object = await env.MEDIA_BUCKET.head(objectKey);
    if (
      !object
      || object.size !== objectBytes
      || object.httpMetadata?.contentType !== "audio/mpeg"
      || object.checksums.toJSON().sha256 !== sha256
      || object.customMetadata?.sha256 !== sha256
      || object.customMetadata?.["transcription-chunk-manifest-sha256"]
        !== context.run.processor_manifest_sha256
      || object.customMetadata?.["transcription-chunk-index"] !== String(index)
    ) {
      throw new RequestValidationError(
        `Transcription chunk ${index + 1} stored evidence is invalid`
      );
    }
    totalOutputBytes += objectBytes;
    chunks.push({
      chunkIndex: index,
      coreStartsAtMs: expected.coreStartsAtMs,
      coreEndsAtMs: expected.coreEndsAtMs,
      mediaStartsAtMs: expected.mediaStartsAtMs,
      mediaEndsAtMs: expected.mediaEndsAtMs,
      encodedDurationMs,
      boundaryKind: expected.boundaryKind,
      objectKey,
      objectBytes,
      objectEtag: object.httpEtag,
      sha256
    });
  }
  const planJson = JSON.stringify(plan);
  const planSha256 = await sha256Hex(planJson);
  if (body.planSha256 !== planSha256) {
    throw new RequestValidationError(
      "Transcription chunk plan digest is invalid"
    );
  }
  const reportBase = {
    schemaVersion: TRANSCRIPTION_CHUNK_PROCESSOR_SCHEMA,
    status: "succeeded",
    runId: context.run.id,
    jobId: context.id,
    manifestSha256: context.run.processor_manifest_sha256,
    processorVersion: TRANSCRIPTION_CHUNK_PROCESSOR_VERSION,
    sourceSha256: context.working_master_sha256,
    sourceDurationMs: context.source_duration_ms,
    plan,
    planSha256,
    chunks: chunks.map(({ objectEtag: _objectEtag, ...chunk }) => chunk)
  };
  const reportSha256 = await sha256Hex(JSON.stringify(reportBase));
  if (body.reportSha256 !== reportSha256) {
    throw new RequestValidationError(
      "Transcription chunk report digest is invalid"
    );
  }
  return {
    plan,
    planSha256,
    reportSha256,
    processorVersion: TRANSCRIPTION_CHUNK_PROCESSOR_VERSION,
    totalOutputBytes,
    chunks
  };
}

async function completeChunkFailure(
  request: Request,
  env: PodcastEnv,
  context: ChunkProcessorContext,
  body: Record<string, unknown>
): Promise<Response> {
  const failureCode = String(body.failureCode ?? "");
  if (!FAILURE_CODES.has(failureCode)) {
    throw new RequestValidationError("failureCode is invalid");
  }
  if (
    context.run.status === "failed"
    && context.run.failure_code === failureCode
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      run: presentTranscriptionChunkRun(context.run),
      idempotent: true
    });
  }
  if (!["queued", "running"].includes(context.run.status)) {
    return chunkConflict(request, env, "transcription_chunk_completion_conflict");
  }
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE transcription_chunk_runs
       SET
         status = 'failed',
         failure_code = ?,
         last_error = 'The signed chunk processor reported a bounded failure.',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')`
    ).bind(failureCode, context.run.id),
    env.DB.prepare(
      `UPDATE transcription_jobs
       SET
         status = 'failed',
         failure_code = 'storage_failed',
         last_error = 'Large-source chunk preparation failed.',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')`
    ).bind(context.id),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, action, target_type, target_id, metadata_json
       )
       SELECT ?, 'transcription.chunks_failed',
              'transcription_chunk_run', id, ?
       FROM transcription_chunk_runs
       WHERE id = ? AND status = 'failed' AND changes() = 1`
    ).bind(
      auditId,
      JSON.stringify({
        jobId: context.id,
        episodeId: context.episode_id,
        failureCode,
        processorManifestSha256: context.run.processor_manifest_sha256
      }),
      context.run.id
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    return chunkConflict(request, env, "transcription_chunk_completion_conflict");
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    run: presentTranscriptionChunkRun(
      await loadTranscriptionChunkRun(env.DB, context.id)
    ),
    idempotent: false
  });
}

function validUploadedChunk(
  object: R2Object,
  payload: {
    manifestSha256: string;
    objectBytes: number;
    sha256: string;
  },
  manifestSha256: string,
  chunkIndex: number
): boolean {
  return (
    object.size === payload.objectBytes
    && object.httpMetadata?.contentType === "audio/mpeg"
    && object.checksums.toJSON().sha256 === payload.sha256
    && object.customMetadata?.sha256 === payload.sha256
    && object.customMetadata?.["transcription-chunk-manifest-sha256"]
      === manifestSha256
    && object.customMetadata?.["transcription-chunk-index"]
      === String(chunkIndex)
  );
}

function parseUploadPayload(encoded: string): {
  runId: string;
  chunkIndex: number;
  manifestSha256: string;
  objectBytes: number;
  sha256: string;
} {
  let value: unknown;
  try {
    const normalized = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    value = JSON.parse(atob(normalized));
  } catch {
    throw new RequestValidationError(
      "The transcription chunk upload payload is invalid"
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(
      "The transcription chunk upload payload is invalid"
    );
  }
  const body = value as Record<string, unknown>;
  return {
    runId: validIdentifier(body.runId, "runId"),
    chunkIndex: boundedInteger(body.chunkIndex, 0, 255, "chunkIndex"),
    manifestSha256: digest(body.manifestSha256, "manifestSha256"),
    objectBytes: boundedInteger(
      body.objectBytes,
      1,
      MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
      "objectBytes"
    ),
    sha256: digest(body.sha256, "sha256")
  };
}

function chunkRunId(job: ChunkableTranscriptionJob): string {
  return `transcription_chunks_${job.input_fingerprint.slice(0, 32)}`;
}

function transcriptionArtifactPrefix(
  job: Pick<ChunkableTranscriptionJob, "show_id" | "episode_id" | "id">
): string {
  return `podcasts/${job.show_id}/${job.episode_id}/transcription/${job.id}`;
}

function transcriptionChunkKeyPrefix(
  job: Pick<ChunkableTranscriptionJob, "show_id" | "episode_id" | "id">
): string {
  return `${transcriptionArtifactPrefix(job)}/chunk-audio`;
}

function chunkObjectKey(
  job: Pick<ChunkableTranscriptionJob, "show_id" | "episode_id" | "id">,
  chunkIndex: number
): string {
  return `${transcriptionChunkKeyPrefix(job)}/`
    + `${String(chunkIndex).padStart(3, "0")}.mp3`;
}

function r2EtagMatches(object: R2Object, expected: string): boolean {
  return object.etag === expected || object.httpEtag === expected;
}

function digest(value: unknown, field: string): string {
  const text = String(value ?? "");
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > maximum
  ) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return number;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function chunkConflict(
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
