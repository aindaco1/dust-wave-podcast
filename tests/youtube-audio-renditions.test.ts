import { describe, expect, it, vi } from "vitest";

import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("YouTube audio rendition route boundary", () => {
  it("keeps every rendition mutation absent outside isolated staging", async () => {
    const prepare = vi.fn();
    const env = {
      ENVIRONMENT: "production",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: { prepare }
    } as unknown as PodcastEnv;
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
          + "episode_fixture/youtube-audio-renditions",
        { method: "POST" }
      ),
      env
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "youtube_audio_rendition_not_found"
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("hides processor routes when the callback secret is absent", async () => {
    const prepare = vi.fn();
    const env = {
      ENVIRONMENT: "staging",
      ALLOWED_ORIGINS:
        "https://dust-wave-website-staging.pages.dev",
      DB: { prepare }
    } as unknown as PodcastEnv;
    const response = await handleRequest(
      new Request(
        "https://dust-wave-podcast-staging.jogo.workers.dev/v1/processor/"
          + "youtube-audio-renditions/rendition_fixture/manifest",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            renditionId: "rendition_fixture",
            action: "manifest"
          })
        }
      ),
      env
    );
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects unsigned multipart bytes before storage or database access", async () => {
    const prepare = vi.fn();
    const resumeMultipartUpload = vi.fn();
    const env = {
      ENVIRONMENT: "staging",
      ALLOWED_ORIGINS:
        "https://dust-wave-website-staging.pages.dev",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_secret_fixture",
      DB: { prepare },
      MEDIA_BUCKET: { resumeMultipartUpload }
    } as unknown as PodcastEnv;
    const response = await handleRequest(
      new Request(
        "https://dust-wave-podcast-staging.jogo.workers.dev/v1/processor/"
          + "youtube-audio-renditions/rendition_fixture/parts/1",
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "3"
          },
          body: new Uint8Array([1, 2, 3])
        }
      ),
      env
    );
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    expect(resumeMultipartUpload).not.toHaveBeenCalled();
  });
});
