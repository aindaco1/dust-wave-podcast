import { handleRequest } from "./app";
import { pruneAdminAuthState } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { processPodcastJob, scheduleDuePublications } from "./jobs";
import type { PodcastJob } from "./types";

export default {
  async fetch(request: Request, env: PodcastEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          message: error instanceof Error ? error.message : "unknown_error"
        })
      );

      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }
  },

  async queue(batch: MessageBatch<PodcastJob>, env: PodcastEnv): Promise<void> {
    for (const message of batch.messages) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "job_received",
          jobId: message.body.id,
          jobType: message.body.type,
          showId: message.body.showId,
          episodeId: message.body.episodeId ?? null
        })
      );
      try {
        await processPodcastJob(env, message.body);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: PodcastEnv
  ): Promise<void> {
    await Promise.all([
      scheduleDuePublications(env),
      pruneAdminAuthState(env.DB)
    ]);
  }
} satisfies ExportedHandler<PodcastEnv, PodcastJob>;
