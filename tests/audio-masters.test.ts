import { describe, expect, it } from "vitest";

import {
  approveAdminEpisodeSourceMaster,
  completeAudioEnhancementPreview,
  getAdminEpisodeAudioMaster,
  queueAdminAudioEnhancementPreview,
  uploadAudioEnhancementProcessorOutput
} from "../src/audio-masters";
import type { PodcastEnv } from "../src/env";
import { handleRequest } from "../src/app";

describe("working-master and enhancement boundaries", () => {
  it("keeps master state private without an admin session", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz"
    } as unknown as PodcastEnv;
    const read = await getAdminEpisodeAudioMaster(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-master"
      ),
      env,
      "episode_fixture"
    );
    const approve = await approveAdminEpisodeSourceMaster(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-master/approve-source",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "episode_fixture"
    );

    expect(read.status).toBe(401);
    expect(approve.status).toBe(401);
    expect(read.headers.get("cache-control")).toContain("private");
    expect(await read.json()).toEqual({ error: "unauthorized" });
  });

  it("hides staging-only preview queueing outside staging", async () => {
    const response = await queueAdminAudioEnhancementPreview(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-previews",
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

  it("rejects unsigned processor completion and output before database access", async () => {
    const env = {
      ENVIRONMENT: "staging",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor-secret",
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const completion = await completeAudioEnhancementPreview(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/audio-enhancements/"
        + "enhance_fixture/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "enhance_fixture"
    );
    const output = await uploadAudioEnhancementProcessorOutput(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/audio-enhancements/"
        + "enhance_fixture/outputs/original",
        { method: "PUT", body: "not-audio" }
      ),
      env,
      "enhance_fixture",
      "original"
    );

    expect(completion.status).toBe(401);
    expect(output.status).toBe(401);
    expect(await completion.json()).toEqual({
      error: "invalid_processor_signature"
    });
    expect(await output.json()).toEqual({
      error: "invalid_processor_signature"
    });
  });

  it("routes master endpoints and rejects unsupported methods", async () => {
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-master",
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
});
