import { handleRequest } from "./app";
import type { PodcastJob } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

  async queue(batch: MessageBatch<PodcastJob>): Promise<void> {
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
      message.ack();
    }
  }
} satisfies ExportedHandler<Env, PodcastJob>;

