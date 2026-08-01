import { FINAL_WORKING_MASTER_DECISION_SQL } from "./final-working-master";
import type { TranscriptLanguage } from "./transcripts";

export type AlignedEditorialSource = {
  episode_id: string;
  episode_title: string;
  episode_duration_seconds: number | null;
  show_language: string;
  working_master_id: string;
  transcript_id: string;
  source_language: TranscriptLanguage;
  transcript_revision: number;
  transcript_sha256: string;
  alignment_revision_id: string;
};

// Chapters and clips intentionally share this exact eligibility boundary.
// Callers may append only their domain-specific suppression predicate, stable
// ordering, and bounded LIMIT.
export const ALIGNED_EDITORIAL_SOURCES_SQL = `SELECT
    episode.id AS episode_id,
    episode.title AS episode_title,
    episode.duration_seconds AS episode_duration_seconds,
    show.language AS show_language,
    state.current_master_id AS working_master_id,
    transcript.id AS transcript_id,
    transcript.language AS source_language,
    transcript_revision.revision AS transcript_revision,
    transcript_revision.content_sha256 AS transcript_sha256,
    alignment_revision.id AS alignment_revision_id
  FROM transcripts transcript
  JOIN episodes episode ON episode.id = transcript.episode_id
  JOIN shows show ON show.id = episode.show_id
  JOIN transcript_approvals transcript_approval
    ON transcript_approval.transcript_id = transcript.id
   AND transcript_approval.revision = (
     SELECT MAX(latest.revision)
     FROM transcript_approvals latest
     WHERE latest.transcript_id = transcript.id
   )
  JOIN transcript_revisions transcript_revision
    ON transcript_revision.transcript_id = transcript.id
   AND transcript_revision.revision = transcript_approval.revision
  JOIN episode_working_master_states state
    ON state.episode_id = episode.id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = episode.id
  JOIN audio_qc_runs qc
    ON qc.id = master.quality_control_run_id
   AND qc.status = 'succeeded'
   AND qc.blocker_count = 0
  JOIN transcript_alignment_jobs alignment_job
    ON alignment_job.episode_id = episode.id
   AND alignment_job.working_master_id = state.current_master_id
   AND alignment_job.transcript_id = transcript.id
   AND alignment_job.transcript_revision = transcript_revision.revision
   AND alignment_job.transcript_content_sha256 = transcript_revision.content_sha256
   AND alignment_job.status = 'ready'
  JOIN transcript_alignment_revisions alignment_revision
    ON alignment_revision.id = alignment_job.alignment_revision_id
   AND alignment_revision.transcript_id = transcript.id
   AND alignment_revision.transcript_revision_sha256 = transcript_revision.content_sha256
   AND alignment_revision.language = transcript.language
   AND alignment_revision.status = 'passed'
  JOIN transcript_alignment_approvals alignment_approval
    ON alignment_approval.alignment_revision_id = alignment_revision.id
  WHERE episode.status IN ('draft', 'scheduled')
    AND transcript.language IN ('en', 'es')
    AND transcript_revision.speaker_labels_confirmed = 1
    AND length(CAST(transcript_revision.content_json AS BLOB)) <= 1000000
    AND ${FINAL_WORKING_MASTER_DECISION_SQL}`;

export const ALIGNED_EDITORIAL_SOURCES_ORDER_SQL =
  "ORDER BY alignment_approval.created_at, episode.id, transcript.language";
