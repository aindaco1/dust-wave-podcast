import type { PodcastEnv } from "./env";
import { publishEpisodeNewsSnapshot } from "./github";
import type { PodcastJob } from "./types";

type DueJob = {
  id: string;
  show_id: string;
  episode_id: string;
  destination: "rss" | "youtube" | "news" | "email";
  publication_revision: number;
};

export async function scheduleDuePublications(env: PodcastEnv): Promise<void> {
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
         e.publication_revision
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
      type: destinationJobType(job.destination),
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
  if (!job.episodeId) throw new Error("Publication job is missing episodeId");
  const state = await env.DB
    .prepare(
      `SELECT status, scheduled_at
       FROM distribution_jobs
       WHERE id = ? AND episode_id = ?`
    )
    .bind(job.id, job.episodeId)
    .first<{ status: string; scheduled_at: string }>();
  if (!state || state.status === "succeeded" || state.status === "canceled") return;
  if (parseDatabaseDate(state.scheduled_at).getTime() > Date.now()) {
    throw new Error("Publication job is not due");
  }
  await env.DB
    .prepare(
      `UPDATE distribution_jobs
       SET
         status = 'running',
         started_at = COALESCE(started_at, datetime('now')),
         attempt_count = attempt_count + 1,
         last_error = NULL
       WHERE id = ?`
    )
    .bind(job.id)
    .run();

  try {
    let providerId = "";
    if (job.type === "publish-news") {
      const result = await publishEpisodeNewsSnapshot(
        env,
        job.episodeId,
        job.publicationRevision ?? 0
      );
      providerId = result.dryRun ? "dry-run" : result.commitSha ?? "";
      await env.DB
        .prepare(
          `UPDATE site_publications
           SET
             status = 'succeeded',
             github_commit_sha = ?,
             updated_at = datetime('now')
           WHERE episode_id = ? AND publication_revision = ?`
        )
        .bind(result.commitSha ?? null, job.episodeId, job.publicationRevision ?? 0)
        .run();
    } else if (job.type === "publish-youtube") {
      if (String(env.YOUTUBE_PUBLISH_MODE) === "live") {
        throw new Error("Live YouTube publishing adapter is not enabled");
      }
      providerId = "dry-run";
    } else if (job.type === "publish-rss") {
      providerId = "dynamic-feed";
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
         WHERE id = ?`
      )
      .bind(providerId, job.id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_job_error";
    await env.DB
      .prepare(
        `UPDATE distribution_jobs
         SET status = 'failed', last_error = ?, completed_at = datetime('now')
         WHERE id = ?`
      )
      .bind(message.slice(0, 500), job.id)
      .run();
    if (job.type === "publish-news") {
      await env.DB
        .prepare(
          `UPDATE site_publications
           SET status = 'failed', last_error = ?, updated_at = datetime('now')
           WHERE episode_id = ? AND publication_revision = ?`
        )
        .bind(message.slice(0, 500), job.episodeId, job.publicationRevision ?? 0)
        .run();
    }
    throw error;
  }
}

function destinationJobType(destination: DueJob["destination"]): PodcastJob["type"] {
  if (destination === "rss") return "publish-rss";
  if (destination === "news") return "publish-news";
  if (destination === "youtube") return "publish-youtube";
  return "send-premium-notification";
}

function parseDatabaseDate(value: string): Date {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}
