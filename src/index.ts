import { handleRequest } from "./app";
import { pruneAdminAuthState } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { processPodcastJob, scheduleDuePublications } from "./jobs";
import { pruneListenerAuthState } from "./listener-auth";
import {
  pruneSubscriptionBillingRateLimits
} from "./subscription-checkout";
import { pruneTaxQuoteRateLimits } from "./tax-quotes";
import { schedulePendingTranscriptions } from "./transcription-jobs";
import type { PodcastJob } from "./types";
import {
  schedulePendingAnnouncementDeliveries
} from "./announcement-delivery";

export default {
  async fetch(request: Request, env: PodcastEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          method: request.method,
          rayId: request.headers.get("cf-ray"),
          errorName: error instanceof Error ? error.name : "UnknownError"
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
          episodeId: message.body.episodeId ?? null,
          queueMessageId: message.id,
          attempt: message.attempts
        })
      );
      try {
        await processPodcastJob(env, message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "job_failed",
            jobId: message.body.id,
            jobType: message.body.type,
            showId: message.body.showId,
            episodeId: message.body.episodeId ?? null,
            queueMessageId: message.id,
            attempt: message.attempts,
            errorName: error instanceof Error ? error.name : "UnknownError"
          })
        );
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
      pruneAdminAuthState(env.DB),
      pruneListenerAuthState(env.DB),
      pruneSubscriptionBillingRateLimits(env.DB),
      pruneTaxQuoteRateLimits(env.DB),
      schedulePendingAnnouncementDeliveries(env),
      schedulePendingTranscriptions(env)
    ]);
  }
} satisfies ExportedHandler<PodcastEnv, PodcastJob>;
