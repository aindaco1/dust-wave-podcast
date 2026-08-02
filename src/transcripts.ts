import {
  sha256Hex
} from "@dustwave/worker-core/crypto";

import type { AdminRole } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  prepareResolveTranscriptReviewAction
} from "./admin-action-notifications";
import type { PodcastEnv } from "./env";
import { privateCorsHeaders, privateJson } from "./http";
import { safeDownloadFilename } from "./media-range";
import {
  hashPrivateFeedToken,
  privateFeedTokenNeedsTouch,
  touchPrivateFeedToken
} from "./private-feeds";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";
import {
  renderSubRip,
  renderWebVtt,
  timedTextMarkdownToPlainText
} from "./timed-text";

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
const FEED_TRANSCRIPT_VERIFY_EPISODE_BATCH_SIZE = 10;
export type TranscriptLanguage = "en" | "es";

export type TranscriptCue = {
  id: string;
  startsAtMs: number;
  endsAtMs: number;
  speakerLabel: string;
  speakerConfirmed: boolean;
  textMarkdown: string;
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

type PublicEpisodeRow = {
  id: string;
  canonical_url: string;
};

type PrivateEpisodeRow = PublicEpisodeRow & {
  last_used_at: string | null;
};

type PublicTranscriptRevisionRow = {
  episode_id: string;
  language: string;
  revision: number;
  content_json: string;
  content_sha256: string;
  approved_at: string;
};

export type VerifiedApprovedTranscript = {
  language: TranscriptLanguage;
  revision: number;
  approvedAt: string;
  contentSha256: string;
  cues: Array<{
    id: string;
    startsAtMs: number;
    endsAtMs: number;
    speakerLabel: string;
    text: string;
  }>;
};

type VerifiedPublicTranscript = VerifiedApprovedTranscript;

type VerifiedPublicTranscriptRow = VerifiedApprovedTranscript & {
  episodeId: string;
};

export type TranscriptRevisionCommitEvidence = {
  transcriptId: string;
  mutationId: string;
  revisionId: string;
  auditId: string;
  baseRevision: number;
  targetRevision: number;
  contentSha256: string;
  speakerLabelsConfirmed: boolean;
};

export type TranscriptApprovalCommitEvidence = {
  transcriptId: string;
  approvalId: string;
  auditId: string;
  revision: number;
  adminUserId: string;
};

export async function verifyTranscriptRevisionCommit(
  db: D1Database,
  evidence: TranscriptRevisionCommitEvidence
): Promise<boolean> {
  const committed = await db.prepare(
    `SELECT transcript.id
     FROM transcripts transcript
     JOIN transcript_mutations mutation
       ON mutation.id = ?
      AND mutation.transcript_id = transcript.id
      AND mutation.base_revision = ?
      AND mutation.target_revision = ?
      AND mutation.content_sha256 = ?
     JOIN transcript_revisions revision
       ON revision.id = ?
      AND revision.transcript_id = transcript.id
      AND revision.revision = transcript.revision
      AND revision.content_sha256 = transcript.content_sha256
      AND revision.speaker_labels_confirmed = transcript.speaker_labels_confirmed
     JOIN admin_audit_events audit
       ON audit.id = ?
      AND audit.action = 'transcript.revised'
      AND audit.target_type = 'transcript'
      AND audit.target_id = transcript.id
     WHERE transcript.id = ?
       AND transcript.revision = ?
       AND transcript.content_sha256 = ?
       AND transcript.speaker_labels_confirmed = ?
       AND transcript.status = 'needs_review'
       AND transcript.approved_revision IS NULL`
  ).bind(
    evidence.mutationId,
    evidence.baseRevision,
    evidence.targetRevision,
    evidence.contentSha256,
    evidence.revisionId,
    evidence.auditId,
    evidence.transcriptId,
    evidence.targetRevision,
    evidence.contentSha256,
    evidence.speakerLabelsConfirmed ? 1 : 0
  ).first<{ id: string }>();
  return committed?.id === evidence.transcriptId;
}

export async function verifyTranscriptApprovalCommit(
  db: D1Database,
  evidence: TranscriptApprovalCommitEvidence
): Promise<boolean> {
  const committed = await db.prepare(
    `SELECT transcript.id
     FROM transcripts transcript
     JOIN transcript_approvals approval
       ON approval.id = ?
      AND approval.transcript_id = transcript.id
      AND approval.revision = transcript.revision
      AND approval.admin_user_id = ?
     JOIN admin_audit_events audit
       ON audit.id = ?
      AND audit.admin_user_id = approval.admin_user_id
      AND audit.action = 'transcript.approved'
      AND audit.target_type = 'transcript'
      AND audit.target_id = transcript.id
     WHERE transcript.id = ?
       AND transcript.revision = ?
       AND transcript.status = 'approved'
       AND transcript.approved_revision = transcript.revision
       AND transcript.speaker_labels_confirmed = 1
       AND transcript.approved_by_admin_user_id = approval.admin_user_id`
  ).bind(
    evidence.approvalId,
    evidence.adminUserId,
    evidence.auditId,
    evidence.transcriptId,
    evidence.revision
  ).first<{ id: string }>();
  return committed?.id === evidence.transcriptId;
}

export async function servePublicEpisodeTranscripts(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  episodeSlug: string
): Promise<Response> {
  const episode = await loadPublicTranscriptEpisode(
    env.DB,
    showSlug,
    episodeSlug
  );
  if (!episode) {
    return publicTranscriptJson(
      request,
      { error: "episode_not_found" },
      { status: 404, cacheControl: "no-store" }
    );
  }

  const transcripts = await loadVerifiedPublicTranscripts(
    env.DB,
    episode.id
  );

  const body = {
    schemaVersion: 1,
    episode: {
      showSlug,
      slug: episodeSlug,
      canonicalUrl: episode.canonical_url
    },
    transcripts
  };
  const bodyJson = JSON.stringify(body);
  const etag = `"${await sha256Hex(bodyJson)}"`;
  const headers = publicTranscriptHeaders(
    "public, max-age=60, stale-while-revalidate=300"
  );
  headers.set("etag", etag);
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : bodyJson, {
    status: 200,
    headers
  });
}

export async function servePublicEpisodeTranscriptVtt(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  episodeSlug: string,
  languageValue: string
): Promise<Response> {
  const language = validTranscriptLanguage(languageValue);
  const episode = await loadPublicTranscriptEpisode(
    env.DB,
    showSlug,
    episodeSlug
  );
  if (!episode) return transcriptVttNotFound(request, "public");
  const transcript = (
    await loadVerifiedPublicTranscripts(env.DB, episode.id)
  ).find((candidate) => candidate.language === language);
  if (!transcript) return transcriptVttNotFound(request, "public");
  return transcriptVttResponse(
    request,
    renderTranscriptWebVtt(transcript),
    transcript.language,
    "public"
  );
}

export async function servePrivateEpisodeTranscriptVtt(
  request: Request,
  env: PodcastEnv,
  rawToken: string,
  rssSlug: string,
  episodeSlug: string,
  languageValue: string
): Promise<Response> {
  if (!env.FEED_TOKEN_PEPPER) {
    return transcriptVttNotFound(request, "private");
  }
  const language = validTranscriptLanguage(languageValue);
  const tokenHash = await hashPrivateFeedToken(
    rawToken,
    env.FEED_TOKEN_PEPPER
  );
  const episode = await env.DB
    .prepare(
      `SELECT e.id, e.canonical_url, f.last_used_at
       FROM private_feed_tokens f
       JOIN subscriptions subscription
         ON subscription.listener_id = f.listener_id
        AND subscription.show_id = f.show_id
       JOIN shows s ON s.id = f.show_id
       JOIN episodes e ON e.show_id = s.id
       WHERE f.token_hash = ?
         AND f.revoked_at IS NULL
         AND s.rss_slug = ?
         AND s.status != 'archived'
         AND subscription.status = 'active'
         AND (
           subscription.current_period_end IS NULL
           OR subscription.current_period_end > ${SQL_UTC_NOW_RFC3339}
         )
         AND e.slug = ?
         AND e.status IN ('scheduled', 'published')
         AND e.media_status = 'ready'
         AND (
           (
             e.access IN ('public', 'free_mini')
             AND e.public_at <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             e.access = 'early_access'
             AND COALESCE(e.premium_at, e.public_at)
               <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             e.access = 'premium_bonus'
             AND e.premium_at <= ${SQL_UTC_NOW_RFC3339}
           )
         )
       LIMIT 1`
    )
    .bind(tokenHash, rssSlug, episodeSlug)
    .first<PrivateEpisodeRow>();
  if (!episode) return transcriptVttNotFound(request, "private");
  const transcript = (
    await loadVerifiedPublicTranscripts(env.DB, episode.id)
  ).find((candidate) => candidate.language === language);
  if (!transcript) return transcriptVttNotFound(request, "private");
  if (privateFeedTokenNeedsTouch(episode.last_used_at)) {
    await touchPrivateFeedToken(env.DB, tokenHash);
  }
  return transcriptVttResponse(
    request,
    renderTranscriptWebVtt(transcript),
    transcript.language,
    "private"
  );
}

async function loadPublicTranscriptEpisode(
  db: D1Database,
  showSlug: string,
  episodeSlug: string
): Promise<PublicEpisodeRow | null> {
  return db
    .prepare(
      `SELECT e.id, e.canonical_url
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE s.slug = ?
         AND s.status != 'archived'
         AND s.test_fixture = 0
         AND e.slug = ?
         AND e.status = 'published'
         AND e.public_at <= ${SQL_UTC_NOW_RFC3339}
         AND e.access IN ('public', 'early_access', 'free_mini')
         AND e.media_status = 'ready'
       LIMIT 1`
    )
    .bind(showSlug, episodeSlug)
    .first<PublicEpisodeRow>();
}

async function loadVerifiedPublicTranscripts(
  db: D1Database,
  episodeId: string
): Promise<VerifiedPublicTranscript[]> {
  const revisions = await db
    .prepare(
      `SELECT
         t.episode_id,
         t.language,
         r.revision,
         r.content_json,
         r.content_sha256,
         a.created_at AS approved_at
       FROM transcripts t
       JOIN transcript_approvals a
         ON a.transcript_id = t.id
        AND a.revision = (
          SELECT MAX(latest.revision)
          FROM transcript_approvals latest
          WHERE latest.transcript_id = t.id
        )
       JOIN transcript_revisions r
         ON r.transcript_id = t.id
        AND r.revision = a.revision
       WHERE t.episode_id = ?
         AND t.language IN ('en', 'es')
         AND r.speaker_labels_confirmed = 1
       ORDER BY t.language`
    )
    .bind(episodeId)
    .all<PublicTranscriptRevisionRow>();

  return (await verifyPublicTranscriptRevisions(revisions.results))
    .map(({ episodeId: _episodeId, ...transcript }) => transcript);
}

export async function loadVerifiedApprovedTranscript(
  db: D1Database,
  episodeId: string,
  language: TranscriptLanguage
): Promise<VerifiedApprovedTranscript | null> {
  const revisions = await db
    .prepare(
      `SELECT
         t.episode_id,
         t.language,
         r.revision,
         r.content_json,
         r.content_sha256,
         a.created_at AS approved_at
       FROM transcripts t
       JOIN transcript_approvals a
         ON a.transcript_id = t.id
        AND a.revision = (
          SELECT MAX(latest.revision)
          FROM transcript_approvals latest
          WHERE latest.transcript_id = t.id
        )
       JOIN transcript_revisions r
         ON r.transcript_id = t.id
        AND r.revision = a.revision
       WHERE t.episode_id = ?
         AND t.language = ?
         AND r.speaker_labels_confirmed = 1
         AND length(CAST(r.content_json AS BLOB)) <= ?
       LIMIT 1`
    )
    .bind(episodeId, language, MAXIMUM_TRANSCRIPT_BYTES)
    .all<PublicTranscriptRevisionRow>();
  const [verified] = await verifyPublicTranscriptRevisions(
    revisions.results
  );
  if (!verified) return null;
  const { episodeId: _episodeId, ...transcript } = verified;
  return transcript;
}

export async function loadVerifiedApprovedTranscriptLanguagesByEpisode(
  db: D1Database,
  episodeIds: string[]
): Promise<Map<string, TranscriptLanguage[]>> {
  const result = new Map<string, TranscriptLanguage[]>();
  const uniqueEpisodeIds = [...new Set(episodeIds.filter(Boolean))];
  for (
    let offset = 0;
    offset < uniqueEpisodeIds.length;
    offset += FEED_TRANSCRIPT_VERIFY_EPISODE_BATCH_SIZE
  ) {
    const chunk = uniqueEpisodeIds.slice(
      offset,
      offset + FEED_TRANSCRIPT_VERIFY_EPISODE_BATCH_SIZE
    );
    const revisions = await db.prepare(
      `SELECT
         t.episode_id,
         t.language,
         r.revision,
         r.content_json,
         r.content_sha256,
         r.speaker_labels_confirmed,
         a.created_at AS approved_at
       FROM transcripts t
       JOIN transcript_approvals a
         ON a.transcript_id = t.id
        AND a.revision = (
          SELECT MAX(latest.revision)
          FROM transcript_approvals latest
          WHERE latest.transcript_id = t.id
        )
       JOIN transcript_revisions r
         ON r.transcript_id = t.id
        AND r.revision = a.revision
       WHERE t.episode_id IN (${chunk.map(() => "?").join(", ")})
         AND t.language IN ('en', 'es')
         AND r.speaker_labels_confirmed = 1
         AND length(CAST(r.content_json AS BLOB)) <= ?
       ORDER BY t.episode_id, t.language`
    ).bind(...chunk, MAXIMUM_TRANSCRIPT_BYTES)
      .all<PublicTranscriptRevisionRow>();
    const verified = await verifyPublicTranscriptRevisions(
      revisions.results
    );
    for (const transcript of verified) {
      const languages = result.get(transcript.episodeId) ?? [];
      if (!languages.includes(transcript.language)) {
        languages.push(transcript.language);
        languages.sort();
      }
      result.set(transcript.episodeId, languages);
    }
  }
  return result;
}

async function verifyPublicTranscriptRevisions(
  revisions: PublicTranscriptRevisionRow[]
): Promise<VerifiedPublicTranscriptRow[]> {
  const transcripts: VerifiedPublicTranscriptRow[] = [];
  for (const revision of revisions) {
    if (
      !LANGUAGES.has(revision.language)
      || new TextEncoder().encode(revision.content_json).byteLength
        > MAXIMUM_TRANSCRIPT_BYTES
    ) {
      continue;
    }
    const content = parseTranscriptContent(
      revision.content_json,
      revision.language
    );
    if (
      content.cues.length < 1
      || content.cues.some(
        ({ speakerLabel, speakerConfirmed }) =>
          Boolean(speakerLabel) && !speakerConfirmed
      )
    ) {
      continue;
    }
    const canonicalJson = serializeTranscriptContent(content);
    if (await sha256Hex(canonicalJson) !== revision.content_sha256) {
      continue;
    }
    transcripts.push({
      episodeId: revision.episode_id,
      language: revision.language as TranscriptLanguage,
      revision: revision.revision,
      approvedAt: revision.approved_at,
      contentSha256: revision.content_sha256,
      cues: content.cues.map((cue) => ({
        id: cue.id,
        startsAtMs: cue.startsAtMs,
        endsAtMs: cue.endsAtMs,
        speakerLabel: cue.speakerLabel,
        text: publicTimedText(cue.textMarkdown)
      }))
    });
  }
  return transcripts;
}

export async function listAdminEpisodeTranscripts(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
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

export async function serveAdminEpisodeTranscriptCaptions(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  languageValue: string,
  format: "vtt" | "srt"
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    READ_ROLES
  );
  if (authorized instanceof Response) return authorized;
  const language = validTranscriptLanguage(languageValue);
  const transcriptId = await stableTranscriptId(
    authorized.episode.id,
    language
  );
  const transcript = await loadTranscript(env.DB, transcriptId);
  if (
    !transcript
    || transcript.revision < 1
    || !transcript.content_sha256
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcript_not_found" },
      { status: 404 }
    );
  }
  const content = parseTranscriptContent(
    transcript.content_json,
    transcript.language
  );
  const contentJson = serializeTranscriptContent(content);
  if (
    content.cues.length < 1
    || await sha256Hex(contentJson) !== transcript.content_sha256
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "transcript_content_mismatch" },
      { status: 409 }
    );
  }
  const cues = content.cues.map((cue) => ({
    startsAtMs: cue.startsAtMs,
    endsAtMs: cue.endsAtMs,
    speakerLabel: cue.speakerConfirmed ? cue.speakerLabel : "",
    text: timedTextMarkdownToPlainText(cue.textMarkdown)
  }));
  const body = format === "srt" ? renderSubRip(cues) : renderWebVtt(cues);
  const etag = `"${await sha256Hex(body)}"`;
  const headers = new Headers({
    ...privateCorsHeaders(request, env.ALLOWED_ORIGINS),
    "access-control-expose-headers":
      "content-disposition,etag,x-podcast-transcript-revision",
    "cache-control": "private, no-store, max-age=0",
    "content-disposition": `attachment; filename="${safeDownloadFilename(
      `transcript-${language}-revision-${transcript.revision}.${format}`
    )}"`,
    "content-language": language,
    "content-length": String(new TextEncoder().encode(body).byteLength),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": format === "srt"
      ? "application/x-subrip; charset=utf-8"
      : "text/vtt; charset=utf-8",
    "cross-origin-resource-policy": "same-site",
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-podcast-transcript-revision": String(transcript.revision),
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

export async function saveAdminEpisodeTranscript(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  languageValue: string
): Promise<Response> {
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    EDIT_ROLES,
    { requireCsrf: true }
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
  await env.DB.batch([
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
  const committed = await verifyTranscriptRevisionCommit(env.DB, {
    transcriptId,
    mutationId,
    revisionId,
    auditId,
    baseRevision,
    targetRevision,
    contentSha256,
    speakerLabelsConfirmed: labelsConfirmed
  });
  if (!committed) {
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
  const authorized = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    APPROVE_ROLES,
    { requireCsrf: true }
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
  await env.DB.batch([
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
    ),
    prepareResolveTranscriptReviewAction(env.DB, transcriptId)
  ]);
  const committed = await verifyTranscriptApprovalCommit(env.DB, {
    transcriptId,
    approvalId,
    auditId,
    revision: expectedRevision,
    adminUserId: authorized.authorization.identity.id
  });
  if (!committed) {
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

function publicTimedText(textMarkdown: string): string {
  return timedTextMarkdownToPlainText(textMarkdown);
}

function renderTranscriptWebVtt(
  transcript: VerifiedPublicTranscript
): string {
  return renderWebVtt(transcript.cues);
}

async function transcriptVttResponse(
  request: Request,
  body: string,
  language: TranscriptLanguage,
  visibility: "public" | "private"
): Promise<Response> {
  const etag = `"${await sha256Hex(body)}"`;
  const headers = transcriptVttHeaders(language, visibility);
  headers.set("etag", etag);
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers
  });
}

function transcriptVttNotFound(
  request: Request,
  visibility: "public" | "private"
): Response {
  const headers = transcriptVttHeaders(null, visibility);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "private, no-store, max-age=0");
  return new Response(
    request.method === "HEAD" ? null : "transcript_not_found\n",
    { status: 404, headers }
  );
}

function transcriptVttHeaders(
  language: TranscriptLanguage | null,
  visibility: "public" | "private"
): Headers {
  const headers = new Headers({
    "content-type": "text/vtt; charset=utf-8",
    "cache-control": visibility === "public"
      ? "public, max-age=60, stale-while-revalidate=300"
      : "private, no-store, max-age=0",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer"
  });
  if (language) headers.set("content-language", language);
  if (visibility === "public") {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", "etag");
    headers.set("cross-origin-resource-policy", "cross-origin");
  } else {
    headers.set("cross-origin-resource-policy", "same-origin");
  }
  return headers;
}

function publicTranscriptJson(
  request: Request,
  body: unknown,
  {
    status,
    cacheControl
  }: {
    status: number;
    cacheControl: string;
  }
): Response {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify(body),
    {
      status,
      headers: publicTranscriptHeaders(cacheControl)
    }
  );
}

function publicTranscriptHeaders(cacheControl: string): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheControl,
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "etag",
    "cross-origin-resource-policy": "cross-origin",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer"
  });
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*"
      || value === etag
      || (value.startsWith("W/") && value.slice(2) === etag);
  });
}

export async function stableTranscriptId(
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

function validTranscriptLanguage(value: unknown): TranscriptLanguage {
  const language = requiredText(value, "language", 2).toLowerCase();
  if (!LANGUAGES.has(language)) {
    throw new RequestValidationError("language must be en or es");
  }
  return language as TranscriptLanguage;
}

function validateTimedTextMarkdown(value: unknown, field: string): string {
  const text = requiredText(value, field, MAXIMUM_CAPTION_LENGTH)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/
      .test(text)
  ) {
    throw new RequestValidationError(
      `${field} contains control or direction-override characters`
    );
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
  if (
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/.test(text)
  ) {
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
