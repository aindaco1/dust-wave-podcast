import {
  normalizeSegmentTranscription,
  type NormalizedSegmentTranscription,
  type TimedTextLanguage
} from "@dustwave/timed-text/transcription";
import {
  mergeChunkTranscriptions
} from "@dustwave/timed-text/chunking";
import {
  sha256BytesHex,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import type { AdminRole } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  canonicalTranscriptContent,
  normalizeTranscriptCues,
  serializeTranscriptContent,
  stableTranscriptId
} from "./transcripts";
import {
  ensureTranscriptionChunkRun,
  listPreparedTranscriptionChunks,
  loadTranscriptionChunkRun,
  MAXIMUM_TRANSCRIPTION_CHUNK_BYTES,
  presentTranscriptionChunkRun,
  type PreparedTranscriptionChunkRow,
  type TranscriptionChunkRunRow
} from "./transcription-chunking";
import type { PodcastJob } from "./types";
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
const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
const RETRYABLE_FAILURES = new Set(["provider_failed", "storage_failed"]);
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 5 * 1024 * 1024;

// Base64 temporarily requires roughly 2.4x the source size in Worker memory.
// Long masters must use the follow-on silence-aware chunk processor.
export const MAXIMUM_DIRECT_TRANSCRIPTION_BYTES =
  MAXIMUM_TRANSCRIPTION_CHUNK_BYTES;

type TranscriptionSourceRow = {
  source_language: string | null;
  current_master_id: string | null;
  working_master_id: string;
  source_sha256: string;
  object_key: string;
  object_bytes: number;
  object_etag: string;
  mime_type: string;
  duration_ms: number;
  settings_revision: number;
  model: string;
  settings_version: string;
  vocabulary_json: string;
  transcript_revision: number | null;
};

type TranscriptionJobRow = {
  id: string;
  request_id: string;
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
  adapter: string;
  model: string;
  settings_revision: number;
  settings_version: string;
  settings_json: string;
  input_fingerprint: string;
  base_transcript_revision: number;
  status: string;
  attempt_count: number;
  raw_response_object_key: string;
  normalized_object_key: string;
  webvtt_object_key: string;
  srt_object_key: string;
  plain_text_object_key: string;
  raw_response_sha256: string | null;
  normalized_sha256: string | null;
  transcript_id: string | null;
  transcript_revision: number | null;
  transcript_sha256: string | null;
  provider_request_id: string | null;
  failure_code: string | null;
  last_error: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  current_master_id: string | null;
};

export async function listAdminEpisodeTranscriptionJobs(
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
  const [source, jobs] = await Promise.all([
    loadTranscriptionSource(env.DB, access.episode.id),
    env.DB.prepare(
      `${transcriptionJobSelect()}
       WHERE job.episode_id = ?
       ORDER BY job.requested_at DESC, job.id DESC
       LIMIT 20`
    ).bind(access.episode.id).all<TranscriptionJobRow>()
  ]);
  const chunkRuns = await Promise.all(
    jobs.results.map((job) => loadTranscriptionChunkRun(env.DB, job.id))
  );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: access.episode.id,
    source: source?.current_master_id
      ? {
          sourceLanguage: source.source_language,
          currentWorkingMasterId: source.current_master_id,
          workingMasterSha256: source.source_sha256,
          objectBytes: source.object_bytes,
          mimeType: source.mime_type,
          durationMs: source.duration_ms,
          directProcessingEligible:
            source.object_bytes <= MAXIMUM_DIRECT_TRANSCRIPTION_BYTES,
          model: source.model,
          settingsRevision: source.settings_revision,
          settingsVersion: source.settings_version
        }
      : null,
    jobs: jobs.results.map(
      (job, index) => presentTranscriptionJob(job, chunkRuns[index])
    ),
    safeguards: {
      sourceLanguageOnly: true,
      directSourceByteLimit: MAXIMUM_DIRECT_TRANSCRIPTION_BYTES,
      largeSourceProcessor: "silence_aware_staging_workflow",
      wordTimingCreated: false,
      alignmentRequiredForWordControls: true
    }
  });
}

export async function queueAdminEpisodeTranscription(
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
  const body = await readJsonObject(request, 20_000);
  const requestId = validIdentifier(body.requestId, "requestId");
  const expectedWorkingMasterId = validIdentifier(
    body.expectedWorkingMasterId,
    "expectedWorkingMasterId"
  );
  const language = transcriptionLanguage(body.language);
  const source = await loadTranscriptionSource(env.DB, access.episode.id);
  if (!source?.current_master_id) {
    return transcriptionConflict(
      request,
      env,
      "transcription_working_master_required"
    );
  }
  if (
    source.current_master_id !== expectedWorkingMasterId
    || source.working_master_id !== expectedWorkingMasterId
  ) {
    return transcriptionConflict(
      request,
      env,
      "transcription_working_master_changed",
      { currentWorkingMasterId: source.current_master_id }
    );
  }
  if (source.source_language !== language) {
    return transcriptionConflict(
      request,
      env,
      "transcription_source_language_mismatch",
      { sourceLanguage: source.source_language }
    );
  }
  if (source.model !== TRANSCRIPTION_MODEL) {
    throw new RequestValidationError(
      "The show transcription model is not supported",
      "transcription_settings_invalid"
    );
  }

  const vocabulary = normalizedVocabulary(source.vocabulary_json);
  const settings = {
    schemaVersion: 1,
    task: "transcribe",
    vadFilter: true,
    conditionOnPreviousText: true,
    vocabulary
  };
  const settingsJson = JSON.stringify(settings);
  const inputFingerprint = await sha256Hex(JSON.stringify({
    schemaVersion: 1,
    workingMasterSha256: source.source_sha256,
    language,
    adapter: "workers_ai",
    model: source.model,
    settingsVersion: source.settings_version,
    settings
  }));
  const existing = await findTranscriptionJob(
    env.DB,
    requestId,
    inputFingerprint
  );
  if (existing) {
    if (
      existing.request_id === requestId
      && existing.input_fingerprint !== inputFingerprint
    ) {
      return transcriptionConflict(
        request,
        env,
        "transcription_request_id_conflict"
      );
    }
    const chunkRun = existing.source_object_bytes
        > MAXIMUM_DIRECT_TRANSCRIPTION_BYTES
      ? await ensureTranscriptionChunkRun(env, existing)
      : null;
    if (!chunkRun || chunkRun.status === "ready") {
      await enqueueRetryableTranscription(env, existing);
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentTranscriptionJob(existing, chunkRun),
      idempotent: true
    });
  }

  const jobId = `transcription_${inputFingerprint.slice(0, 32)}`;
  const artifactPrefix =
    `podcasts/${access.episode.showId}/${access.episode.id}/`
    + `transcription/${jobId}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcription_jobs (
         id, request_id, episode_id, working_master_id,
         working_master_sha256, source_object_key, source_object_bytes,
         source_object_etag, source_mime_type, source_duration_ms, language,
         adapter, model, settings_revision, settings_version, settings_json,
         input_fingerprint, base_transcript_revision,
         raw_response_object_key, normalized_object_key, webvtt_object_key,
         srt_object_key, plain_text_object_key, requested_by_admin_user_id
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         'workers_ai', ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?
       )`
    ).bind(
      jobId,
      requestId,
      access.episode.id,
      source.working_master_id,
      source.source_sha256,
      source.object_key,
      source.object_bytes,
      source.object_etag,
      source.mime_type,
      source.duration_ms,
      language,
      source.model,
      source.settings_revision,
      source.settings_version,
      settingsJson,
      inputFingerprint,
      source.transcript_revision ?? 0,
      `${artifactPrefix}/provider-response.json`,
      `${artifactPrefix}/timed-text.json`,
      `${artifactPrefix}/captions.vtt`,
      `${artifactPrefix}/captions.srt`,
      `${artifactPrefix}/transcript.txt`,
      access.authorization.identity.id
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'transcription.queued', 'transcription_job', id, ?
       FROM transcription_jobs
       WHERE id = ? AND request_id = ?`
    ).bind(
      auditId,
      access.authorization.identity.id,
      JSON.stringify({
        episodeId: access.episode.id,
        workingMasterId: source.working_master_id,
        workingMasterSha256: source.source_sha256,
        language,
        adapter: "workers_ai",
        model: source.model,
        settingsVersion: source.settings_version,
        inputFingerprint
      }),
      jobId,
      requestId
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const raced = await findTranscriptionJob(
      env.DB,
      requestId,
      inputFingerprint
    );
    if (!raced) {
      return transcriptionConflict(
        request,
        env,
        "transcription_queue_conflict"
      );
    }
    const chunkRun = raced.source_object_bytes
        > MAXIMUM_DIRECT_TRANSCRIPTION_BYTES
      ? await ensureTranscriptionChunkRun(env, raced)
      : null;
    if (!chunkRun || chunkRun.status === "ready") {
      await enqueueRetryableTranscription(env, raced);
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      job: presentTranscriptionJob(raced, chunkRun),
      idempotent: true
    });
  }

  const created = await loadTranscriptionJob(env.DB, jobId);
  if (!created) {
    throw new Error("Created transcription job could not be loaded");
  }
  let chunkRun: TranscriptionChunkRunRow | null = null;
  let delivery:
    | "queued"
    | "scheduled_recovery"
    | "chunk_processor_required" = "queued";
  if (created.source_object_bytes > MAXIMUM_DIRECT_TRANSCRIPTION_BYTES) {
    chunkRun = await ensureTranscriptionChunkRun(env, created);
    delivery = "chunk_processor_required";
  } else {
    try {
      await sendTranscriptionJob(env, created);
    } catch {
      delivery = "scheduled_recovery";
    }
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      job: presentTranscriptionJob(created, chunkRun),
      idempotent: false,
      delivery
    },
    { status: 202 }
  );
}

export async function processTranscriptionJob(
  env: PodcastEnv,
  message: PodcastJob
): Promise<void> {
  const job = await loadTranscriptionJob(env.DB, message.id);
  if (!job || job.status === "succeeded" || job.status === "stale") return;
  if (
    job.status === "failed"
    && !RETRYABLE_FAILURES.has(job.failure_code ?? "")
  ) {
    return;
  }
  if (job.current_master_id !== job.working_master_id) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "stale",
      "working_master_changed",
      "The approved working master changed."
    );
    return;
  }
  if (job.source_object_bytes > MAXIMUM_DIRECT_TRANSCRIPTION_BYTES) {
    const run = await ensureTranscriptionChunkRun(env, job);
    if (run.status !== "ready") return;
    await processPreparedChunkTranscription(env, job, run);
    return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE transcription_jobs
     SET
       status = 'running',
       attempt_count = attempt_count + 1,
       failure_code = NULL,
       last_error = NULL,
       started_at = datetime('now'),
       completed_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?
       AND attempt_count < 5
       AND (
         status = 'queued'
         OR (
           status = 'failed'
           AND failure_code IN ('provider_failed', 'storage_failed')
         )
       )`
  ).bind(job.id).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return;

  try {
    const source = await env.MEDIA_BUCKET.get(job.source_object_key);
    if (!source) {
      await markTranscriptionTerminal(
        env.DB,
        job.id,
        "failed",
        "source_missing",
        "The working-master object is missing."
      );
      return;
    }
    if (
      source.size !== job.source_object_bytes
      || source.etag !== job.source_object_etag
    ) {
      await markTranscriptionTerminal(
        env.DB,
        job.id,
        "failed",
        "source_changed",
        "The working-master object no longer matches its approval snapshot."
      );
      return;
    }
    const sourceBytes = await source.bytes();
    if (await sha256BytesHex(sourceBytes) !== job.working_master_sha256) {
      await markTranscriptionTerminal(
        env.DB,
        job.id,
        "failed",
        "source_changed",
        "The working-master bytes no longer match their approved SHA-256."
      );
      return;
    }
    const settings = parseSettings(job.settings_json);
    const storedProvider = await readStoredProviderResponse(
      env.MEDIA_BUCKET,
      job
    );
    const providerResponse = storedProvider?.response ?? await env.AI.run(
        TRANSCRIPTION_MODEL,
        {
          audio: bytesToBase64(sourceBytes),
          task: "transcribe",
          language: job.language,
          vad_filter: settings.vadFilter,
          condition_on_previous_text: settings.conditionOnPreviousText,
          ...(settings.vocabulary.length
            ? { initial_prompt: settings.vocabulary.join(", ") }
            : {})
        },
        {
          tags: ["dust-wave-podcast", "transcription", job.language]
        }
      );
    await completeTranscriptionJob(
      env,
      job,
      providerResponse,
      storedProvider
        ? storedProvider.providerRequestId
        : parseProviderRequestId(env.AI.aiGatewayLogId)
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown transcription processing error";
    const responseInvalid =
      error instanceof RequestValidationError
      ||
      message.includes("response")
      || message.includes("segment")
      || message.includes("timing");
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "failed",
      responseInvalid
        ? "provider_response_invalid"
        : message.includes("artifact")
          ? "storage_failed"
          : "provider_failed",
      message
    );
    if (!responseInvalid) {
      throw error;
    }
  }
}

async function processPreparedChunkTranscription(
  env: PodcastEnv,
  job: TranscriptionJobRow,
  run: TranscriptionChunkRunRow
): Promise<void> {
  const chunks = await listPreparedTranscriptionChunks(env.DB, job.id);
  if (
    !run.plan_json
    || !run.plan_sha256
    || !run.chunk_count
    || chunks.length !== run.chunk_count
  ) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "failed",
      "storage_failed",
      "The prepared transcription chunk inventory is incomplete."
    );
    return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE transcription_jobs
     SET
       status = 'running',
       attempt_count = CASE
         WHEN attempt_count = 0 THEN 1
         ELSE attempt_count
       END,
       failure_code = NULL,
       last_error = NULL,
       started_at = datetime('now'),
       completed_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?
       AND attempt_count < 5
       AND (
         status = 'queued'
         OR (
           status = 'failed'
           AND failure_code IN ('provider_failed', 'storage_failed')
         )
       )`
  ).bind(job.id).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return;

  const next = chunks.find((chunk) =>
    chunk.provider_status !== "succeeded"
    && chunk.provider_attempt_count < 5
  );
  if (next) {
    await processOneTranscriptionChunk(env, job, next);
    return;
  }
  if (chunks.some((chunk) => chunk.provider_status !== "succeeded")) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "failed",
      "provider_failed",
      "A transcription chunk exhausted its provider attempt limit."
    );
    return;
  }

  try {
    const plan = JSON.parse(run.plan_json) as {
      silenceWindows: Array<{ startsAtMs: number; endsAtMs: number }>;
      chunks: Array<{
        index: number;
        coreStartsAtMs: number;
        coreEndsAtMs: number;
        mediaStartsAtMs: number;
        mediaEndsAtMs: number;
        boundaryKind: "silence" | "duration" | "end";
      }>;
    };
    if (!Array.isArray(plan.chunks) || plan.chunks.length !== chunks.length) {
      throw new TypeError("Transcription chunk plan is invalid");
    }
    const stored: Array<{
      response: unknown;
      providerRequestId: string | null;
    }> = [];
    for (const chunk of chunks) {
      const response = await readStoredChunkProviderResponse(
        env.MEDIA_BUCKET,
        job,
        chunk
      );
      if (!response) {
        throw new Error("Immutable transcription chunk response is missing");
      }
      stored.push(response);
    }
    const merged = mergeChunkTranscriptions(
      chunks.map((chunk, index) => ({
        plan: {
          silenceWindows: plan.silenceWindows,
          chunk: plan.chunks[index]
        },
        mediaDurationMs: chunk.encoded_duration_ms,
        response: stored[index].response
      })),
      {
        language: job.language as TimedTextLanguage,
        sourceDurationMs: job.source_duration_ms
      }
    );
    const rawIndex = {
      schemaVersion: "workers-ai-chunked-response-index-v1",
      chunkRunId: run.id,
      planSha256: run.plan_sha256,
      mergeEvidence: merged.evidence,
      chunks: chunks.map((chunk, index) => ({
        index: chunk.chunk_index,
        rawResponseObjectKey: chunk.provider_raw_object_key,
        rawResponseSha256: chunk.provider_raw_sha256,
        providerRequestId: stored[index].providerRequestId
      }))
    };
    const rawJson = JSON.stringify(rawIndex);
    const rawIndexSha256 = await sha256Hex(rawJson);
    await completeTranscriptionJob(
      env,
      job,
      null,
      `chunked:${rawIndexSha256.slice(0, 48)}`,
      {
        rawJson,
        normalized: merged.transcription,
        auditEvidence: {
          chunked: true,
          chunkRunId: run.id,
          chunkPlanSha256: run.plan_sha256,
          chunkReportSha256: run.report_sha256,
          chunkCount: chunks.length,
          deduplicatedTokenCount:
            merged.evidence.deduplicatedTokenCount,
          droppedOverlapCueCount: merged.evidence.droppedCueCount
        }
      }
    );
  } catch (error) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "failed",
      "storage_failed",
      error instanceof Error
        ? error.message
        : "Chunked transcription completion failed."
    );
    throw error;
  }
}

async function processOneTranscriptionChunk(
  env: PodcastEnv,
  job: TranscriptionJobRow,
  candidate: PreparedTranscriptionChunkRow
): Promise<void> {
  const claim = await env.DB.prepare(
    `UPDATE transcription_chunks
     SET
       provider_status = 'running',
       provider_attempt_count = provider_attempt_count + 1,
       last_error = NULL,
       updated_at = datetime('now')
     WHERE run_id = ?
       AND chunk_index = ?
       AND provider_attempt_count < 5
       AND provider_status IN ('pending', 'failed')`
  ).bind(candidate.run_id, candidate.chunk_index).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) {
    await env.DB.prepare(
      `UPDATE transcription_jobs
       SET status = 'queued', updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
    ).bind(job.id).run();
    return;
  }
  const chunk = (await listPreparedTranscriptionChunks(env.DB, job.id))
    .find((entry) => entry.chunk_index === candidate.chunk_index);
  if (!chunk) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "failed",
      "storage_failed",
      "The claimed transcription chunk is missing."
    );
    return;
  }
  try {
    const object = await env.MEDIA_BUCKET.get(chunk.object_key);
    if (
      !object
      || object.size !== chunk.object_bytes
      || !r2EtagMatches(object, chunk.object_etag)
      || object.httpMetadata?.contentType !== chunk.mime_type
    ) {
      throw new Error("Prepared transcription chunk object changed");
    }
    const bytes = await object.bytes();
    if (await sha256BytesHex(bytes) !== chunk.sha256) {
      throw new Error("Prepared transcription chunk digest changed");
    }
    const localDurationMs = chunk.encoded_duration_ms;
    const stored = await readStoredChunkProviderResponse(
      env.MEDIA_BUCKET,
      job,
      chunk
    );
    const settings = parseSettings(job.settings_json);
    const providerResponse = stored?.response ?? await env.AI.run(
      TRANSCRIPTION_MODEL,
      {
        audio: bytesToBase64(bytes),
        task: "transcribe",
        language: job.language,
        vad_filter: settings.vadFilter,
        condition_on_previous_text: settings.conditionOnPreviousText,
        ...(settings.vocabulary.length
          ? { initial_prompt: settings.vocabulary.join(", ") }
          : {})
      },
      {
        tags: [
          "dust-wave-podcast",
          "transcription-chunk",
          job.language
        ]
      }
    );
    normalizeSegmentTranscription(providerResponse, {
      language: job.language as TimedTextLanguage,
      durationMs: localDurationMs
    });
    const rawJson = JSON.stringify(providerResponse);
    if (
      new TextEncoder().encode(rawJson).byteLength
      > MAXIMUM_PROVIDER_RESPONSE_BYTES
    ) {
      throw new TypeError("Transcription provider response is too large");
    }
    const rawSha256 = await sha256Hex(rawJson);
    const providerRequestId = stored?.providerRequestId
      ?? parseProviderRequestId(env.AI.aiGatewayLogId);
    await putImmutableArtifact(
      env.MEDIA_BUCKET,
      chunk.provider_raw_object_key,
      rawJson,
      "application/json; charset=utf-8",
      rawSha256,
      {
        jobId: job.id,
        sourceSha256: job.working_master_sha256,
        ...(providerRequestId ? { providerRequestId } : {})
      }
    );
    const completed = await env.DB.prepare(
      `UPDATE transcription_chunks
       SET
         provider_status = 'succeeded',
         provider_raw_sha256 = ?,
         provider_request_id = ?,
         last_error = NULL,
         updated_at = datetime('now')
       WHERE run_id = ?
         AND chunk_index = ?
         AND provider_status = 'running'`
    ).bind(
      rawSha256,
      providerRequestId,
      chunk.run_id,
      chunk.chunk_index
    ).run();
    if (Number(completed.meta?.changes ?? 0) !== 1) {
      throw new Error("Transcription chunk completion conflicted");
    }
    await env.DB.prepare(
      `UPDATE transcription_jobs
       SET
         status = 'queued',
         failure_code = NULL,
         last_error = NULL,
         completed_at = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
    ).bind(job.id).run();
    await sendTranscriptionJob(env, job).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown transcription chunk error";
    const responseInvalid =
      error instanceof RequestValidationError
      || error instanceof TypeError
      || message.includes("response")
      || message.includes("segment")
      || message.includes("timing");
    const storageFailure =
      message.includes("chunk object")
      || message.includes("chunk digest")
      || message.includes("artifact")
      || message.includes("completion conflicted")
      || message.includes("storage");
    const current = (await listPreparedTranscriptionChunks(env.DB, job.id))
      .find((entry) => entry.chunk_index === chunk.chunk_index);
    const exhausted = (current?.provider_attempt_count ?? 5) >= 5;
    await env.DB.prepare(
      `UPDATE transcription_chunks
       SET
         provider_status = 'failed',
         last_error = ?,
         updated_at = datetime('now')
       WHERE run_id = ?
         AND chunk_index = ?
         AND provider_status = 'running'`
    ).bind(
      message.slice(0, 500),
      chunk.run_id,
      chunk.chunk_index
    ).run();
    if (responseInvalid || exhausted) {
      await markTranscriptionTerminal(
        env.DB,
        job.id,
        "failed",
        responseInvalid
          ? "provider_response_invalid"
          : storageFailure
            ? "storage_failed"
            : "provider_failed",
        message
      );
      return;
    }
    await env.DB.prepare(
      `UPDATE transcription_jobs
       SET
         status = 'queued',
         failure_code = NULL,
         last_error = NULL,
         completed_at = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
    ).bind(job.id).run();
    throw error;
  }
}

export async function schedulePendingTranscriptions(
  env: PodcastEnv
): Promise<void> {
  await env.DB.prepare(
    `UPDATE transcription_jobs
     SET
       status = 'failed',
       failure_code = 'provider_failed',
       last_error = 'The prior attempt did not finish; queued for recovery.',
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE status = 'running'
       AND started_at <= datetime('now', '-15 minutes')`
  ).run();
  const due = await env.DB.prepare(
    `${transcriptionJobSelect()}
     WHERE (
       job.status = 'queued'
       OR (
         job.status = 'failed'
         AND job.failure_code IN ('provider_failed', 'storage_failed')
       )
     )
       AND job.attempt_count < 5
       AND (
         job.source_object_bytes <= ${MAXIMUM_DIRECT_TRANSCRIPTION_BYTES}
         OR EXISTS (
           SELECT 1
           FROM transcription_chunk_runs chunk_run
           WHERE chunk_run.transcription_job_id = job.id
             AND chunk_run.status = 'ready'
         )
       )
     ORDER BY job.requested_at
     LIMIT 50`
  ).all<TranscriptionJobRow>();
  for (const job of due.results) {
    await sendTranscriptionJob(env, job);
  }
}

async function completeTranscriptionJob(
  env: PodcastEnv,
  job: TranscriptionJobRow,
  providerResponse: unknown,
  providerRequestId: string | null,
  completion?: {
    rawJson: string;
    normalized: NormalizedSegmentTranscription;
    auditEvidence: Record<string, unknown>;
  }
): Promise<void> {
  const rawJson = completion?.rawJson ?? JSON.stringify(providerResponse);
  if (
    new TextEncoder().encode(rawJson).byteLength
    > MAXIMUM_PROVIDER_RESPONSE_BYTES
  ) {
    throw new TypeError("Transcription provider response is too large");
  }
  const normalized = completion?.normalized
    ?? normalizeSegmentTranscription(providerResponse, {
      language: job.language as TimedTextLanguage,
      durationMs: job.source_duration_ms
    });
  const transcriptCues = normalizeTranscriptCues(
    normalized.cues,
    job.source_duration_ms
  );
  const transcriptContent = canonicalTranscriptContent(
    job.language,
    transcriptCues
  );
  const transcriptJson = serializeTranscriptContent(transcriptContent);
  const transcriptSha256 = await sha256Hex(transcriptJson);
  const rawSha256 = await sha256Hex(rawJson);
  const normalizedJson = JSON.stringify(normalized);
  const normalizedSha256 = await sha256Hex(normalizedJson);
  const metadata = {
    jobId: job.id,
    sourceSha256: job.working_master_sha256,
    ...(providerRequestId ? { providerRequestId } : {})
  };
  await putImmutableArtifact(
    env.MEDIA_BUCKET,
    job.raw_response_object_key,
    rawJson,
    "application/json; charset=utf-8",
    rawSha256,
    metadata
  );
  await putImmutableArtifact(
    env.MEDIA_BUCKET,
    job.normalized_object_key,
    normalizedJson,
    "application/json; charset=utf-8",
    normalizedSha256,
    metadata
  );
  await putImmutableArtifact(
    env.MEDIA_BUCKET,
    job.webvtt_object_key,
    normalized.webVtt,
    "text/vtt; charset=utf-8",
    await sha256Hex(normalized.webVtt),
    metadata
  );
  await putImmutableArtifact(
    env.MEDIA_BUCKET,
    job.srt_object_key,
    normalized.srt,
    "application/x-subrip; charset=utf-8",
    await sha256Hex(normalized.srt),
    metadata
  );
  await putImmutableArtifact(
    env.MEDIA_BUCKET,
    job.plain_text_object_key,
    normalized.plainText,
    "text/plain; charset=utf-8",
    await sha256Hex(normalized.plainText),
    metadata
  );

  const transcriptId = await stableTranscriptId(job.episode_id, job.language);
  const targetRevision = job.base_transcript_revision + 1;
  const mutationId = `transcription_mutation_${job.id}`;
  const revisionId = `transcript_revision_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcripts (
         id, episode_id, language, source, status, content_json, edited_html,
         revision, speaker_labels_confirmed
       )
       SELECT ?, ?, ?, 'workers_ai', 'processing', '{}', '', 0, 0
       FROM transcription_jobs job
       JOIN episode_working_master_states state
         ON state.episode_id = job.episode_id
        AND state.current_master_id = job.working_master_id
       WHERE job.id = ?
         AND job.status = 'running'
         AND job.base_transcript_revision = 0`
    ).bind(
      transcriptId,
      job.episode_id,
      job.language,
      job.id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_mutations (
         id, transcript_id, base_revision, target_revision, content_sha256,
         admin_user_id
       )
       SELECT ?, transcript.id, ?, ?, ?, job.requested_by_admin_user_id
       FROM transcription_jobs job
       JOIN episode_working_master_states state
         ON state.episode_id = job.episode_id
        AND state.current_master_id = job.working_master_id
       JOIN transcripts transcript
         ON transcript.id = ?
        AND transcript.revision = job.base_transcript_revision
       WHERE job.id = ? AND job.status = 'running'`
    ).bind(
      mutationId,
      job.base_transcript_revision,
      targetRevision,
      transcriptSha256,
      transcriptId,
      job.id
    ),
    env.DB.prepare(
      `UPDATE transcripts
       SET
         source = 'workers_ai',
         status = 'needs_review',
         content_json = ?,
         edited_html = '',
         content_sha256 = ?,
         revision = ?,
         speaker_labels_confirmed = 0,
         alignment_score = NULL,
         aligned_word_ratio = NULL,
         approved_revision = NULL,
         approved_at = NULL,
         approved_by_admin_user_id = NULL,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1
           FROM transcript_mutations mutation
           WHERE mutation.id = ?
             AND mutation.transcript_id = transcripts.id
             AND mutation.target_revision = ?
             AND mutation.content_sha256 = ?
         )`
    ).bind(
      transcriptJson,
      transcriptSha256,
      targetRevision,
      transcriptId,
      job.base_transcript_revision,
      mutationId,
      targetRevision,
      transcriptSha256
    ),
    env.DB.prepare(
      `INSERT INTO transcript_revisions (
         id, transcript_id, revision, content_json, content_sha256,
         speaker_labels_confirmed, created_by_admin_user_id
       )
       SELECT ?, transcript.id, transcript.revision, transcript.content_json,
              transcript.content_sha256, transcript.speaker_labels_confirmed,
              job.requested_by_admin_user_id
       FROM transcription_jobs job
       JOIN transcripts transcript ON transcript.id = ?
       JOIN transcript_mutations mutation
         ON mutation.id = ?
        AND mutation.transcript_id = transcript.id
        AND mutation.target_revision = transcript.revision
       WHERE job.id = ?
         AND transcript.revision = ?
         AND transcript.content_sha256 = ?`
    ).bind(
      revisionId,
      transcriptId,
      mutationId,
      job.id,
      targetRevision,
      transcriptSha256
    ),
    env.DB.prepare(
      `UPDATE transcription_jobs
       SET
         status = 'succeeded',
         raw_response_sha256 = ?,
         normalized_sha256 = ?,
         transcript_id = ?,
         transcript_revision = ?,
         transcript_sha256 = ?,
         provider_request_id = ?,
         failure_code = NULL,
         last_error = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND status = 'running'
         AND EXISTS (
           SELECT 1
           FROM episode_working_master_states state
           WHERE state.episode_id = transcription_jobs.episode_id
             AND state.current_master_id =
               transcription_jobs.working_master_id
         )
         AND EXISTS (
           SELECT 1
           FROM transcripts transcript
           WHERE transcript.id = ?
             AND transcript.revision = ?
             AND transcript.content_sha256 = ?
         )`
    ).bind(
      rawSha256,
      normalizedSha256,
      transcriptId,
      targetRevision,
      transcriptSha256,
      providerRequestId,
      job.id,
      transcriptId,
      targetRevision,
      transcriptSha256
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, requested_by_admin_user_id, 'transcription.completed',
              'transcription_job', id, ?
       FROM transcription_jobs
       WHERE id = ? AND status = 'succeeded'`
    ).bind(
      auditId,
      JSON.stringify({
        episodeId: job.episode_id,
        workingMasterId: job.working_master_id,
        workingMasterSha256: job.working_master_sha256,
        language: job.language,
        model: job.model,
        settingsVersion: job.settings_version,
        transcriptId,
        transcriptRevision: targetRevision,
        transcriptSha256,
        timingPrecision: normalized.timingPrecision,
        cueCount: normalized.cues.length,
        wordTimingCreated: false,
        ...(completion?.auditEvidence ?? {})
      }),
      job.id
    )
  ]);
  if (Number(results[4]?.meta?.changes ?? 0) !== 1) {
    await markTranscriptionTerminal(
      env.DB,
      job.id,
      "stale",
      "transcript_changed",
      "The transcript or working master changed before completion."
    );
  }
}

async function loadTranscriptionSource(
  db: D1Database,
  episodeId: string
): Promise<TranscriptionSourceRow | null> {
  return db.prepare(
    `SELECT
       episode.source_language,
       state.current_master_id,
       master.id AS working_master_id,
       master.source_sha256,
       master.object_key,
       master.object_bytes,
       master.object_etag,
       master.mime_type,
       qc.duration_ms,
       settings.revision AS settings_revision,
       settings.model,
       settings.settings_version,
       settings.vocabulary_json,
       transcript.revision AS transcript_revision
     FROM episodes episode
     JOIN episode_working_master_states state
       ON state.episode_id = episode.id
     LEFT JOIN episode_working_masters master
       ON master.id = state.current_master_id
      AND master.episode_id = episode.id
     LEFT JOIN audio_qc_runs qc
       ON qc.id = master.quality_control_run_id
      AND qc.status = 'succeeded'
      AND qc.blocker_count = 0
     JOIN show_transcription_settings settings
       ON settings.show_id = episode.show_id
     LEFT JOIN transcripts transcript
       ON transcript.episode_id = episode.id
      AND transcript.language = episode.source_language
     WHERE episode.id = ?`
  ).bind(episodeId).first<TranscriptionSourceRow>();
}

async function findTranscriptionJob(
  db: D1Database,
  requestId: string,
  inputFingerprint: string
): Promise<TranscriptionJobRow | null> {
  return db.prepare(
    `${transcriptionJobSelect()}
     WHERE job.request_id = ? OR job.input_fingerprint = ?
     ORDER BY CASE WHEN job.request_id = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(requestId, inputFingerprint, requestId).first<TranscriptionJobRow>();
}

async function loadTranscriptionJob(
  db: D1Database,
  jobId: string
): Promise<TranscriptionJobRow | null> {
  return db.prepare(
    `${transcriptionJobSelect()} WHERE job.id = ?`
  ).bind(jobId).first<TranscriptionJobRow>();
}

function transcriptionJobSelect(): string {
  return `SELECT
      job.id, job.request_id, job.episode_id, episode.show_id,
      job.working_master_id, job.working_master_sha256,
      job.source_object_key, job.source_object_bytes,
      job.source_object_etag, job.source_mime_type,
      job.source_duration_ms, job.language, job.adapter, job.model,
      job.settings_revision, job.settings_version, job.settings_json,
      job.input_fingerprint, job.base_transcript_revision, job.status,
      job.attempt_count, job.raw_response_object_key,
      job.normalized_object_key, job.webvtt_object_key,
      job.srt_object_key, job.plain_text_object_key,
      job.raw_response_sha256, job.normalized_sha256, job.transcript_id,
      job.transcript_revision, job.transcript_sha256,
      job.provider_request_id, job.failure_code, job.last_error,
      job.requested_at, job.started_at, job.completed_at, job.updated_at,
      state.current_master_id
    FROM transcription_jobs job
    JOIN episodes episode ON episode.id = job.episode_id
    LEFT JOIN episode_working_master_states state
      ON state.episode_id = job.episode_id`;
}

function presentTranscriptionJob(
  job: TranscriptionJobRow,
  chunkRun: TranscriptionChunkRunRow | null = null
): Record<string, unknown> {
  return {
    id: job.id,
    requestId: job.request_id,
    episodeId: job.episode_id,
    workingMasterId: job.working_master_id,
    workingMasterSha256: job.working_master_sha256,
    language: job.language,
    adapter: job.adapter,
    model: job.model,
    settingsRevision: job.settings_revision,
    settingsVersion: job.settings_version,
    inputFingerprint: job.input_fingerprint,
    baseTranscriptRevision: job.base_transcript_revision,
    status: job.status,
    attemptCount: job.attempt_count,
    source: {
      objectBytes: job.source_object_bytes,
      mimeType: job.source_mime_type,
      durationMs: job.source_duration_ms,
      directProcessingEligible:
        job.source_object_bytes <= MAXIMUM_DIRECT_TRANSCRIPTION_BYTES
    },
    chunking: presentTranscriptionChunkRun(chunkRun),
    result: {
      rawResponseSha256: job.raw_response_sha256,
      normalizedSha256: job.normalized_sha256,
      transcriptId: job.transcript_id,
      transcriptRevision: job.transcript_revision,
      transcriptSha256: job.transcript_sha256,
      providerRequestId: job.provider_request_id,
      timingPrecision: job.status === "succeeded" ? "segment" : null,
      wordTimingCreated: false
    },
    failure: job.failure_code
      ? { code: job.failure_code, message: job.last_error }
      : null,
    requestedAt: job.requested_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    updatedAt: job.updated_at
  };
}

async function enqueueRetryableTranscription(
  env: PodcastEnv,
  job: TranscriptionJobRow
): Promise<void> {
  if (
    job.status === "queued"
    || (
      job.status === "failed"
      && RETRYABLE_FAILURES.has(job.failure_code ?? "")
      && job.attempt_count < 5
    )
  ) {
    await sendTranscriptionJob(env, job).catch(() => undefined);
  }
}

async function sendTranscriptionJob(
  env: PodcastEnv,
  job: Pick<TranscriptionJobRow, "id" | "show_id" | "episode_id">
): Promise<void> {
  await env.JOBS.send({
    id: job.id,
    type: "transcribe",
    showId: job.show_id,
    episodeId: job.episode_id,
    requestedAt: new Date().toISOString()
  } satisfies PodcastJob);
}

async function markTranscriptionTerminal(
  db: D1Database,
  jobId: string,
  status: "failed" | "stale",
  failureCode: string,
  message: string
): Promise<void> {
  await db.prepare(
    `UPDATE transcription_jobs
     SET
       status = ?,
       failure_code = ?,
       last_error = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'running', 'failed')`
  ).bind(
    status,
    failureCode,
    message.slice(0, 500),
    jobId
  ).run();
}

async function putImmutableArtifact(
  bucket: R2Bucket,
  key: string,
  body: string,
  contentType: string,
  sha256: string,
  metadata: {
    jobId: string;
    sourceSha256: string;
    providerRequestId?: string;
  }
): Promise<void> {
  const expectedBytes = new TextEncoder().encode(body).byteLength;
  const existing = await bucket.head(key);
  if (existing) {
    if (
      existing.size === expectedBytes
      && existing.customMetadata?.sha256 === sha256
      && existing.customMetadata?.jobId === metadata.jobId
      && existing.customMetadata?.sourceSha256 === metadata.sourceSha256
    ) {
      return;
    }
    throw new Error("Immutable transcription artifact conflict");
  }
  const written = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType,
      cacheControl: "private, no-store, max-age=0"
    },
    customMetadata: { sha256, ...metadata }
  });
  if (written) return;
  const raced = await bucket.head(key);
  if (
    !raced
    || raced.size !== expectedBytes
    || raced.customMetadata?.sha256 !== sha256
    || raced.customMetadata?.jobId !== metadata.jobId
    || raced.customMetadata?.sourceSha256 !== metadata.sourceSha256
  ) {
    throw new Error("Immutable transcription artifact conflict");
  }
}

async function readStoredProviderResponse(
  bucket: R2Bucket,
  job: Pick<
    TranscriptionJobRow,
    "id" | "working_master_sha256" | "raw_response_object_key"
  >
): Promise<{
  response: unknown;
  providerRequestId: string | null;
} | null> {
  const object = await bucket.get(job.raw_response_object_key);
  if (!object) return null;
  const body = await object.text();
  const sha256 = await sha256Hex(body);
  if (
    object.size !== new TextEncoder().encode(body).byteLength
    || object.customMetadata?.sha256 !== sha256
    || object.customMetadata?.jobId !== job.id
    || object.customMetadata?.sourceSha256 !== job.working_master_sha256
  ) {
    throw new Error("Immutable transcription artifact conflict");
  }
  try {
    return {
      response: JSON.parse(body) as unknown,
      providerRequestId: parseProviderRequestId(
        object.customMetadata?.providerRequestId ?? null
      )
    };
  } catch {
    throw new Error("Immutable transcription artifact conflict");
  }
}

async function readStoredChunkProviderResponse(
  bucket: R2Bucket,
  job: Pick<TranscriptionJobRow, "id" | "working_master_sha256">,
  chunk: Pick<
    PreparedTranscriptionChunkRow,
    | "provider_raw_object_key"
    | "provider_raw_sha256"
  >
): Promise<{
  response: unknown;
  providerRequestId: string | null;
} | null> {
  const object = await bucket.get(chunk.provider_raw_object_key);
  if (!object) return null;
  const body = await object.text();
  const sha256 = await sha256Hex(body);
  if (
    object.size !== new TextEncoder().encode(body).byteLength
    || object.size > MAXIMUM_PROVIDER_RESPONSE_BYTES
    || object.customMetadata?.sha256 !== sha256
    || object.customMetadata?.jobId !== job.id
    || object.customMetadata?.sourceSha256 !== job.working_master_sha256
    || (
      chunk.provider_raw_sha256 !== null
      && chunk.provider_raw_sha256 !== sha256
    )
  ) {
    throw new Error("Immutable transcription chunk response conflict");
  }
  try {
    return {
      response: JSON.parse(body) as unknown,
      providerRequestId: parseProviderRequestId(
        object.customMetadata?.providerRequestId ?? null
      )
    };
  } catch {
    throw new Error("Immutable transcription chunk response conflict");
  }
}

function parseSettings(value: string): {
  vadFilter: boolean;
  conditionOnPreviousText: boolean;
  vocabulary: string[];
} {
  const parsed = JSON.parse(value) as {
    schemaVersion?: unknown;
    task?: unknown;
    vadFilter?: unknown;
    conditionOnPreviousText?: unknown;
    vocabulary?: unknown;
  };
  if (
    parsed.schemaVersion !== 1
    || parsed.task !== "transcribe"
    || parsed.vadFilter !== true
    || parsed.conditionOnPreviousText !== true
    || !Array.isArray(parsed.vocabulary)
  ) {
    throw new TypeError("Transcription settings snapshot is invalid");
  }
  return {
    vadFilter: true,
    conditionOnPreviousText: true,
    vocabulary: parsed.vocabulary.map(
      (entry) => vocabularyEntry(entry)
    )
  };
}

function normalizedVocabulary(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new RequestValidationError(
      "The show transcription vocabulary is invalid",
      "transcription_settings_invalid"
    );
  }
  return [...new Set(parsed.map((entry) => vocabularyEntry(entry)))];
}

function vocabularyEntry(value: unknown): string {
  const entry = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !entry
    || entry.length > 80
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/.test(entry)
  ) {
    throw new TypeError("Transcription vocabulary entry is invalid");
  }
  return entry;
}

function transcriptionLanguage(value: unknown): TimedTextLanguage {
  const language = String(value ?? "").trim().toLowerCase();
  if (language !== "en" && language !== "es") {
    throw new RequestValidationError("language must be en or es");
  }
  return language;
}

function parseProviderRequestId(
  value: string | null
): string | null {
  const identifier = String(value ?? "").trim();
  return identifier ? identifier.slice(0, 240) : null;
}

function transcriptionConflict(
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function r2EtagMatches(object: R2Object, expected: string): boolean {
  return object.etag === expected || object.httpEtag === expected;
}
