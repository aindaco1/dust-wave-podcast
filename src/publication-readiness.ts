import { sha256Hex } from "@dustwave/worker-core/crypto";

import { hasAdminRoleForShow } from "./admin-auth";
import { authorizeAdminEpisode } from "./admin-episode-access";
import {
  LAUNCH_CLAIM_REQUIRED_DESTINATIONS,
  loadDistributionLaunchCertification,
  type DistributionCertificationSummary
} from "./distribution-certification";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  publicationFingerprint,
  publicationPrerequisiteFailures
} from "./publication-contract";
import {
  hasPublicationDestination,
  planEpisodePublication,
  type EpisodePublicationPlan
} from "./publication-intent";
import {
  publicationGateMode
} from "./publication-gate";
import {
  getProductionReviewReadiness,
  type ProductionReviewReadiness
} from "./production-reviews";
import type { EpisodeAccess } from "./types";
import { RequestValidationError } from "./validation";

const READ_ROLES = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
] as const;

type EpisodeReadinessRow = {
  id: string;
  show_id: string;
  status: string;
  access: EpisodeAccess;
  explicit: number;
  title: string;
  summary: string;
  content_html: string;
  guid: string | null;
  canonical_url: string;
  public_at: string | null;
  premium_at: string | null;
  audio_key: string | null;
  audio_mime_type: string | null;
  audio_bytes: number | null;
  audio_etag: string | null;
  duration_seconds: number | null;
  media_status: string;
  video_source_key: string | null;
  youtube_video_key?: string | null;
  publication_revision: number;
  publication_fingerprint: string | null;
  publication_evidence_version: number;
  show_evidence_version: number;
  global_evidence_version: number;
  dynamic_ads_enabled: number;
  show_status: string;
  show_slug: string;
  show_language: string;
  show_rss_slug: string;
  show_youtube_channel_url: string | null;
  show_premium_enabled: number;
  show_dynamic_ads_enabled: number;
  working_master_revision: number | null;
  current_master_id: string | null;
  working_master_origin_kind: string | null;
  working_master_source_sha256: string | null;
  working_master_qc_report_sha256: string | null;
  delivery_audio_job_id: string | null;
  delivery_audio_source_master_id: string | null;
  delivery_audio_stream_profile: string | null;
  delivery_audio_output_sha256: string | null;
  delivery_audio_peaks_sha256: string | null;
  delivery_audio_peaks_bytes: number | null;
  delivery_audio_peaks_length: number | null;
};

type TranscriptReadinessRow = {
  id: string;
  language: string;
  status: string;
  revision: number;
  approved_revision: number | null;
  content_sha256: string | null;
  alignment_status: string | null;
  alignment_transcript_sha256: string | null;
};

type ChapterReadinessRow = {
  status: string;
  revision: number;
  approved_revision: number | null;
  content_sha256: string | null;
};

type ClipReadinessAggregate = {
  total: number;
  current_count: number;
  ready_render_count: number;
};

type AdPlanReadinessRow = {
  id: string;
  revision: number;
  status: string;
  source_object_key: string;
  source_object_bytes: number;
  source_object_etag: string;
  processor_manifest_sha256: string | null;
  approved_marker_count: number;
  segment_count: number;
  ready_segment_count: number;
};

type ReleaseJobRow = {
  destination: string;
  status: string;
  publication_revision: number;
  site_status: string | null;
};

export type ReadinessStatus =
  | "ready"
  | "missing"
  | "pending"
  | "stale"
  | "failed"
  | "not_applicable";

export type ReadinessSeverity = "blocker" | "warning" | "info";

export type PublicationReadinessNode = {
  id: string;
  group: "core" | "editorial" | "monetization" | "distribution";
  label: string;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  summary: string;
  evidence: Record<string, unknown>;
};

export type PublicationReadinessInput = {
  episode: EpisodeReadinessRow;
  publicationFingerprintCurrent: boolean | null;
  transcripts: TranscriptReadinessRow[];
  chapters: ChapterReadinessRow | null;
  clips: ClipReadinessAggregate;
  adPlan: AdPlanReadinessRow | null;
  directories: DistributionCertificationSummary;
  jobs: ReleaseJobRow[];
  reviews: ProductionReviewReadiness;
  githubPublishMode: string;
  youtubePublishMode: string;
};

export type PublicationReadinessSnapshot = {
  snapshotSchemaVersion: 1;
  episodeId: string;
  publicationRevision: number;
  evidenceVersion: number;
  showEvidenceVersion: number;
  globalEvidenceVersion: number;
  snapshotDigest: string;
  generatedAt: string;
  legacyGate: {
    ready: boolean;
    missing: string[];
  };
  candidateGate: {
    ready: boolean;
    blockerCount: number;
    warningCount: number;
    publishingEnforced: boolean;
    overrideAvailable: boolean;
  };
  nodes: PublicationReadinessNode[];
};

export async function getAdminEpisodePublicationReadiness(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response> {
  const access = await authorizeAdminEpisode(
    request,
    env,
    episodeIdValue,
    [...READ_ROLES]
  );
  if (access instanceof Response) return access;
  const episodeId = access.episode.id;
  const snapshot = await buildEpisodePublicationReadiness(env, episodeId);
  if (!snapshot) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  const mode = publicationGateMode(env.PUBLICATION_GATE_MODE);
  const overrideAvailable = mode === "enforce"
    && hasAdminRoleForShow(
      access.authorization.identity,
      ["super_admin", "admin"],
      access.episode.showId
    );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    ...snapshot,
    publicationGateMode: mode,
    candidateGate: {
      ...snapshot.candidateGate,
      publishingEnforced: mode === "enforce",
      overrideAvailable
    }
  });
}

export async function buildEpisodePublicationReadiness(
  env: PodcastEnv,
  episodeId: string
): Promise<PublicationReadinessSnapshot | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await loadEpisodePublicationReadiness(env, episodeId);
    if (!snapshot) return null;
    const stable = await env.DB.prepare(
      `SELECT
         episode.publication_revision,
         episode.publication_evidence_version,
         show_evidence.version AS show_evidence_version,
         (
           SELECT version
           FROM publication_global_evidence_versions
           WHERE id = 'distribution'
         ) AS global_evidence_version
       FROM episodes episode
       JOIN publication_show_evidence_versions show_evidence
         ON show_evidence.show_id = episode.show_id
       WHERE episode.id = ?`
    ).bind(episodeId).first<{
      publication_revision: number;
      publication_evidence_version: number;
      show_evidence_version: number;
      global_evidence_version: number;
    }>();
    if (!stable) return null;
    if (
      stable.publication_revision === snapshot.publicationRevision
      && stable.publication_evidence_version === snapshot.evidenceVersion
      && stable.show_evidence_version === snapshot.showEvidenceVersion
      && stable.global_evidence_version === snapshot.globalEvidenceVersion
    ) {
      return snapshot;
    }
  }
  throw new RequestValidationError(
    "Publication evidence is changing. Retry after current edits finish.",
    "publication_snapshot_busy",
    409
  );
}

async function loadEpisodePublicationReadiness(
  env: PodcastEnv,
  episodeId: string
): Promise<PublicationReadinessSnapshot | null> {
  const episode = await env.DB.prepare(
    `SELECT
       e.id, e.show_id, e.status, e.access, e.explicit, e.title, e.summary,
       e.content_html,
       e.guid, e.canonical_url, e.public_at, e.premium_at, e.audio_key,
       e.audio_mime_type, e.audio_bytes, e.audio_etag, e.duration_seconds,
       e.media_status, e.video_source_key,
       COALESCE(
         e.video_source_key,
         (
           SELECT upload.object_key
           FROM media_uploads upload
           WHERE upload.id = e.youtube_rendition_upload_id
             AND upload.status = 'completed'
             AND upload.kind = 'video_source'
         )
       ) AS youtube_video_key,
       e.publication_revision,
       e.publication_fingerprint, e.publication_evidence_version,
       e.dynamic_ads_enabled,
       show_evidence.version AS show_evidence_version,
       (
         SELECT version
         FROM publication_global_evidence_versions
         WHERE id = 'distribution'
       ) AS global_evidence_version,
       s.status AS show_status, s.slug AS show_slug,
       s.language AS show_language, s.rss_slug AS show_rss_slug,
       s.youtube_channel_url AS show_youtube_channel_url,
       s.premium_enabled AS show_premium_enabled,
       s.dynamic_ads_enabled AS show_dynamic_ads_enabled,
       master_state.revision AS working_master_revision,
       master_state.current_master_id,
       master.origin_kind AS working_master_origin_kind,
       master.source_sha256 AS working_master_source_sha256,
       master.quality_control_report_sha256
         AS working_master_qc_report_sha256,
       delivery.id AS delivery_audio_job_id,
       delivery.source_master_id AS delivery_audio_source_master_id,
       delivery.stream_profile AS delivery_audio_stream_profile,
       delivery.output_sha256 AS delivery_audio_output_sha256,
       delivery.peaks_sha256 AS delivery_audio_peaks_sha256,
       delivery.peaks_object_bytes AS delivery_audio_peaks_bytes,
       delivery.peaks_length AS delivery_audio_peaks_length
     FROM episodes e
     JOIN shows s ON s.id = e.show_id
     JOIN publication_show_evidence_versions show_evidence
       ON show_evidence.show_id = e.show_id
     LEFT JOIN episode_working_master_states master_state
       ON master_state.episode_id = e.id
     LEFT JOIN episode_working_masters master
       ON master.id = master_state.current_master_id
      AND master.episode_id = e.id
      AND master.revision = master_state.revision
     LEFT JOIN delivery_audio_jobs delivery
       ON delivery.episode_id = e.id
      AND delivery.status = 'approved'
      AND delivery.source_master_id = master_state.current_master_id
      AND delivery.output_object_key = e.audio_key
      AND delivery.output_object_bytes = e.audio_bytes
      AND delivery.output_object_etag = e.audio_etag
     WHERE e.id = ?`
  ).bind(episodeId).first<EpisodeReadinessRow>();
  if (!episode) return null;

  const [
    transcripts,
    chapters,
    clips,
    adPlan,
    directories,
    jobs,
    reviews
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT
         t.id, t.language, t.status, t.revision, t.approved_revision,
         t.content_sha256, alignment.status AS alignment_status,
         alignment.transcript_revision_sha256 AS alignment_transcript_sha256
       FROM transcripts t
       LEFT JOIN transcript_alignment_revisions alignment
         ON alignment.id = (
           SELECT candidate.id
           FROM transcript_alignment_revisions candidate
           WHERE candidate.transcript_id = t.id
             AND candidate.transcript_revision_sha256 = t.content_sha256
           ORDER BY candidate.created_at DESC, candidate.id DESC
           LIMIT 1
         )
       WHERE t.episode_id = ?
       ORDER BY t.language`
    ).bind(episodeId).all<TranscriptReadinessRow>(),
    env.DB.prepare(
      `SELECT status, revision, approved_revision, content_sha256
       FROM episode_chapter_sets
       WHERE episode_id = ?`
    ).bind(episodeId).first<ChapterReadinessRow>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE
           WHEN c.revision > 0
             AND c.status = 'ready'
             AND c.recipe_sha256 IS NOT NULL
             AND c.source_object_key = ?
             AND c.source_object_bytes = ?
             AND c.source_object_etag = ?
             AND t.status = 'approved'
             AND t.approved_revision = c.transcript_revision
             AND t.content_sha256 = c.transcript_sha256
           THEN 1 ELSE 0 END), 0) AS current_count,
         COALESCE(SUM(CASE
           WHEN render.status = 'ready'
             AND render.clip_revision = c.revision
             AND render.recipe_sha256 = c.recipe_sha256
           THEN 1 ELSE 0 END), 0) AS ready_render_count
       FROM clips c
       LEFT JOIN transcripts t ON t.id = c.transcript_id
       LEFT JOIN clip_renders render
         ON render.id = (
           SELECT candidate.id
           FROM clip_renders candidate
           WHERE candidate.clip_id = c.id
             AND candidate.clip_revision = c.revision
           ORDER BY candidate.requested_at DESC, candidate.id DESC
           LIMIT 1
         )
       WHERE c.episode_id = ?`
    ).bind(
      episode.audio_key,
      episode.audio_bytes,
      episode.audio_etag,
      episodeId
    ).first<ClipReadinessAggregate>(),
    env.DB.prepare(
      `SELECT
         plan.id, plan.revision, plan.status, plan.source_object_key,
         plan.source_object_bytes, plan.source_object_etag,
         plan.processor_manifest_sha256,
         (
           SELECT COUNT(*)
           FROM episode_ad_markers marker
           WHERE marker.episode_id = plan.episode_id
             AND marker.plan_id = plan.id
             AND marker.enabled = 1
             AND marker.approved_at IS NOT NULL
         ) AS approved_marker_count,
         (
           SELECT COUNT(*)
           FROM episode_audio_segments segment
           WHERE segment.episode_id = plan.episode_id
             AND segment.plan_id = plan.id
         ) AS segment_count,
         (
           SELECT COUNT(*)
           FROM episode_audio_segments segment
           WHERE segment.episode_id = plan.episode_id
             AND segment.plan_id = plan.id
             AND segment.validation_status = 'ready'
         ) AS ready_segment_count
       FROM episode_ad_plans plan
       WHERE plan.episode_id = ?
       ORDER BY plan.revision DESC
       LIMIT 1`
    ).bind(episodeId).first<AdPlanReadinessRow>(),
    loadDistributionLaunchCertification(env.DB, episode.show_id)
      .then(({ summary }) => summary),
    env.DB.prepare(
      `SELECT
         job.destination, job.status, job.publication_revision,
         site.status AS site_status
       FROM distribution_jobs job
       LEFT JOIN site_publications site
         ON job.destination = 'news'
         AND site.episode_id = job.episode_id
         AND site.publication_revision = job.publication_revision
       WHERE job.episode_id = ?
         AND job.publication_revision = ?
       ORDER BY job.destination`
    ).bind(
      episodeId,
      episode.publication_revision
    ).all<ReleaseJobRow>(),
    getProductionReviewReadiness(env.DB, episodeId)
  ]);

  const input: PublicationReadinessInput = {
    episode,
    publicationFingerprintCurrent:
      await currentPublicationFingerprintState(episode),
    transcripts: transcripts.results,
    chapters: chapters ?? null,
    clips: clips ?? { total: 0, current_count: 0, ready_render_count: 0 },
    adPlan: adPlan ?? null,
    directories,
    jobs: jobs.results,
    reviews,
    githubPublishMode: String(env.GITHUB_PUBLISH_MODE || "dry_run"),
    youtubePublishMode: String(env.YOUTUBE_PUBLISH_MODE || "dry_run")
  };
  const evaluated = evaluatePublicationReadiness(input);
  const snapshotDigest = await sha256Hex(JSON.stringify({
    snapshotSchemaVersion: 1,
    episodeId,
    publicationRevision: episode.publication_revision,
    evidenceVersion: episode.publication_evidence_version,
    showEvidenceVersion: episode.show_evidence_version,
    globalEvidenceVersion: episode.global_evidence_version,
    legacyGate: evaluated.legacyGate,
    candidateGate: {
      ready: evaluated.candidateGate.ready,
      blockerCount: evaluated.candidateGate.blockerCount,
      warningCount: evaluated.candidateGate.warningCount
    },
    nodes: evaluated.nodes
  }));
  return {
    snapshotSchemaVersion: 1,
    episodeId,
    publicationRevision: episode.publication_revision,
    evidenceVersion: episode.publication_evidence_version,
    showEvidenceVersion: episode.show_evidence_version,
    globalEvidenceVersion: episode.global_evidence_version,
    snapshotDigest,
    generatedAt: new Date().toISOString(),
    ...evaluated
  };
}

export function evaluatePublicationReadiness(
  input: PublicationReadinessInput
): {
  legacyGate: {
    ready: boolean;
    missing: string[];
  };
  candidateGate: {
    ready: boolean;
    blockerCount: number;
    warningCount: number;
    publishingEnforced: boolean;
    overrideAvailable: boolean;
  };
  nodes: PublicationReadinessNode[];
} {
  const { episode } = input;
  const publicationPlan = planEpisodePublication({
    access: episode.access,
    youtubeVideoKey: episode.youtube_video_key ?? episode.video_source_key
  });
  const missing = publicationPrerequisiteFailures({
    title: episode.title,
    summary: episode.summary,
    guid: episode.guid,
    audioKey: episode.audio_key,
    audioMimeType: episode.audio_mime_type,
    audioBytes: episode.audio_bytes,
    durationSeconds: episode.duration_seconds,
    mediaStatus: episode.media_status
  });
  const nodes: PublicationReadinessNode[] = [
    metadataNode(episode, input.publicationFingerprintCurrent),
    workingMasterNode(episode),
    audioNode(episode),
    releaseTimingNode(episode),
    primaryTranscriptNode(episode, input.transcripts),
    bilingualTranscriptNode(input.transcripts),
    alignmentNode(episode, input.transcripts),
    chapterNode(input.chapters),
    reviewNode(input.reviews),
    clipNode(input.clips),
    adNode(episode, input.adPlan),
    newsNode(
      episode,
      input.jobs,
      input.githubPublishMode,
      publicationPlan
    ),
    rssNode(episode, input.jobs),
    youtubeNode(
      episode,
      input.jobs,
      input.youtubePublishMode,
      publicationPlan
    ),
    directoryNode(input.directories)
  ];
  const blockerCount = nodes.filter(isUnreadyBlocker).length;
  const warningCount = nodes.filter((node) =>
    node.severity === "warning"
    && !["ready", "not_applicable"].includes(node.status)
  ).length;
  return {
    legacyGate: {
      ready: missing.length === 0,
      missing
    },
    candidateGate: {
      ready: blockerCount === 0,
      blockerCount,
      warningCount,
      publishingEnforced: false,
      overrideAvailable: false
    },
    nodes
  };
}

function workingMasterNode(
  episode: EpisodeReadinessRow
): PublicationReadinessNode {
  const fields = {
    id: episode.current_master_id,
    revision: episode.working_master_revision,
    originKind: episode.working_master_origin_kind,
    hasSourceSha256: /^[a-f0-9]{64}$/.test(
      episode.working_master_source_sha256 ?? ""
    ),
    hasQualityControlReportSha256: /^[a-f0-9]{64}$/.test(
      episode.working_master_qc_report_sha256 ?? ""
    )
  };
  const ready = Boolean(
    fields.id
    && Number(fields.revision) > 0
    && fields.originKind
    && fields.hasSourceSha256
    && fields.hasQualityControlReportSha256
  );
  return node({
    id: "core.working_master",
    group: "core",
    label: "Approved working master",
    status: ready ? "ready" : "missing",
    severity: "blocker",
    summary: ready
      ? "An explicit master approval is bound to exact source and QC evidence."
      : "Approve the current zero-blocker source as the working master.",
    evidence: fields
  });
}

function metadataNode(
  episode: EpisodeReadinessRow,
  publicationFingerprintCurrent: boolean | null
): PublicationReadinessNode {
  const fields = {
    title: Boolean(episode.title.trim()),
    summary: Boolean(episode.summary.trim()),
    guid: Boolean(episode.guid),
    canonicalUrl: isHttpsUrl(episode.canonical_url),
    episodeNotes: Boolean(episode.content_html.trim())
  };
  const requiredReady = fields.title
    && fields.summary
    && fields.guid
    && fields.canonicalUrl
    && publicationFingerprintCurrent !== false;
  return node({
    id: "core.metadata",
    group: "core",
    label: "Canonical episode metadata",
    status: requiredReady
      ? "ready"
      : publicationFingerprintCurrent === false
        ? "stale"
        : "missing",
    severity: "blocker",
    summary: requiredReady
      ? publicationFingerprintCurrent === true
        ? "Metadata matches the exact current publication revision."
        : "Title, summary, GUID, and canonical HTTPS page are present."
      : publicationFingerprintCurrent === false
        ? "Episode content changed after the current publication revision."
        : "Complete the title, summary, GUID, and canonical HTTPS page.",
    evidence: {
      ...fields,
      publicationFingerprintCurrent
    }
  });
}

function audioNode(
  episode: EpisodeReadinessRow
): PublicationReadinessNode {
  const fields = {
    hasObject: Boolean(episode.audio_key),
    hasMimeType: Boolean(episode.audio_mime_type),
    hasByteLength: Number(episode.audio_bytes) > 0,
    hasEtag: Boolean(episode.audio_etag),
    hasDuration: Number(episode.duration_seconds) > 0,
    mediaStatus: episode.media_status,
    deliveryJobId: episode.delivery_audio_job_id,
    currentMasterBound:
      Boolean(episode.current_master_id)
      && episode.delivery_audio_source_master_id
        === episode.current_master_id,
    normalizedProfile:
      episode.delivery_audio_stream_profile
        === "mp3-44100-stereo-cbr128-frame-v1",
    hasAudioSha256: Boolean(episode.delivery_audio_output_sha256),
    hasPlayerPeaks:
      Boolean(episode.delivery_audio_peaks_sha256)
      && Number(episode.delivery_audio_peaks_bytes) > 0
      && Number(episode.delivery_audio_peaks_length) > 0
  };
  const ready = fields.hasObject
    && fields.hasMimeType
    && fields.hasByteLength
    && fields.hasEtag
    && fields.hasDuration
    && fields.mediaStatus === "ready"
    && Boolean(fields.deliveryJobId)
    && fields.currentMasterBound
    && fields.normalizedProfile
    && fields.hasAudioSha256
    && fields.hasPlayerPeaks;
  return node({
    id: "core.delivery_audio",
    group: "core",
    label: "Exact delivery audio",
    status: ready
      ? "ready"
      : episode.media_status === "failed"
        ? "failed"
        : episode.media_status === "processing"
          ? "pending"
          : "missing",
    severity: "blocker",
    summary: ready
      ? "Approved normalized audio and player peaks match the current working master."
      : "Approved normalized delivery audio and checksum-bound player peaks are required.",
    evidence: fields
  });
}

function releaseTimingNode(
  episode: EpisodeReadinessRow
): PublicationReadinessNode {
  const publicAt = validTimestamp(episode.public_at);
  const premiumAt = validTimestamp(episode.premium_at);
  const premiumAccess = ["early_access", "premium_bonus"].includes(
    episode.access
  );
  const premiumConfigured = episode.show_premium_enabled === 1;
  let status: ReadinessStatus = "ready";
  let summary = publicAt
    ? "The release time is explicit."
    : "Publish will release immediately because no public time is set.";
  if (premiumAccess && !premiumConfigured) {
    status = "missing";
    summary = "This access mode requires premium subscriptions on the show.";
  } else if (episode.access === "early_access") {
    if (!publicAt || !premiumAt) {
      status = "missing";
      summary = "Early access needs both premium and public release times.";
    } else if (premiumAt > publicAt) {
      status = "failed";
      summary = "Premium release cannot follow public release.";
    } else {
      summary = "Premium early access precedes the public release.";
    }
  } else if (episode.access === "premium_bonus" && !publicAt) {
    status = "missing";
    summary = "A bonus episode needs a release time for its private feed.";
  }
  return node({
    id: "core.release_window",
    group: "core",
    label: "Release and entitlement window",
    status,
    severity: "blocker",
    summary,
    evidence: {
      access: episode.access,
      premiumConfigured,
      hasPremiumAt: Boolean(premiumAt),
      hasPublicAt: Boolean(publicAt)
    }
  });
}

function primaryTranscriptNode(
  episode: EpisodeReadinessRow,
  transcripts: TranscriptReadinessRow[]
): PublicationReadinessNode {
  const primary = transcripts.find(
    ({ language }) => language === episode.show_language
  );
  const approved = isApprovedTranscript(primary);
  return node({
    id: "editorial.primary_transcript",
    group: "editorial",
    label: "Primary-language transcript",
    status: approved
      ? "ready"
      : primary
        ? "pending"
        : "missing",
    severity: "blocker",
    summary: approved
      ? `The ${episode.show_language.toUpperCase()} transcript revision is approved.`
      : primary
        ? `Approve the current ${episode.show_language.toUpperCase()} transcript revision.`
        : `Create the ${episode.show_language.toUpperCase()} transcript.`,
    evidence: {
      language: episode.show_language,
      exists: Boolean(primary),
      revision: primary?.revision ?? null,
      approvedRevision: primary?.approved_revision ?? null
    }
  });
}

function bilingualTranscriptNode(
  transcripts: TranscriptReadinessRow[]
): PublicationReadinessNode {
  const approvedLanguages = transcripts
    .filter(isApprovedTranscript)
    .map(({ language }) => language)
    .sort();
  const ready = ["en", "es"].every((language) =>
    approvedLanguages.includes(language)
  );
  return node({
    id: "editorial.bilingual_transcripts",
    group: "editorial",
    label: "Spanish and English transcripts",
    status: ready
      ? "ready"
      : approvedLanguages.length > 0
        ? "pending"
        : "missing",
    severity: "warning",
    summary: ready
      ? "Current Spanish and English transcript revisions are approved."
      : "Complete both Spanish and English approvals for the bilingual launch experience.",
    evidence: { approvedLanguages }
  });
}

function alignmentNode(
  episode: EpisodeReadinessRow,
  transcripts: TranscriptReadinessRow[]
): PublicationReadinessNode {
  const primary = transcripts.find(
    ({ language }) => language === episode.show_language
  );
  const exactTranscript = primary
    && primary.content_sha256
    && primary.alignment_transcript_sha256 === primary.content_sha256;
  const ready = isApprovedTranscript(primary)
    && exactTranscript
    && primary?.alignment_status === "passed";
  const status: ReadinessStatus = ready
    ? "ready"
    : !primary
      ? "missing"
      : primary.alignment_status === "failed"
        ? "failed"
        : exactTranscript
          ? "pending"
          : "stale";
  return node({
    id: "editorial.word_alignment",
    group: "editorial",
    label: "Word-alignment quality gate",
    status,
    severity: "blocker",
    summary: ready
      ? "The passed word alignment matches the approved primary transcript."
      : "Run and pass word alignment against the current approved primary transcript.",
    evidence: {
      transcriptRevision: primary?.revision ?? null,
      exactTranscript: Boolean(exactTranscript),
      alignmentStatus: primary?.alignment_status ?? "not_run"
    }
  });
}

function chapterNode(
  chapters: ChapterReadinessRow | null
): PublicationReadinessNode {
  if (!chapters) {
    return node({
      id: "editorial.chapters",
      group: "editorial",
      label: "Episode chapters",
      status: "not_applicable",
      severity: "info",
      summary: "Chapters are optional; no chapter draft exists.",
      evidence: { exists: false }
    });
  }
  const approved = chapters.status === "approved"
    && chapters.revision > 0
    && chapters.approved_revision === chapters.revision
    && Boolean(chapters.content_sha256);
  return node({
    id: "editorial.chapters",
    group: "editorial",
    label: "Episode chapters",
    status: approved ? "ready" : "pending",
    severity: "warning",
    summary: approved
      ? "The current chapter revision is approved."
      : "A chapter draft exists and still needs exact-revision approval.",
    evidence: {
      revision: chapters.revision,
      approvedRevision: chapters.approved_revision,
      status: chapters.status
    }
  });
}

function reviewNode(
  reviews: ProductionReviewReadiness
): PublicationReadinessNode {
  return node({
    id: "editorial.production_review",
    group: "editorial",
    label: "Exact-revision production review",
    status: reviews.reviewReady
      ? "ready"
      : reviews.openBlockerCount > 0
        ? "failed"
        : "pending",
    severity: "blocker",
    summary: reviews.reviewReady
      ? "Every current target is approved with no open blockers."
      : reviews.evidenceTruncated
        ? "Review evidence exceeded its safety bound; resolve or archive history before release."
        : "Approve every current target and resolve all release blockers.",
    evidence: {
      currentTargetCount: reviews.currentTargetCount,
      currentReviewCount: reviews.currentReviewCount,
      approvedCurrentReviewCount: reviews.approvedCurrentReviewCount,
      unreviewedCurrentTargetCount: reviews.unreviewedCurrentTargetCount,
      openBlockerCount: reviews.openBlockerCount,
      evidenceTruncated: reviews.evidenceTruncated
    }
  });
}

function clipNode(
  clips: ClipReadinessAggregate
): PublicationReadinessNode {
  if (Number(clips.total) === 0) {
    return node({
      id: "editorial.promotion_clips",
      group: "editorial",
      label: "Captioned promotion clips",
      status: "not_applicable",
      severity: "info",
      summary: "Promotion clips are optional; none are saved.",
      evidence: { total: 0, current: 0, readyRenders: 0 }
    });
  }
  const stale = Number(clips.total) - Number(clips.current_count);
  return node({
    id: "editorial.promotion_clips",
    group: "editorial",
    label: "Captioned promotion clips",
    status: stale > 0 ? "stale" : "ready",
    severity: "warning",
    summary: stale > 0
      ? "One or more clip recipes reference superseded audio or transcript evidence."
      : "Every saved clip recipe references current audio and transcript evidence.",
    evidence: {
      total: Number(clips.total),
      current: Number(clips.current_count),
      stale,
      readyRenders: Number(clips.ready_render_count)
    }
  });
}

function adNode(
  episode: EpisodeReadinessRow,
  plan: AdPlanReadinessRow | null
): PublicationReadinessNode {
  const showEnabled = episode.show_dynamic_ads_enabled === 1;
  const episodeEnabled = episode.dynamic_ads_enabled === 1;
  if (!showEnabled && !episodeEnabled) {
    return node({
      id: "monetization.dynamic_ads",
      group: "monetization",
      label: "Dynamic ad plan",
      status: "not_applicable",
      severity: "info",
      summary: "Dynamic ads are disabled for this show and episode.",
      evidence: { showEnabled, episodeEnabled }
    });
  }
  if (!showEnabled || !episodeEnabled) {
    return node({
      id: "monetization.dynamic_ads",
      group: "monetization",
      label: "Dynamic ad plan",
      status: "pending",
      severity: "warning",
      summary: "Show and episode dynamic-ad switches do not agree.",
      evidence: { showEnabled, episodeEnabled }
    });
  }
  const sourceCurrent = Boolean(plan)
    && plan?.source_object_key === episode.audio_key
    && plan?.source_object_bytes === episode.audio_bytes
    && plan?.source_object_etag === episode.audio_etag;
  const ready = sourceCurrent
    && plan?.status === "approved"
    && Boolean(plan.processor_manifest_sha256)
    && Number(plan.approved_marker_count) > 0
    && Number(plan.segment_count) > 0
    && Number(plan.ready_segment_count) === Number(plan.segment_count);
  return node({
    id: "monetization.dynamic_ads",
    group: "monetization",
    label: "Dynamic ad plan",
    status: ready
      ? "ready"
      : plan && !sourceCurrent
        ? "stale"
        : plan?.status === "failed"
          ? "failed"
          : plan
            ? "pending"
            : "missing",
    severity: "blocker",
    summary: ready
      ? "The approved ad plan, markers, and program segments match current audio."
      : "Approve a processed ad plan with current source audio, markers, and validated segments.",
    evidence: {
      showEnabled,
      episodeEnabled,
      planRevision: plan?.revision ?? null,
      planStatus: plan?.status ?? "missing",
      sourceCurrent,
      approvedMarkers: Number(plan?.approved_marker_count ?? 0),
      segments: Number(plan?.segment_count ?? 0),
      readySegments: Number(plan?.ready_segment_count ?? 0)
    }
  });
}

function newsNode(
  episode: EpisodeReadinessRow,
  jobs: ReleaseJobRow[],
  mode: string,
  publicationPlan: EpisodePublicationPlan
): PublicationReadinessNode {
  const release = releaseEvidence(jobs, "news");
  const contractReady = isHttpsUrl(episode.canonical_url);
  const isTeaser = publicationPlan.newsMode === "premium_teaser";
  return node({
    id: "distribution.news",
    group: "distribution",
    label: "Canonical News page",
    status: release?.status ?? (contractReady ? "ready" : "missing"),
    severity: "blocker",
    summary: release?.summary ?? (
      contractReady
        ? isTeaser
          ? "The canonical premium teaser is media-free by contract."
          : "The canonical News snapshot contract is ready for publication."
        : "A canonical HTTPS News page is required."
    ),
    evidence: {
      mode,
      pageMode: publicationPlan.newsMode,
      publicationRevision: release?.publicationRevision ?? null,
      jobStatus: release?.jobStatus ?? "not_created",
      siteStatus: release?.siteStatus ?? "not_created"
    }
  });
}

function rssNode(
  episode: EpisodeReadinessRow,
  jobs: ReleaseJobRow[]
): PublicationReadinessNode {
  const release = releaseEvidence(jobs, "rss");
  const showReady = episode.show_status !== "archived"
    && Boolean(episode.show_rss_slug);
  return node({
    id: "distribution.rss",
    group: "distribution",
    label: "Canonical RSS feed",
    status: release?.status ?? (showReady ? "ready" : "missing"),
    severity: "blocker",
    summary: release?.summary ?? (
      showReady
        ? "The show feed can expose this revision when its release window opens."
        : "The show needs an active RSS identity."
    ),
    evidence: {
      showStatus: episode.show_status,
      hasRssSlug: Boolean(episode.show_rss_slug),
      publicationRevision: release?.publicationRevision ?? null,
      jobStatus: release?.jobStatus ?? "not_created"
    }
  });
}

function youtubeNode(
  episode: EpisodeReadinessRow,
  jobs: ReleaseJobRow[],
  mode: string,
  publicationPlan: EpisodePublicationPlan
): PublicationReadinessNode {
  if (!hasPublicationDestination(publicationPlan, "youtube")) {
    const premiumBonus = episode.access === "premium_bonus";
    return node({
      id: "distribution.youtube",
      group: "distribution",
      label: "YouTube release",
      status: "not_applicable",
      severity: "info",
      summary: premiumBonus
        ? "Premium-only bonus episodes do not publish to YouTube."
        : "This is an audio-only episode, so no YouTube upload is expected.",
      evidence: {
        access: episode.access,
        hasVideoSource: Boolean(
          episode.youtube_video_key ?? episode.video_source_key
        ),
        nativeVideoSource: Boolean(episode.video_source_key),
        mode
      }
    });
  }
  const release = releaseEvidence(jobs, "youtube");
  const configured = Boolean(episode.show_youtube_channel_url);
  return node({
    id: "distribution.youtube",
    group: "distribution",
    label: "YouTube release",
    status: release?.status ?? (configured ? "ready" : "missing"),
    severity: "blocker",
    summary: release?.summary ?? (
      configured
        ? "Video and the show channel are ready for the public release job."
        : "Set the show YouTube channel before publishing video."
    ),
    evidence: {
      hasVideoSource: true,
      channelConfigured: configured,
      mode,
      publicationRevision: release?.publicationRevision ?? null,
      jobStatus: release?.jobStatus ?? "not_created"
    }
  });
}

function directoryNode(
  directories: DistributionCertificationSummary
): PublicationReadinessNode {
  const enabled = Number(directories.enabled);
  const setupComplete = Number(directories.setupComplete);
  const feedValidated = Boolean(directories.feedValidated);
  const ingestionObserved = Number(directories.ingestionObserved);
  const failureRecoveryVerified = Number(
    directories.failureRecoveryVerified
  );
  const certified = Number(directories.certified);
  const ready = certified >= LAUNCH_CLAIM_REQUIRED_DESTINATIONS;
  return node({
    id: "distribution.directories",
    group: "distribution",
    label: "10+ listening platforms",
    status: ready ? "ready" : enabled > 0 ? "pending" : "missing",
    severity: "warning",
    summary: ready
      ? "At least ten directories have owner, feed, ingestion, and recovery evidence."
      : "Certify owner setup, the canonical feed, ingestion, and failure recovery for at least ten directories before making the 10+ platforms claim.",
    evidence: {
      registered: Number(directories.total),
      enabled,
      setupComplete,
      setupRequired: Math.max(0, enabled - setupComplete),
      feedValidated,
      ingestionObserved,
      failureRecoveryVerified,
      certified,
      required: LAUNCH_CLAIM_REQUIRED_DESTINATIONS,
      remaining: Math.max(
        0,
        LAUNCH_CLAIM_REQUIRED_DESTINATIONS - certified
      )
    }
  });
}

function releaseEvidence(
  jobs: ReleaseJobRow[],
  destination: string
): {
  status: ReadinessStatus;
  summary: string;
  publicationRevision: number;
  jobStatus: string;
  siteStatus: string | null;
} | null {
  const job = jobs.find((candidate) => candidate.destination === destination);
  if (!job) return null;
  const status: ReadinessStatus = job.status === "succeeded"
    && (destination !== "news" || job.site_status === "succeeded")
    ? "ready"
    : job.status === "failed" || job.site_status === "failed"
      ? "failed"
      : "pending";
  return {
    status,
    summary: status === "ready"
      ? "The current publication revision completed successfully."
      : status === "failed"
        ? "The current publication revision failed and needs attention."
        : "The current publication revision is queued or running.",
    publicationRevision: job.publication_revision,
    jobStatus: job.status,
    siteStatus: job.site_status
  };
}

function isApprovedTranscript(
  transcript: TranscriptReadinessRow | undefined
): transcript is TranscriptReadinessRow {
  return Boolean(
    transcript
    && transcript.status === "approved"
    && transcript.revision > 0
    && transcript.approved_revision === transcript.revision
    && transcript.content_sha256
  );
}

function isUnreadyBlocker(node: PublicationReadinessNode): boolean {
  return node.severity === "blocker"
    && !["ready", "not_applicable"].includes(node.status);
}

function node(
  value: PublicationReadinessNode
): PublicationReadinessNode {
  return value;
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function currentPublicationFingerprintState(
  episode: EpisodeReadinessRow
): Promise<boolean | null> {
  if (
    episode.publication_revision < 1
    || !["scheduled", "published"].includes(episode.status)
    || !episode.public_at
  ) {
    return null;
  }
  if (!episode.publication_fingerprint) return false;
  const current = await publicationFingerprint({
    id: episode.id,
    showId: episode.show_id,
    showSlug: episode.show_slug,
    title: episode.title,
    summary: episode.summary,
    contentHtml: episode.content_html,
    access: episode.access,
    explicit: episode.explicit,
    guid: episode.guid,
    audioKey: episode.audio_key,
    audioMimeType: episode.audio_mime_type,
    audioBytes: episode.audio_bytes,
    durationSeconds: episode.duration_seconds,
    videoSourceKey: episode.youtube_video_key ?? episode.video_source_key,
    publicAt: episode.public_at,
    canonicalUrl: episode.canonical_url
  });
  return current === episode.publication_fingerprint;
}
