import { describe, expect, it } from "vitest";

import {
  approveAdminAudioEnhancementDerivative,
  completeAudioEnhancementDerivative,
  listAdminAudioEnhancementDerivatives,
  queueAdminAudioEnhancementDerivative,
  uploadAudioEnhancementDerivativeProcessorPart
} from "../src/audio-enhancement-derivatives";
import { handleRequest } from "../src/app";
import { prepareAdminAuditAfterSingleChange } from "../src/audit";
import type { PodcastEnv } from "../src/env";

describe("full-length audio enhancement derivative boundaries", () => {
  it("keeps list and approval private without an admin session", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz"
    } as unknown as PodcastEnv;
    const list = await listAdminAudioEnhancementDerivatives(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives"
      ),
      env,
      "episode_fixture"
    );
    const approve = await approveAdminAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "audio-enhancement-derivatives/derivative_fixture/approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "derivative_fixture"
    );

    expect(list.status).toBe(401);
    expect(approve.status).toBe(401);
    expect(list.headers.get("cache-control")).toContain("private");
    expect(await list.json()).toEqual({ error: "unauthorized" });
  });

  it("hides queueing outside isolated staging", async () => {
    const response = await queueAdminAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives",
        { method: "POST" }
      ),
      {
        ENVIRONMENT: "production",
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      "episode_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
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
    const completion = await completeAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "audio-enhancement-derivatives/derivative_fixture/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "derivative_fixture"
    );
    const part = await uploadAudioEnhancementDerivativeProcessorPart(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "audio-enhancement-derivatives/"
        + "derivative_fixture/parts/1",
        { method: "PUT", body: "not-audio" }
      ),
      env,
      "derivative_fixture",
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

  it("routes derivative endpoints and rejects unsupported methods", async () => {
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives",
        { method: "DELETE" }
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "method_not_allowed"
    });
  });

  it("records lifecycle audits only after one guarded row changes", () => {
    let query = "";
    let values: unknown[] = [];
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return this;
      }
    };
    const db = {
      prepare(nextQuery: string) {
        query = nextQuery;
        return statement;
      }
    } as unknown as D1Database;

    expect(
      prepareAdminAuditAfterSingleChange(db, {
        adminUserId: null,
        action: "audio_enhancement_derivative.ready",
        targetType: "audio_enhancement_derivative",
        targetId: "derivative_fixture",
        metadata: { outputSha256: "a".repeat(64) }
      })
    ).toBe(statement);
    expect(query).toContain("WHERE changes() = 1");
    expect(values).toContain("audio_enhancement_derivative.ready");
    expect(values).toContain("derivative_fixture");
    expect(values).toContain(null);
  });
});
