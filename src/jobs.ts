import type { PodcastEnv } from "./env";
import { publishEpisodeNewsSnapshot } from "./github";
import {
  processTranscriptionJob
} from "./transcription-jobs";
import type { PodcastJob } from "./types";
import { processClipYouTubePublication } from "./clip-youtube";
import { processAnnouncementDelivery } from "./announcement-delivery";
import { processEpisodeYouTubePublication } from "./episode-youtube";
import { validateAndRecordPublicFeed } from "./feed-validation";

export type PublicationDestination = "rss" | "youtube" | "news" | "email";

type DueJob = {
  id: string;
  show_id: string;
  episode_id: string;
  destination: PublicationDestination;
  publication_revision: number;
};

type DurablePublicationJob = {
  status: string;
  scheduled_at: string;
  destination: PublicationDestination;
  show_id: string;
  current_publication_revision: number;
  site_status: string | null;
  github_commit_sha: string | null;
};

export async function scheduleDuePublications(env: PodcastEnv): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE episode_youtube_publications
       SET
         status = 'reconciliation_required',
         failure_code = 'youtube_worker_interrupted',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE status = 'uploading'
         AND started_at <= datetime('now', '-15 minutes')`
    )
    .run();
  await env.DB
    .prepare(
      `UPDATE distribution_jobs
       SET
         status = 'failed',
         completed_at = datetime('now'),
         last_error = 'youtube_upload_state_requires_reconciliation'
       WHERE status = 'running'
         AND destination = 'youtube'
         AND started_at <= datetime('now', '-15 minutes')`
    )
    .run();
  await env.DB
    .prepare(
      `UPDATE distribution_jobs
       SET
         status = 'queued',
         started_at = NULL,
         completed_at = NULL,
         last_error = 'Previous attempt did not finish; queued for safe recovery.'
       WHERE status = 'running'
         AND destination != 'youtube'
         AND started_at <= datetime('now', '-15 minutes')`
    )
    .run();
  await env.DB
    .prepare(
      `UPDATE episodes
       SET status = 'published', updated_at = datetime('now')
       WHERE status = 'scheduled' AND public_at <= datetime('now')`
    )
    .run();
  const due = await env.DB
    .prepare(
      `SELECT
         j.id, e.show_id, j.episode_id, j.destination,
         j.publication_revision
       FROM distribution_jobs j
       JOIN episodes e ON e.id = j.episode_id
       WHERE j.status = 'queued'
         AND j.scheduled_at <= datetime('now')
       ORDER BY j.scheduled_at
       LIMIT 100`
    )
    .all<DueJob>();
  for (const job of due.results) {
    await env.JOBS.send({
      id: job.id,
      type: publicationJobType(job.destination),
      showId: job.show_id,
      episodeId: job.episode_id,
      publicationRevision: job.publication_revision,
      requestedAt: new Date().toISOString()
    });
  }
}

export async function processPodcastJob(
  env: PodcastEnv,
  job: PodcastJob
): Promise<void> {
  if (job.type === "send-announcement") {
    await processAnnouncementDelivery(env, job);
    return;
  }
  if (job.type === "transcribe") {
    await processTranscriptionJob(env, job);
    return;
  }
  if (job.type === "publish-youtube-clip") {
    await processClipYouTubePublication(env, job);
    return;
  }
  if (!job.episodeId) throw new Error("Publication job is missing episodeId");
  const state = await env.DB
    .prepare(
      `SELECT
         j.status,
         j.scheduled_at,
         j.destination,
         e.show_id,
         e.publication_revision AS current_publication_revision,
         sp.status AS site_status,
         sp.github_commit_sha
       FROM distribution_jobs j
       JOIN episodes e ON e.id = j.episode_id
       LEFT JOIN site_publications sp
         ON j.destination = 'news'
         AND sp.episode_id = j.episode_id
         AND sp.publication_revision = j.publication_revision
       WHERE j.id = ?
         AND j.episode_id = ?
         AND j.publication_revision = ?`
    )
    .bind(job.id, job.episodeId, job.publicationRevision ?? 0)
    .first<DurablePublicationJob>();
  if (!state) return;
  const publicationRevision = job.publicationRevision ?? 0;
  if (state.current_publication_revision !== publicationRevision) {
    await env.DB
      .prepare(
        `UPDATE distribution_jobs
         SET
           status = 'canceled',
           completed_at = datetime('now'),
           last_error = 'Superseded by a newer publication revision.'
         WHERE id = ?
           AND episode_id = ?
           AND publication_revision = ?
           AND status IN ('queued', 'failed')`
      )
      .bind(job.id, job.episodeId, publicationRevision)
      .run();
    return;
  }
  if (
    state.status === "succeeded"
    || state.status === "canceled"
    || state.status === "running"
  ) return;
  if (
    state.show_id !== job.showId
    || publicationJobType(state.destination) !== job.type
  ) {
    throw new Error("Publication job does not match durable state");
  }
  if (parseDatabaseDate(state.scheduled_at).getTime() > Date.now()) {
    throw new Error("Publication job is not due");
  }
  const claim = await env.DB
    .prepare(
      `UPDATE distribution_jobs
       SET
         status = 'running',
         started_at = datetime('now'),
         completed_at = NULL,
         attempt_count = attempt_count + 1,
         last_error = NULL
       WHERE id = ?
         AND episode_id = ?
         AND publication_revision = ?
         AND status IN ('queued', 'failed')`
    )
    .bind(job.id, job.episodeId, publicationRevision)
    .run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return;

  try {
    let providerId = "";
    if (job.type === "publish-news") {
      if (state.site_status === "succeeded") {
        providerId = state.github_commit_sha || "site-publication-succeeded";
      } else {
        const result = await publishEpisodeNewsSnapshot(
          env,
          job.episodeId,
          publicationRevision
        );
        providerId = result.dryRun ? "dry-run" : result.commitSha ?? "";
        await env.DB
          .prepare(
            `UPDATE site_publications
             SET
               status = 'succeeded',
               github_commit_sha = ?,
               updated_at = datetime('now')
             WHERE episode_id = ?
               AND publication_revision = ?
               AND EXISTS (
                 SELECT 1
                 FROM distribution_jobs
                 WHERE id = ?
                   AND episode_id = ?
                   AND publication_revision = ?
                   AND status = 'running'
               )`
          )
          .bind(
            result.commitSha ?? null,
            job.episodeId,
            publicationRevision,
            job.id,
            job.episodeId,
            publicationRevision
          )
          .run();
      }
    } else if (job.type === "publish-youtube") {
      providerId = await processEpisodeYouTubePublication(env, job);
    } else if (job.type === "publish-rss") {
      const validation = await validateAndRecordPublicFeed(env, job.showId);
      providerId = [
        "validated-feed",
        validation.feedSha256.slice(0, 16),
        validation.itemCount
      ].join(":");
    } else {
      providerId = "queued-contract";
    }
    await env.DB
      .prepare(
        `UPDATE distribution_jobs
         SET
           status = 'succeeded',
           completed_at = datetime('now'),
           provider_id = ?
         WHERE id = ?
           AND episode_id = ?
           AND publication_revision = ?
           AND status = 'running'`
      )
      .bind(
        providerId,
        job.id,
        job.episodeId,
        publicationRevision
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_job_error";
    await env.DB
      .prepare(
        `UPDATE distribution_jobs
         SET status = 'failed', last_error = ?, completed_at = datetime('now')
         WHERE id = ?
           AND episode_id = ?
           AND publication_revision = ?
           AND status = 'running'`
      )
      .bind(
        message.slice(0, 500),
        job.id,
        job.episodeId,
        publicationRevision
      )
      .run();
    if (job.type === "publish-news") {
      await env.DB
        .prepare(
          `UPDATE site_publications
           SET status = 'failed', last_error = ?, updated_at = datetime('now')
           WHERE episode_id = ?
             AND publication_revision = ?
             AND EXISTS (
               SELECT 1
               FROM distribution_jobs
               WHERE id = ?
                 AND episode_id = ?
                 AND publication_revision = ?
                 AND status = 'failed'
             )`
        )
        .bind(
          message.slice(0, 500),
          job.episodeId,
          publicationRevision,
          job.id,
          job.episodeId,
          publicationRevision
        )
        .run();
    }
    throw error;
  }
}

export function publicationJobType(
  destination: PublicationDestination
): PodcastJob["type"] {
  if (destination === "rss") return "publish-rss";
  if (destination === "news") return "publish-news";
  if (destination === "youtube") return "publish-youtube";
  return "send-premium-notification";
}

function parseDatabaseDate(value: string): Date {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}
