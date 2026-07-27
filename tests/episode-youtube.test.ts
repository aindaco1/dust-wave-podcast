import { afterEach, describe, expect, it, vi } from "vitest";

import { processEpisodeYouTubePublication } from "../src/episode-youtube";
import type { PodcastEnv } from "../src/env";
import type { PodcastJob } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controlled full-episode YouTube publication", () => {
  it("keeps the ordinary publication path provider-free in dry-run mode", async () => {
    const prepare = vi.fn();
    const env = {
      YOUTUBE_PUBLISH_MODE: "dry_run",
      DB: { prepare }
    } as unknown as PodcastEnv;

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).resolves.toBe("dry-run");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires immutable approval evidence before any controlled upload", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const env = {
      ...configuredEnv(),
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            first
          };
        }
      },
      MEDIA_BUCKET: {
        head: vi.fn(),
        get: vi.fn()
      }
    } as unknown as PodcastEnv;
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).rejects.toMatchObject({ code: "youtube_approval_required" });
    expect(first).toHaveBeenCalledOnce();
    expect(env.MEDIA_BUCKET.head).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("reuses committed provider evidence without replaying an upload", async () => {
    const env = processorEnv({
      publication: publicationRow({
        status: "uploaded",
        provider_video_id: "video_committed"
      })
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).resolves.toBe("video_committed");
    expect(env.MEDIA_BUCKET.head).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("streams the exact approved R2 object and commits verified evidence", async () => {
    const env = processorEnv({ publication: publicationRow() });
    const providerFetch = providerFetchFixture();
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).resolves.toBe("video_12345");

    expect(env.MEDIA_BUCKET.head).toHaveBeenCalledWith(
      "podcasts/show/episode/video_source/upload-video.mp4"
    );
    expect(env.MEDIA_BUCKET.get).toHaveBeenCalledWith(
      "podcasts/show/episode/video_source/upload-video.mp4",
      expect.objectContaining({ onlyIf: expect.any(Headers) })
    );
    expect(providerFetch).toHaveBeenCalledTimes(4);
    expect(env.DB.batch).toHaveBeenCalledOnce();
  });

  it("quarantines ambiguous provider outcomes for manual reconciliation", async () => {
    const failureUpdates: unknown[][] = [];
    const env = processorEnv({
      publication: publicationRow(),
      onRun(query, values) {
        if (query.includes("status = ?")) failureUpdates.push(values);
      }
    });
    const providerFetch = providerFetchFixture("channel_other");
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).rejects.toMatchObject({ code: "youtube_verification_failed" });
    expect(failureUpdates).toContainEqual([
      "reconciliation_required",
      "youtube_verification_failed",
      "episode_youtube_fixture"
    ]);
  });

  it("never retries an uploading or quarantined record", async () => {
    const env = processorEnv({
      publication: publicationRow({ status: "uploading" })
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      processEpisodeYouTubePublication(env, youtubeJob())
    ).rejects.toMatchObject({
      code: "youtube_upload_state_requires_reconciliation"
    });
    expect(env.MEDIA_BUCKET.head).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

function processorEnv({
  publication,
  onRun = () => undefined
}: {
  publication: ReturnType<typeof publicationRow>;
  onRun?: (query: string, values: unknown[]) => void;
}): PodcastEnv {
  const batch = vi.fn().mockResolvedValue([
    { success: true, meta: { changes: 1 } },
    { success: true, meta: { changes: 1 } },
    { success: true, meta: { changes: 1 } }
  ]);
  return {
    ...configuredEnv(),
    DB: {
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async first() {
            return query.includes("FROM episode_youtube_publications p")
              ? publication
              : null;
          },
          async run() {
            onRun(query, values);
            return { success: true, meta: { changes: 1 } };
          }
        };
      },
      batch
    },
    MEDIA_BUCKET: {
      head: vi.fn().mockResolvedValue({
        size: 4,
        httpEtag: "\"video-etag\"",
        httpMetadata: { contentType: "video/mp4" }
      }),
      get: vi.fn().mockResolvedValue({
        size: 4,
        httpEtag: "\"video-etag\"",
        body: new Response("clip").body
      })
    }
  } as unknown as PodcastEnv;
}

function configuredEnv(): Partial<PodcastEnv> {
  return {
    ENVIRONMENT: "staging",
    YOUTUBE_PUBLISH_MODE: "controlled_test",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    YOUTUBE_CHANNEL_ID: "channel_fixture",
    YOUTUBE_CLIENT_ID: "client_fixture",
    YOUTUBE_CLIENT_SECRET: "secret_fixture",
    YOUTUBE_REFRESH_TOKEN: "refresh_fixture"
  } as unknown as Partial<PodcastEnv>;
}

function publicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "episode_youtube_fixture",
    episode_id: "episode_fixture",
    show_id: "show_fixture",
    publication_revision: 3,
    distribution_job_id: "youtube_job_fixture",
    video_upload_id: "upload_fixture",
    video_object_key:
      "podcasts/show/episode/video_source/upload-video.mp4",
    video_object_bytes: 4,
    video_object_etag: "\"video-etag\"",
    video_content_type: "video/mp4",
    channel_url: "https://youtube.com/@dustwavecollective",
    channel_id: "channel_fixture",
    privacy_status: "unlisted",
    title: "Episode fixture",
    description: "Controlled launch evidence",
    status: "queued",
    provider_video_id: null,
    failure_code: null,
    requested_by_admin_user_id: "admin_fixture",
    approved_by_admin_user_id: "admin_fixture",
    requested_at: "2026-07-27 00:00:00",
    approved_at: "2026-07-27 00:01:00",
    started_at: null,
    completed_at: null,
    updated_at: "2026-07-27 00:01:00",
    current_publication_revision: 3,
    access: "public",
    episode_status: "published",
    video_source_key:
      "podcasts/show/episode/video_source/upload-video.mp4",
    episode_title: "Episode fixture",
    episode_summary: "Controlled launch evidence",
    youtube_channel_url: "https://youtube.com/@dustwavecollective",
    distribution_job_status: "running",
    scheduled_at: "2026-07-27 00:00:00",
    distribution_provider_id: null,
    upload_status: "completed",
    upload_object_key:
      "podcasts/show/episode/video_source/upload-video.mp4",
    upload_object_bytes: 4,
    upload_object_etag: "\"video-etag\"",
    upload_content_type: "video/mp4",
    ...overrides
  };
}

function youtubeJob(): PodcastJob {
  return {
    id: "youtube_job_fixture",
    type: "publish-youtube",
    showId: "show_fixture",
    episodeId: "episode_fixture",
    publicationRevision: 3,
    requestedAt: "2026-07-27T00:00:00.000Z"
  };
}

function providerFetchFixture(
  verifiedChannelId = "channel_fixture"
) {
  return vi.fn()
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
        snippet: { channelId: verifiedChannelId },
        status: { privacyStatus: "unlisted" }
      }]
    }));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}
