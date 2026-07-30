import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  completeTranscriptionChunkRun,
  getTranscriptionChunkProcessorManifest,
  getTranscriptionChunkProcessorSource,
  uploadTranscriptionChunkProcessorOutput
} from "../src/transcription-chunking";

describe("transcription chunk processor boundary", () => {
  it("keeps every processor route absent outside isolated staging", async () => {
    const env = {
      ENVIRONMENT: "production",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          throw new Error("production route must not read D1");
        }
      }
    } as unknown as PodcastEnv;
    for (const response of await processorRequests(env)) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("rejects unsigned staging requests before D1 or R2 access", async () => {
    const env = {
      ENVIRONMENT: "staging",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor-secret",
      DB: {
        prepare() {
          throw new Error("invalid signature must not read D1");
        }
      },
      MEDIA_BUCKET: {
        get() {
          throw new Error("invalid signature must not read R2");
        }
      }
    } as unknown as PodcastEnv;
    for (const response of await processorRequests(env)) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "invalid_processor_signature"
      });
    }
  });
});

async function processorRequests(env: PodcastEnv): Promise<Response[]> {
  const base =
    "https://feeds.dustwave.xyz/v1/processor/transcription-chunks/"
    + "transcription_chunks_fixture";
  return Promise.all([
    getTranscriptionChunkProcessorManifest(
      new Request(`${base}/manifest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      env,
      "transcription_chunks_fixture"
    ),
    getTranscriptionChunkProcessorSource(
      new Request(`${base}/source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      env,
      "transcription_chunks_fixture"
    ),
    uploadTranscriptionChunkProcessorOutput(
      new Request(`${base}/chunks/0`, {
        method: "PUT",
        headers: { "content-type": "audio/mpeg" },
        body: "not-audio"
      }),
      env,
      "transcription_chunks_fixture",
      "0"
    ),
    completeTranscriptionChunkRun(
      new Request(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      env,
      "transcription_chunks_fixture"
    )
  ]);
}
