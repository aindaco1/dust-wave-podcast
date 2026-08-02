import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  uploadUnlistedYouTubeVideo,
  verifyYouTubeChannelAccess,
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
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "channel_fixture" }]
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
    expect(providerFetch).toHaveBeenCalledTimes(5);
    expect(String(providerFetch.mock.calls[0][0])).toBe(
      "https://oauth2.googleapis.com/token"
    );
    const oauthRequest = providerFetch.mock.calls[0][1] as RequestInit;
    expect(typeof oauthRequest.body).toBe("string");
    expect(oauthRequest.redirect).toBe("manual");
    expect(new URLSearchParams(String(oauthRequest.body)).get("grant_type"))
      .toBe("refresh_token");
    expect(String(providerFetch.mock.calls[1][0])).toContain(
      "/youtube/v3/channels"
    );
    expect(String(providerFetch.mock.calls[2][0])).toContain(
      "uploadType=resumable"
    );
    expect(String(providerFetch.mock.calls[3][0])).toContain(
      "upload_id=upload_fixture"
    );
    expect(String(providerFetch.mock.calls[4][0])).toContain(
      "id=video_12345"
    );
    const uploadInit = providerFetch.mock.calls[3][1] as RequestInit;
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
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "channel_fixture" }]
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
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a mismatched OAuth channel before creating an upload session", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "channel_other" }]
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
      code: "youtube_channel_verification_failed"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(String(providerFetch.mock.calls[1][0])).toContain(
      "/youtube/v3/channels"
    );
  });

  it("fails when uploaded evidence belongs to another channel", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "channel_fixture" }]
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
      code: "youtube_oauth_response_invalid"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("reports a revoked OAuth grant without retaining provider details", async () => {
    const providerFetch = vi.fn().mockResolvedValue(jsonResponse(
      {
        error: "invalid_grant",
        error_description: "sensitive provider detail"
      },
      400
    ));
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).rejects.toMatchObject({
      code: "youtube_oauth_invalid_grant",
      message: "youtube_oauth_invalid_grant"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an OAuth redirect without following it", async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/token" }
      })
    );
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).rejects.toMatchObject({
      code: "youtube_oauth_request_rejected"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const request = providerFetch.mock.calls[0][1] as RequestInit;
    expect(request.redirect).toBe("manual");
  });

  it("separates OAuth network failure from provider rejection", async () => {
    const providerFetch = vi.fn().mockRejectedValue(
      new Error("sensitive transport detail")
    );
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).rejects.toMatchObject({
      code: "youtube_oauth_transport_failed",
      message: "youtube_oauth_transport_failed"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("reports an OAuth timeout without exposing its cause", async () => {
    const timeout = new Error("sensitive timeout detail");
    timeout.name = "AbortError";
    const providerFetch = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).rejects.toMatchObject({
      code: "youtube_oauth_timeout",
      message: "youtube_oauth_timeout"
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

  it("preflights the authenticated channel before a controlled queue mutation", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [
          { id: "channel_other" },
          { id: "channel_fixture" }
        ]
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).resolves.toEqual({ channelId: "channel_fixture" });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const lookup = new URL(String(providerFetch.mock.calls[1][0]));
    expect(lookup.origin).toBe("https://www.googleapis.com");
    expect(lookup.pathname).toBe("/youtube/v3/channels");
    expect(lookup.searchParams.get("part")).toBe("id");
    expect(lookup.searchParams.get("mine")).toBe("true");
    expect(lookup.searchParams.get("maxResults")).toBe("50");
    const request = providerFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(request.headers).get("authorization"))
      .toBe("Bearer access_token_fixture");
  });

  it("rejects OAuth access that does not own the configured channel", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access_token_fixture",
        token_type: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "channel_other" }]
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      verifyYouTubeChannelAccess(configuredEnv())
    ).rejects.toMatchObject({
      code: "youtube_channel_verification_failed"
    } satisfies Partial<YouTubeProviderError>);
    expect(providerFetch).toHaveBeenCalledTimes(2);
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
