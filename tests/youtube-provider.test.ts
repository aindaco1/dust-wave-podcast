import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  uploadUnlistedYouTubeVideo,
  verifyYouTubeVideo,
  YouTubeProviderError
} from "../src/youtube-provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YouTube provider adapter", () => {
  it("uses bounded OAuth, resumable upload, and channel/privacy verification", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          location:
            "https://www.googleapis.com/upload/youtube/v3/videos"
            + "?upload_id=upload_fixture"
        }
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: "video_12345"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          snippet: { channelId: "channel_fixture" },
          status: { privacyStatus: "unlisted" }
        }]
      }));
    vi.stubGlobal("fetch", providerFetch);

    const result = await uploadUnlistedYouTubeVideo(
      configuredEnv(),
      {
        title: "Captioned clip",
        description: "Private launch evidence",
        privacyStatus: "unlisted",
        contentLength: 4,
        body: new Response("clip").body as ReadableStream
      }
    );

    expect(result).toEqual({ videoId: "video_12345" });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    expect(String(providerFetch.mock.calls[0][0])).toBe(
      "https://oauth2.googleapis.com/token"
    );
    expect(String(providerFetch.mock.calls[1][0])).toContain(
      "uploadType=resumable"
    );
    expect(String(providerFetch.mock.calls[2][0])).toContain(
      "upload_id=upload_fixture"
    );
    expect(String(providerFetch.mock.calls[3][0])).toContain(
      "id=video_12345"
    );
    const uploadInit = providerFetch.mock.calls[2][1] as RequestInit;
    expect(new Headers(uploadInit.headers).get("content-length")).toBe("4");
    expect(new Headers(uploadInit.headers).get("authorization"))
      .toBe("Bearer access_token_fixture");
  });

  it("rejects a resumable session outside the fixed Google upload origin", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          location: "https://attacker.example/upload?upload_id=fixture"
        }
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(uploadUnlistedYouTubeVideo(
      configuredEnv(),
      {
        title: "Captioned clip",
        description: "",
        privacyStatus: "private",
        contentLength: 4,
        body: new Response("clip").body as ReadableStream
      }
    )).rejects.toMatchObject({
      code: "youtube_upload_session_failed"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("fails when uploaded evidence belongs to another channel", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          location:
            "https://www.googleapis.com/upload/youtube/v3/videos"
            + "?upload_id=upload_fixture"
        }
      }))
      .mockResolvedValueOnce(jsonResponse({ id: "video_12345" }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          snippet: { channelId: "channel_other" },
          status: { privacyStatus: "unlisted" }
        }]
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(uploadUnlistedYouTubeVideo(
      configuredEnv(),
      {
        title: "Captioned clip",
        description: "",
        privacyStatus: "unlisted",
        contentLength: 4,
        body: new Response("clip").body as ReadableStream
      }
    )).rejects.toMatchObject({
      code: "youtube_verification_failed"
    } satisfies Partial<YouTubeProviderError>);
  });

  it("stops reading provider JSON after the bounded response limit", async () => {
    const oversized = new Uint8Array(64_001);
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", providerFetch);

    await expect(uploadUnlistedYouTubeVideo(
      configuredEnv(),
      {
        title: "Captioned clip",
        description: "",
        privacyStatus: "private",
        contentLength: 4,
        body: new Response("clip").body as ReadableStream
      }
    )).rejects.toMatchObject({
      code: "youtube_oauth_failed"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("verifies a known provider ID without initiating another upload", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          snippet: { channelId: "channel_fixture" },
          status: { privacyStatus: "unlisted" }
        }]
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(verifyYouTubeVideo(configuredEnv(), {
      videoId: "video_12345",
      privacyStatus: "unlisted"
    })).resolves.toEqual({ videoId: "video_12345" });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(String(providerFetch.mock.calls[1][0])).toContain(
      "id=video_12345"
    );
  });
});

function configuredEnv(): PodcastEnv {
  return {
    YOUTUBE_CLIENT_ID: "client_fixture",
    YOUTUBE_CLIENT_SECRET: "secret_fixture",
    YOUTUBE_REFRESH_TOKEN: "refresh_fixture",
    YOUTUBE_CHANNEL_ID: "channel_fixture"
  } as PodcastEnv;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}
