import { describe, expect, it } from "vitest";

import {
  approveAdminDeliveryAudioJob,
  completeDeliveryAudioJob,
  listAdminDeliveryAudioJobs,
  queueAdminDeliveryAudioJob,
  uploadDeliveryAudioProcessorPart
} from "../src/delivery-audio";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("delivery-audio and player-peaks boundaries", () => {
  it("keeps listing and approval private without an admin session", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz"
    } as unknown as PodcastEnv;
    const list = await listAdminDeliveryAudioJobs(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs"
      ),
      env,
      "episode_fixture"
    );
    const approve = await approveAdminDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "delivery-audio-jobs/delivery_fixture/approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "delivery_fixture"
    );

    expect(list.status).toBe(401);
    expect(approve.status).toBe(401);
    expect(list.headers.get("cache-control")).toContain("private");
    expect(await list.json()).toEqual({ error: "unauthorized" });
  });

  it("hides queueing outside isolated staging", async () => {
    const response = await queueAdminDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs",
        { method: "POST" }
      ),
      {
        ENVIRONMENT: "production",
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      "episode_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "delivery_audio_job_not_found"
    });
  });

  it("rejects unsigned completion and parts before database access", async () => {
    const env = {
      ENVIRONMENT: "staging",
      FEED_ORIGIN:
        "https://dust-wave-podcast-staging.jogo.workers.dev",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor-secret",
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const completion = await completeDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "delivery-audio-jobs/delivery_fixture/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "delivery_fixture"
    );
    const part = await uploadDeliveryAudioProcessorPart(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "delivery-audio-jobs/delivery_fixture/parts/1",
        { method: "PUT", body: "not-audio" }
      ),
      env,
      "delivery_fixture",
      "1"
    );

    expect(completion.status).toBe(401);
    expect(part.status).toBe(401);
    expect(await completion.json()).toEqual({
      error: "invalid_processor_signature"
    });
    expect(await part.json()).toEqual({
      error: "invalid_processor_signature"
    });
  });

  it("routes public peaks and rejects unsupported admin methods", async () => {
    const admin = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs",
        { method: "DELETE" }
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv
    );
    const publicPeaks = await handleRequest(
      new Request(
        "https://media.dustwave.xyz/episodes/episode_fixture/peaks"
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return null;
                  }
                };
              }
            };
          }
        }
      } as unknown as PodcastEnv
    );

    expect(admin.status).toBe(405);
    expect(publicPeaks.status).toBe(404);
    expect(publicPeaks.headers.get("cache-control")).toBe("no-store");
  });
});
