import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import { processClipYouTubePublication } from "../src/clip-youtube";
import type { PodcastEnv } from "../src/env";
import type { PodcastJob } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controlled clip YouTube publication", () => {
  it("creates a private draft then records a recent-super-admin dry run", async () => {
    const fixture = await createFixture();
    const draft = await handleRequest(
      adminRequest(
        "/v1/admin/clip-renders/render_fixture/youtube",
        {
          publicationId: "youtube_fixture",
          expectedClipRevision: 2,
          privacyStatus: "unlisted",
          title: "Captioned launch clip",
          description: "Controlled launch evidence",
          confirmChannelUrl: "https://youtube.com/@dustwavecollective"
        }
      ),
      fixture.env
    );

    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      publication: {
        id: "youtube_fixture",
        status: "draft",
        privacyStatus: "unlisted",
        providerVideoId: null
      },
      idempotent: false
    });
    expect(fixture.r2Heads).toBe(0);
    expect(fixture.queuedJobs).toEqual([]);
    expect(fixture.auditActions).toContain("clip.youtube_draft_created");

    const approval = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );

    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      publication: {
        id: "youtube_fixture",
        status: "dry_run",
        providerVideoId: null
      },
      idempotent: false
    });
    expect(fixture.r2Heads).toBe(1);
    expect(fixture.queuedJobs).toEqual([]);
    expect(fixture.auditActions).toContain(
      "clip.youtube_dry_run_approved"
    );
  });

  it("queues an explicitly configured controlled test without uploading inline", async () => {
    const fixture = await createFixture({
      youtubeMode: "controlled_test",
      providerConfigured: true
    });
    await createDraft(fixture.env);
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const response = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      publication: {
        status: "queued",
        privacyStatus: "unlisted"
      }
    });
    expect(fixture.queuedJobs).toHaveLength(1);
    expect(fixture.queuedJobs[0]).toMatchObject({
      type: "publish-youtube-clip",
      clipRenderId: "render_fixture",
      clipPublicationId: "youtube_fixture"
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("streams the exact private object and commits verified provider evidence", async () => {
    const fixture = await createFixture({
      youtubeMode: "controlled_test",
      providerConfigured: true
    });
    await createDraft(fixture.env);
    await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );
    const providerFetch = providerFetchFixture();
    vi.stubGlobal("fetch", providerFetch);

    await processClipYouTubePublication(
      fixture.env,
      fixture.queuedJobs[0]
    );

    expect(fixture.r2Heads).toBe(2);
    expect(fixture.r2Gets).toBe(1);
    expect(fixture.publication?.status).toBe("uploaded");
    expect(fixture.publication?.provider_video_id).toBe("video_12345");
    expect(fixture.auditActions).toContain(
      "clip.youtube_controlled_test_uploaded"
    );
    expect(providerFetch).toHaveBeenCalledTimes(4);
  });

  it("promotes the same dry-run evidence to one controlled upload", async () => {
    const fixture = await createFixture({
      providerConfigured: true
    });
    await createDraft(fixture.env);
    const dryRun = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );
    expect(dryRun.status).toBe(200);
    expect(fixture.publication?.status).toBe("dry_run");

    Reflect.set(
      fixture.env,
      "YOUTUBE_PUBLISH_MODE",
      "controlled_test"
    );
    const controlled = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );

    expect(controlled.status).toBe(202);
    expect(fixture.publication?.status).toBe("queued");
    expect(fixture.queuedJobs).toHaveLength(1);
    expect(fixture.r2Heads).toBe(2);
  });

  it("fails closed when the controlled gate is restored before consumption", async () => {
    const fixture = await createFixture({
      youtubeMode: "controlled_test",
      providerConfigured: true
    });
    await createDraft(fixture.env);
    await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );
    fixture.env.YOUTUBE_PUBLISH_MODE = "dry_run";
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    await processClipYouTubePublication(
      fixture.env,
      fixture.queuedJobs[0]
    );

    expect(fixture.publication?.status).toBe("failed");
    expect(fixture.publication?.failure_code).toBe(
      "youtube_mode_disabled"
    );
    expect(fixture.r2Heads).toBe(1);
    expect(fixture.r2Gets).toBe(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("marks queue failures without running the provider inline", async () => {
    const fixture = await createFixture({
      youtubeMode: "controlled_test",
      providerConfigured: true,
      queueFails: true
    });
    await createDraft(fixture.env);
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "youtube_queue_failed"
    });
    expect(fixture.publication?.status).toBe("failed");
    expect(fixture.publication?.failure_code).toBe(
      "youtube_queue_failed"
    );
    expect(fixture.queuedJobs).toEqual([]);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not automatically duplicate a provider attempt after failure", async () => {
    const fixture = await createFixture({
      youtubeMode: "controlled_test",
      providerConfigured: true
    });
    await createDraft(fixture.env);
    await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 503 })
    );
    vi.stubGlobal("fetch", providerFetch);

    await expect(processClipYouTubePublication(
      fixture.env,
      fixture.queuedJobs[0]
    )).rejects.toMatchObject({
      code: "youtube_oauth_failed"
    });
    expect(fixture.publication?.status).toBe("failed");
    expect(fixture.publication?.failure_code).toBe(
      "youtube_oauth_failed"
    );
    expect(providerFetch).toHaveBeenCalledTimes(1);

    await processClipYouTubePublication(
      fixture.env,
      fixture.queuedJobs[0]
    );
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("requires recent super-admin authentication before R2 or queue access", async () => {
    const fixture = await createFixture({ recentAuthentication: false });
    await createDraft(fixture.env);
    const response = await handleRequest(
      adminRequest(
        "/v1/admin/clip-youtube-publications/youtube_fixture/approve",
        {}
      ),
      fixture.env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(fixture.r2Heads).toBe(0);
    expect(fixture.queuedJobs).toEqual([]);
  });

  it("rejects public visibility and remains unavailable in production", async () => {
    const fixture = await createFixture();
    const publicAttempt = await handleRequest(
      adminRequest(
        "/v1/admin/clip-renders/render_fixture/youtube",
        {
          publicationId: "youtube_fixture",
          expectedClipRevision: 2,
          privacyStatus: "public",
          title: "Captioned launch clip",
          description: "",
          confirmChannelUrl: "https://youtube.com/@dustwavecollective"
        }
      ),
      fixture.env
    );
    expect(publicAttempt.status).toBe(400);
    expect(fixture.publication).toBeNull();

    const production = await handleRequest(
      adminRequest(
        "/v1/admin/clip-renders/render_fixture/youtube",
        {
          publicationId: "youtube_fixture",
          expectedClipRevision: 2,
          privacyStatus: "unlisted",
          title: "Captioned launch clip",
          description: "",
          confirmChannelUrl: "https://youtube.com/@dustwavecollective"
        }
      ),
      {
        ...fixture.env,
        ENVIRONMENT: "production"
      } as unknown as PodcastEnv
    );
    expect(production.status).toBe(404);
    expect(fixture.publication).toBeNull();
  });
});

async function createDraft(env: PodcastEnv): Promise<void> {
  const response = await handleRequest(
    adminRequest(
      "/v1/admin/clip-renders/render_fixture/youtube",
      {
        publicationId: "youtube_fixture",
        expectedClipRevision: 2,
        privacyStatus: "unlisted",
        title: "Captioned launch clip",
        description: "Controlled launch evidence",
        confirmChannelUrl: "https://youtube.com/@dustwavecollective"
      }
    ),
    env
  );
  expect(response.status).toBe(200);
}

function adminRequest(
  path: string,
  body: Record<string, unknown>
): Request {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method: "POST",
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
      "content-type": "application/json",
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": "csrf_fixture"
    },
    body: JSON.stringify(body)
  });
}

async function createFixture({
  youtubeMode = "dry_run",
  providerConfigured = false,
  recentAuthentication = true,
  queueFails = false
}: {
  youtubeMode?: string;
  providerConfigured?: boolean;
  recentAuthentication?: boolean;
  queueFails?: boolean;
} = {}) {
  let publication: Record<string, any> | null = null;
  let r2Heads = 0;
  let r2Gets = 0;
  const queuedJobs: PodcastJob[] = [];
  const auditActions: string[] = [];
  const csrfTokenHash = await sha256Hex(
    "admin_session_secret_fixture:csrf_fixture"
  );
  const render = readyRender();
  const db = {
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first() {
          if (query.includes("FROM admin_sessions s")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return recentAuthentication ? { recent: 1 } : null;
          }
          if (query.includes("FROM clip_youtube_publications p")) {
            return publication ? { ...publication, ...render } : null;
          }
          if (query.includes("FROM clip_renders r")) {
            return render;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes(
            "INSERT OR IGNORE INTO clip_youtube_publications"
          )) {
            if (publication) return { meta: { changes: 0 } };
            publication = {
              id: bindings[0],
              show_id: bindings[1],
              clip_id: bindings[2],
              clip_revision: bindings[3],
              render_id: bindings[4],
              channel_url: bindings[5],
              channel_id: null,
              privacy_status: bindings[6],
              title: bindings[7],
              description: bindings[8],
              status: "draft",
              provider_video_id: null,
              failure_code: null,
              requested_by_admin_user_id: bindings[9],
              approved_by_admin_user_id: null,
              requested_at: "2026-07-25 01:00:00",
              approved_at: null,
              started_at: null,
              completed_at: null,
              updated_at: "2026-07-25 01:00:00"
            };
            return { meta: { changes: 1 } };
          }
          if (query.includes("INSERT INTO admin_audit_events")) {
            auditActions.push(String(bindings[2]));
            return { meta: { changes: 1 } };
          }
          if (query.includes("UPDATE clip_youtube_publications")) {
            if (!publication) return { meta: { changes: 0 } };
            if (/SET\s+status = 'dry_run'/.test(query)) {
              publication.status = "dry_run";
              publication.approved_by_admin_user_id = bindings[0];
            } else if (/SET\s+status = 'uploaded'/.test(query)) {
              publication.status = "uploaded";
              publication.provider_video_id = bindings[0];
            } else if (/SET\s+status = 'uploading'/.test(query)) {
              if (publication.status !== "queued") {
                return { meta: { changes: 0 } };
              }
              publication.status = "uploading";
            } else if (/SET\s+status = 'queued'/.test(query)) {
              publication.status = "queued";
              publication.channel_id = bindings[0];
              publication.approved_by_admin_user_id = bindings[1];
            } else if (/SET\s+status = 'failed'/.test(query)) {
              publication.status = "failed";
              publication.failure_code = query.includes(
                "youtube_queue_failed"
              )
                ? "youtube_queue_failed"
                : query.includes("youtube_mode_disabled")
                  ? "youtube_mode_disabled"
                  : bindings[0];
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database;
  const bucket = {
    async head() {
      r2Heads += 1;
      return clipObjectHead();
    },
    async get(_key: string, options: R2GetOptions) {
      r2Gets += 1;
      expect(new Headers(options.onlyIf as Headers).get("if-match"))
        .toBe("\"clip-etag\"");
      return {
        ...clipObjectHead(),
        body: new Response("clip").body
      };
    }
  } as unknown as R2Bucket;
  const env = {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_KEY_PREFIX: "podcasts/",
    MEDIA_BUCKET_NAME: "dustwave-media-staging",
    ADMIN_SESSION_SECRET: "admin_session_secret_fixture",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    YOUTUBE_PUBLISH_MODE: youtubeMode,
    ...(providerConfigured
      ? {
          YOUTUBE_CLIENT_ID: "client_fixture",
          YOUTUBE_CLIENT_SECRET: "secret_fixture",
          YOUTUBE_REFRESH_TOKEN: "refresh_fixture",
          YOUTUBE_CHANNEL_ID: "channel_fixture"
        }
      : {}),
    DB: db,
    MEDIA_BUCKET: bucket,
    JOBS: {
      async send(job: PodcastJob) {
        if (queueFails) throw new Error("queue unavailable");
        queuedJobs.push(job);
      }
    }
  } as unknown as PodcastEnv;
  return {
    env,
    queuedJobs,
    auditActions,
    get publication() {
      return publication;
    },
    get r2Heads() {
      return r2Heads;
    },
    get r2Gets() {
      return r2Gets;
    }
  };
}

function readyRender(): Record<string, unknown> {
  return {
    render_id: "render_fixture",
    clip_id: "clip_fixture",
    clip_revision: 2,
    current_clip_revision: 2,
    show_id: "show_fixture",
    youtube_channel_url: "https://youtube.com/@dustwavecollective",
    render_status: "ready",
    output_object_key: "podcasts/show/episode/clips/render_fixture.mp4",
    output_object_bytes: 4,
    output_sha256: "a".repeat(64),
    output_mime_type: "video/mp4",
    processor_manifest_sha256: "b".repeat(64)
  };
}

function clipObjectHead(): R2Object {
  return {
    key: "podcasts/show/episode/clips/render_fixture.mp4",
    version: "fixture",
    size: 4,
    etag: "clip-etag",
    httpEtag: "\"clip-etag\"",
    uploaded: new Date("2026-07-25T01:00:00Z"),
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: {
      sha256: "a".repeat(64),
      "render-manifest-sha256": "b".repeat(64)
    },
    range: undefined,
    checksums: {
      toJSON() {
        return { sha256: "a".repeat(64) };
      }
    },
    writeHttpMetadata() {}
  } as unknown as R2Object;
}

function providerFetchFixture() {
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
        snippet: { channelId: "channel_fixture" },
        status: { privacyStatus: "unlisted" }
      }]
    }));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}
