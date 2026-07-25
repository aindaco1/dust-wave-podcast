import {
  sha256Hex
} from "@dustwave/worker-core/crypto";

import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
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
const APPROVE_ROLES: AdminRole[] = ["super_admin", "admin"];
const LANGUAGES = new Set(["en", "es"]);
const MAXIMUM_CUES = 10_000;
const MAXIMUM_CUE_DURATION_MS = 120_000;
const MAXIMUM_CAPTION_LENGTH = 2_000;
const MAXIMUM_TRANSCRIPT_BYTES = 1_000_000;

export type TranscriptCue = {
  id: string;
  startsAtMs: number;
  endsAtMs: number;
  speakerLabel: string;
  speakerConfirmed: boolean;
  textMarkdown: string;
};

type EpisodeAuthorization = {
  authorization: AdminAuthorization;
  episode: {
    id: string;
    showId: string;
    durationSeconds: number | null;
  };
};

type TranscriptRow = {
  id: string;
  language: string;
  source: string;
  status: string;
  content_json: string;
  content_sha256: string | null;
  revision: number;
  speaker_labels_confirmed: number;
  approved_revision: number | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  alignment_id: string | null;
  alignment_status: string | null;
  alignment_adapter: string | null;
  alignment_model: string | null;
  alignment_completed_at: string | null;
  aligned_word_count: number;
};

export async function listAdminEpisodeTranscripts(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const authorized = await authorizeEpisode(
    request,
    env,
    episodeIdValue,
    READ_ROLES
  );
  if (authorized instanceof Response) return authorized;
  const transcripts = await env.DB
    .prepare(transcriptSelect("WHERE t.episode_id = ? ORDER BY t.language"))
    .bind(authorized.episode.id)
    .all<TranscriptRow>();

  return privateJson(request, env.ALLOWED_ORIGINS, {
    episodeId: authorized.episode.id,
    durationSeconds: authorized.episode.durationSeconds,
    transcripts: transcripts.results.map(presentTranscript)
  });
}

export async function saveAdminEpisodeTranscript(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  languageValue: string
): Promise<Response> {
  const authorized = await authorizeEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    true
  );
  if (authorized instanceof Response) return authorized;
  const language = validTranscriptLanguage(languageValue);
  const body = await readJsonObject(request);
  const mutationId = validIdentifier(body.mutationId, "mutationId");
  const baseRevision = nonNegativeInteger(body.baseRevision, "baseRevision");
  const cues = normalizeTranscriptCues(
    body.cues,
    authorized.episode.durationSeconds === null
      ? null
      : authorized.episode.durationSeconds * 1_000
  );
  const content = canonicalTranscriptContent(language, cues);
  const contentJson = serializeTranscriptContent(content);
  const contentSha256 = await sha256Hex(contentJson);
  const labelsConfirmed = cues.every(
    ({ speakerLabel, speakerConfirmed }) =>
      !speakerLabel || speakerConfirmed
  );
  const transcriptId = await stableTranscriptId(
    authorized.episode.id,
    language
  );

  const replay = await env.DB
    .prepare(
      `SELECT transcript_id, base_revision, target_revision, content_sha256
       FROM transcript_mutations
       WHERE id = ?`
    )
    .bind(mutationId)
    .first<{
      transcript_id: string;
      base_revision: number;
      target_revision: number;
      content_sha256: string;
    }>();
  if (replay) {
    if (
      replay.transcript_id !== transcriptId
      || replay.base_revision !== baseRevision
      || replay.content_sha256 !== contentSha256
    ) {
      return conflict(
        request,
        env,
        "transcript_mutation_conflict"
      );
    }
    const transcript = await loadTranscript(env.DB, transcriptId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      transcript: transcript ? presentTranscript(transcript) : null,
      idempotent: true
    });
  }

  const targetRevision = baseRevision + 1;
  const revisionId = `transcript_revision_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcripts (
         id, episode_id, language, source, status, content_json, edited_html,
         revision, speaker_labels_confirmed
       )
       SELECT ?, ?, ?, 'editor', 'needs_review', '{}', '', 0, 0
       WHERE ? = 0`
    ).bind(
      transcriptId,
      authorized.episode.id,
      language,
      baseRevision
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_mutations (
         id, transcript_id, base_revision, target_revision, content_sha256,
         admin_user_id
       )
       SELECT ?, t.id, ?, ?, ?, ?
       FROM transcripts t
       WHERE t.id = ? AND t.revision = ?`
    ).bind(
      mutationId,
      baseRevision,
      targetRevision,
      contentSha256,
      authorized.authorization.identity.id,
      transcriptId,
      baseRevision
    ),
    env.DB.prepare(
      `UPDATE transcripts
       SET
         source = 'editor',
         status = 'needs_review',
         content_json = ?,
         edited_html = '',
         content_sha256 = ?,
         revision = ?,
         speaker_labels_confirmed = ?,
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
      contentJson,
      contentSha256,
      targetRevision,
      labelsConfirmed ? 1 : 0,
      transcriptId,
      baseRevision,
      mutationId,
      targetRevision,
      contentSha256
    ),
    env.DB.prepare(
      `UPDATE transcript_alignment_revisions
       SET status = 'superseded', updated_at = datetime('now')
       WHERE transcript_id = ?
         AND status IN ('processing', 'needs_review', 'passed')
         AND transcript_revision_sha256 != ?
         AND EXISTS (
           SELECT 1
           FROM transcript_mutations
           WHERE id = ? AND transcript_id = ?
         )`
    ).bind(
      transcriptId,
      contentSha256,
      mutationId,
      transcriptId
    ),
    env.DB.prepare(
      `INSERT INTO transcript_revisions (
         id, transcript_id, revision, content_json, content_sha256,
         speaker_labels_confirmed, created_by_admin_user_id
       )
       SELECT ?, t.id, t.revision, t.content_json, t.content_sha256,
              t.speaker_labels_confirmed, ?
       FROM transcripts t
       JOIN transcript_mutations mutation
         ON mutation.id = ? AND mutation.transcript_id = t.id
       WHERE t.id = ?
         AND t.revision = ?
         AND t.content_sha256 = ?`
    ).bind(
      revisionId,
      authorized.authorization.identity.id,
      mutationId,
      transcriptId,
      targetRevision,
      contentSha256
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'transcript.revised', 'transcript', ?, ?
       FROM transcript_mutations
       WHERE id = ? AND transcript_id = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      transcriptId,
      JSON.stringify({
        episodeId: authorized.episode.id,
        language,
        revision: targetRevision,
        cueCount: cues.length,
        contentSha256,
        speakerLabelsConfirmed: labelsConfirmed
      }),
      mutationId,
      transcriptId
    )
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    const current = await currentTranscriptRevision(env.DB, transcriptId);
    return conflict(request, env, "transcript_revision_conflict", {
      currentRevision: current
    });
  }
  const transcript = await loadTranscript(env.DB, transcriptId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    transcript: transcript ? presentTranscript(transcript) : null,
    idempotent: false
  });
}

export async function approveAdminEpisodeTranscript(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  languageValue: string
): Promise<Response> {
  const authorized = await authorizeEpisode(
    request,
    env,
    episodeIdValue,
    APPROVE_ROLES,
    true
  );
  if (authorized instanceof Response) return authorized;
  const language = validTranscriptLanguage(languageValue);
  const body = await readJsonObject(request);
  const approvalId = validIdentifier(body.approvalId, "approvalId");
  const expectedRevision = positiveInteger(
    body.expectedRevision,
    "expectedRevision"
  );
  const transcriptId = await stableTranscriptId(
    authorized.episode.id,
    language
  );
  const transcript = await loadTranscript(env.DB, transcriptId);
  if (!transcript) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcript_not_found" },
      { status: 404 }
    );
  }
  if (
    transcript.status === "approved"
    && transcript.approved_revision === expectedRevision
  ) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      transcript: presentTranscript(transcript),
      idempotent: true
    });
  }
  if (transcript.revision !== expectedRevision) {
    return conflict(request, env, "transcript_revision_conflict", {
      currentRevision: transcript.revision
    });
  }
  if (transcript.speaker_labels_confirmed !== 1) {
    return conflict(
      request,
      env,
      "transcript_speaker_labels_unconfirmed"
    );
  }
  const priorApproval = await env.DB
    .prepare(
      `SELECT transcript_id, revision
       FROM transcript_approvals
       WHERE id = ?`
    )
    .bind(approvalId)
    .first<{ transcript_id: string; revision: number }>();
  if (priorApproval) {
    if (
      priorApproval.transcript_id !== transcriptId
      || priorApproval.revision !== expectedRevision
    ) {
      return conflict(request, env, "transcript_approval_conflict");
    }
    return conflict(request, env, "transcript_revision_conflict", {
      currentRevision: transcript.revision
    });
  }

  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO transcript_approvals (
         id, transcript_id, revision, admin_user_id
       )
       SELECT ?, id, revision, ?
       FROM transcripts
       WHERE id = ?
         AND revision = ?
         AND status = 'needs_review'
         AND speaker_labels_confirmed = 1`
    ).bind(
      approvalId,
      authorized.authorization.identity.id,
      transcriptId,
      expectedRevision
    ),
    env.DB.prepare(
      `UPDATE transcripts
       SET
         status = 'approved',
         approved_revision = revision,
         approved_at = datetime('now'),
         approved_by_admin_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND revision = ?
         AND status = 'needs_review'
         AND EXISTS (
           SELECT 1
           FROM transcript_approvals
           WHERE id = ?
             AND transcript_id = transcripts.id
             AND revision = transcripts.revision
         )`
    ).bind(
      authorized.authorization.identity.id,
      transcriptId,
      expectedRevision,
      approvalId
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'transcript.approved', 'transcript', ?, ?
       FROM transcript_approvals
       WHERE id = ? AND transcript_id = ? AND revision = ?`
    ).bind(
      auditId,
      authorized.authorization.identity.id,
      transcriptId,
      JSON.stringify({
        episodeId: authorized.episode.id,
        language,
        revision: expectedRevision
      }),
      approvalId,
      transcriptId,
      expectedRevision
    )
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return conflict(request, env, "transcript_approval_conflict");
  }
  const approved = await loadTranscript(env.DB, transcriptId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    transcript: approved ? presentTranscript(approved) : null,
    idempotent: false
  });
}

export function normalizeTranscriptCues(
  value: unknown,
  episodeDurationMs: number | null = null
): TranscriptCue[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new RequestValidationError("At least one transcript cue is required");
  }
  if (value.length > MAXIMUM_CUES) {
    throw new RequestValidationError("The transcript has too many cues");
  }
  const identifiers = new Set<string>();
  let previousEnd = 0;
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RequestValidationError(`Cue ${index + 1} must be an object`);
    }
    const cue = candidate as Record<string, unknown>;
    const id = validIdentifier(cue.id, `cues[${index}].id`);
    if (identifiers.has(id)) {
      throw new RequestValidationError(`Cue ${index + 1} has a duplicate id`);
    }
    identifiers.add(id);
    const startsAtMs = transcriptMillisecond(
      cue.startsAtMs,
      `cues[${index}].startsAtMs`,
      true
    );
    const endsAtMs = transcriptMillisecond(
      cue.endsAtMs,
      `cues[${index}].endsAtMs`,
      false
    );
    if (endsAtMs <= startsAtMs) {
      throw new RequestValidationError(
        `Cue ${index + 1} must end after it starts`
      );
    }
    if (endsAtMs - startsAtMs > MAXIMUM_CUE_DURATION_MS) {
      throw new RequestValidationError(
        `Cue ${index + 1} is longer than two minutes`
      );
    }
    if (index > 0 && startsAtMs < previousEnd) {
      throw new RequestValidationError(
        `Cue ${index + 1} overlaps the previous cue`
      );
    }
    if (episodeDurationMs !== null && endsAtMs > episodeDurationMs) {
      throw new RequestValidationError(
        `Cue ${index + 1} exceeds the episode duration`
      );
    }
    previousEnd = endsAtMs;
    const speakerLabel = optionalCaptionText(
      cue.speakerLabel,
      `cues[${index}].speakerLabel`,
      80
    );
    if (
      "speakerConfirmed" in cue
      && typeof cue.speakerConfirmed !== "boolean"
    ) {
      throw new RequestValidationError(
        `cues[${index}].speakerConfirmed must be a boolean`
      );
    }
    const textMarkdown = validateTimedTextMarkdown(
      cue.textMarkdown,
      `cues[${index}].textMarkdown`
    );
    return {
      id,
      startsAtMs,
      endsAtMs,
      speakerLabel,
      speakerConfirmed: Boolean(cue.speakerConfirmed && speakerLabel),
      textMarkdown
    };
  });
}

export function canonicalTranscriptContent(
  language: string,
  cues: TranscriptCue[]
): {
  schemaVersion: 1;
  language: string;
  cues: TranscriptCue[];
} {
  return {
    schemaVersion: 1,
    language: validTranscriptLanguage(language),
    cues: cues.map((cue) => ({
      id: cue.id,
      startsAtMs: cue.startsAtMs,
      endsAtMs: cue.endsAtMs,
      speakerLabel: cue.speakerLabel,
      speakerConfirmed: cue.speakerConfirmed,
      textMarkdown: cue.textMarkdown
    }))
  };
}

export function serializeTranscriptContent(
  content: ReturnType<typeof canonicalTranscriptContent>
): string {
  const contentJson = JSON.stringify(content);
  if (
    new TextEncoder().encode(contentJson).byteLength
    > MAXIMUM_TRANSCRIPT_BYTES
  ) {
    throw new RequestValidationError(
      "The transcript exceeds the one-megabyte review limit"
    );
  }
  return contentJson;
}

function presentTranscript(row: TranscriptRow): Record<string, unknown> {
  const content = parseTranscriptContent(row.content_json, row.language);
  const wordControlsEnabled = row.alignment_status === "passed"
    && row.aligned_word_count > 0;
  return {
    id: row.id,
    language: row.language,
    source: row.source,
    status: row.status,
    revision: row.revision,
    contentSha256: row.content_sha256,
    speakerLabelsConfirmed: row.speaker_labels_confirmed === 1,
    approvedRevision: row.approved_revision,
    approvedAt: row.approved_at,
    cues: content.cues,
    alignment: {
      id: row.alignment_id,
      status: row.alignment_status ?? "not_run",
      adapter: row.alignment_adapter,
      model: row.alignment_model,
      completedAt: row.alignment_completed_at,
      alignedWordCount: row.aligned_word_count,
      wordControlsEnabled
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseTranscriptContent(
  value: string,
  language: string
): ReturnType<typeof canonicalTranscriptContent> {
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: number;
      language?: string;
      cues?: unknown;
    };
    if (
      parsed.schemaVersion === 1
      && parsed.language === language
      && Array.isArray(parsed.cues)
    ) {
      return canonicalTranscriptContent(
        language,
        normalizeTranscriptCues(parsed.cues)
      );
    }
  } catch {
    // Older/provider payloads stay private and fail closed as uneditable cues.
  }
  return {
    schemaVersion: 1,
    language,
    cues: []
  };
}

async function authorizeEpisode(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  roles: AdminRole[],
  requireCsrf = false
): Promise<EpisodeAuthorization | Response> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: roles,
    requireCsrf
  });
  if (!auth.ok) return auth.response;
  const episode = await env.DB
    .prepare(
      `SELECT id, show_id, duration_seconds
       FROM episodes
       WHERE id = ?`
    )
    .bind(episodeId)
    .first<{
      id: string;
      show_id: string;
      duration_seconds: number | null;
    }>();
  if (
    !episode
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      roles,
      episode.show_id
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  return {
    authorization: auth.authorization,
    episode: {
      id: episode.id,
      showId: episode.show_id,
      durationSeconds: episode.duration_seconds
    }
  };
}

async function stableTranscriptId(
  episodeId: string,
  language: string
): Promise<string> {
  const digest = await sha256Hex(`transcript:v1:${episodeId}:${language}`);
  return `transcript_${digest.slice(0, 32)}`;
}

async function loadTranscript(
  db: D1Database,
  transcriptId: string
): Promise<TranscriptRow | null> {
  return db
    .prepare(transcriptSelect("WHERE t.id = ?"))
    .bind(transcriptId)
    .first<TranscriptRow>();
}

function transcriptSelect(where: string): string {
  return `SELECT
      t.id, t.language, t.source, t.status, t.content_json,
      t.content_sha256, t.revision, t.speaker_labels_confirmed,
      t.approved_revision, t.approved_at, t.created_at, t.updated_at,
      ar.id AS alignment_id, ar.status AS alignment_status,
      ar.adapter AS alignment_adapter, ar.model AS alignment_model,
      ar.completed_at AS alignment_completed_at,
      (
        SELECT COUNT(*)
        FROM transcript_words tw
        WHERE tw.transcript_id = t.id
          AND tw.alignment_revision_id = ar.id
          AND tw.timing_status IN ('aligned', 'editor_adjusted')
      ) AS aligned_word_count
    FROM transcripts t
    LEFT JOIN transcript_alignment_revisions ar
      ON ar.id = (
        SELECT candidate.id
        FROM transcript_alignment_revisions candidate
        WHERE candidate.transcript_id = t.id
          AND candidate.transcript_revision_sha256 = t.content_sha256
        ORDER BY
          CASE candidate.status WHEN 'passed' THEN 0 ELSE 1 END,
          candidate.created_at DESC
        LIMIT 1
      )
    ${where}`;
}

async function currentTranscriptRevision(
  db: D1Database,
  transcriptId: string
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT revision FROM transcripts WHERE id = ?`)
    .bind(transcriptId)
    .first<{ revision: number }>();
  return row?.revision ?? null;
}

function validTranscriptLanguage(value: unknown): string {
  const language = requiredText(value, "language", 2).toLowerCase();
  if (!LANGUAGES.has(language)) {
    throw new RequestValidationError("language must be en or es");
  }
  return language;
}

function validateTimedTextMarkdown(value: unknown, field: string): string {
  const text = requiredText(value, field, MAXIMUM_CAPTION_LENGTH)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new RequestValidationError(`${field} contains control characters`);
  }
  const withoutUnderline = text.replace(/<\/?u>/gi, "");
  if (/[<>]/.test(withoutUnderline)) {
    throw new RequestValidationError(
      `${field} supports emphasis and underline only`
    );
  }
  let underlineOpen = false;
  for (const tag of text.match(/<\/?u>/gi) ?? []) {
    const closing = /^<\//.test(tag);
    if ((closing && !underlineOpen) || (!closing && underlineOpen)) {
      throw new RequestValidationError(`${field} has invalid underline markup`);
    }
    underlineOpen = !closing;
  }
  if (underlineOpen) {
    throw new RequestValidationError(`${field} has invalid underline markup`);
  }
  const visible = withoutUnderline.replace(/[*_]/g, "").trim();
  if (!visible) {
    throw new RequestValidationError(`${field} is required`);
  }
  return text;
}

function optionalCaptionText(
  value: unknown,
  field: string,
  maximum: number
): string {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (text.length > maximum) {
    throw new RequestValidationError(`${field} is too long`);
  }
  if (/[\u0000-\u001f\u007f<>]/.test(text)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return text;
}

function transcriptMillisecond(
  value: unknown,
  field: string,
  allowZero: boolean
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < (allowZero ? 0 : 1)
    || number > 86_400_000
  ) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RequestValidationError(`${field} must be a non-negative integer`);
  }
  return number;
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return number;
}

function conflict(
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
