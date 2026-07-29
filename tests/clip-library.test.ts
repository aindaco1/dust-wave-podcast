import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("show clip library", () => {
  it("returns one bounded, filtered page with current ready media paths", async () => {
    const observed = {
      clipQuery: "",
      clipBindings: [] as unknown[]
    };
    const response = await handleRequest(
      adminRequest(
        "?limit=1&episodeId=episode_fixture"
        + "&aspectRatio=9%3A16&renderStatus=ready"
      ),
      authorizedEnv(observed)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store, max-age=0");
    const payload = await response.json() as {
      clips: Array<Record<string, any>>;
      pagination: { limit: number; nextCursor: string | null };
      filters: Record<string, unknown>;
    };
    expect(payload.clips).toHaveLength(1);
    expect(payload.clips[0].episodeTitle).toBe("Episode one");
    expect(payload.clips[0].render.mediaPath).toBe(
      "/v1/admin/clip-renders/render_2/media"
    );
    expect(payload.clips[0].render.downloadPath).toBe(
      "/v1/admin/clip-renders/render_2/media?download=1"
    );
    expect(payload.clips[0].render.captionsPath).toBe(
      "/v1/admin/clip-renders/render_2/captions.vtt"
    );
    expect(payload.clips[0].publicPublication).toMatchObject({
      id: "publication_clip_2",
      renderId: "render_2",
      publicSlug: "ready-clip",
      status: "approved",
      evidenceCurrent: true
    });
    expect(payload.pagination).toEqual({
      limit: 1,
      nextCursor: "clip_2"
    });
    expect(payload.filters).toEqual({
      episodeId: "episode_fixture",
      aspectRatio: "9:16",
      renderStatus: "ready"
    });
    expect(observed.clipQuery).toContain("e.show_id = ?");
    expect(observed.clipQuery).toContain("r.clip_revision = c.revision");
    expect(observed.clipQuery).toContain(
      "ORDER BY c.updated_at DESC, c.id DESC"
    );
    expect(observed.clipBindings).toEqual([
      "show_fixture",
      "episode_fixture",
      "9:16",
      "ready",
      2
    ]);
  });

  it("rejects an out-of-scope show before querying clips", async () => {
    const observed = {
      clipQuery: "",
      clipBindings: [] as unknown[]
    };
    const response = await handleRequest(
      adminRequest(),
      authorizedEnv(observed, "show_other")
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(observed.clipQuery).toBe("");
  });

  it("requires an admin session before querying the library", async () => {
    const observed = {
      clipQuery: "",
      clipBindings: [] as unknown[]
    };
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/show_fixture/clips"
      ),
      authorizedEnv(observed)
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(observed.clipQuery).toBe("");
  });

  it("rejects unbounded page sizes before any data query", async () => {
    const observed = {
      clipQuery: "",
      clipBindings: [] as unknown[]
    };
    const response = await handleRequest(
      adminRequest("?limit=101"),
      authorizedEnv(observed)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request"
    });
    expect(observed.clipQuery).toBe("");
  });

  it("uses an own-property aspect-ratio allowlist", async () => {
    const observed = {
      clipQuery: "",
      clipBindings: [] as unknown[]
    };
    const response = await handleRequest(
      adminRequest("?aspectRatio=toString"),
      authorizedEnv(observed)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request"
    });
    expect(observed.clipQuery).toBe("");
  });
});

function adminRequest(search = ""): Request {
  return new Request(
    `https://feeds.dustwave.xyz/v1/admin/shows/show_fixture/clips${search}`,
    {
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
        origin: "https://dustwave.xyz"
      }
    }
  );
}

function authorizedEnv(
  observed: { clipQuery: string; clipBindings: unknown[] },
  roleShowId = "show_fixture"
): PodcastEnv {
  const db = {
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
              csrf_token_hash: "unused"
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{
                role: "producer",
                show_id: roleShowId
              }]
            };
          }
          if (query.includes("FROM clips c")) {
            observed.clipQuery = query;
            observed.clipBindings = bindings;
            return {
              results: [
                clipRow("clip_2", "render_2", "2026-07-25 01:00:00"),
                clipRow("clip_1", "render_1", "2026-07-25 00:00:00")
              ]
            };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database;
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_KEY_PREFIX: "podcasts/",
    MEDIA_BUCKET_NAME: "dustwave-media-staging",
    ADMIN_SESSION_SECRET: "admin_session_secret_fixture",
    DB: db
  } as unknown as PodcastEnv;
}

function clipRow(
  id: string,
  renderId: string,
  updatedAt: string
): Record<string, unknown> {
  return {
    id,
    episode_id: "episode_fixture",
    episode_title: "Episode one",
    episode_slug: "episode-one",
    show_id: "show_fixture",
    title: `Ready clip ${id}`,
    starts_at_ms: 1_000,
    ends_at_ms: 6_000,
    aspect_ratio: "9:16",
    status: "draft",
    output_key: null,
    revision: 2,
    transcript_id: "transcript_fixture",
    transcript_revision: 3,
    transcript_sha256: "a".repeat(64),
    alignment_revision_id: null,
    boundary_mode: "segment",
    caption_language: "es",
    template_id: "captioned-waveform-v1",
    recipe_json: "{}",
    recipe_sha256: null,
    source_object_key: "podcasts/show/episode/audio.mp3",
    source_object_bytes: 100,
    source_object_etag: "\"audio-etag\"",
    created_at: "2026-07-24 00:00:00",
    updated_at: updatedAt,
    render_id: renderId,
    render_clip_revision: 2,
    render_status: "ready",
    render_output_bytes: 10_000,
    render_output_sha256: "b".repeat(64),
    render_output_mime_type: "video/mp4",
    render_output_width: 1080,
    render_output_height: 1920,
    render_output_duration_ms: 5_000,
    render_processor_manifest_sha256: "c".repeat(64),
    render_processor_version: "captioned-waveform-v1",
    render_failure_code: null,
    render_requested_at: "2026-07-25 00:00:00",
    render_completed_at: "2026-07-25 00:01:00",
    public_publication_id: `publication_${id}`,
    public_publication_slug: "ready-clip",
    public_publication_title: "Ready clip",
    public_publication_description: "A captioned excerpt",
    public_publication_status: "approved",
    public_publication_clip_revision: 2,
    public_publication_output_bytes: 10_000,
    public_publication_output_sha256: "b".repeat(64),
    public_publication_manifest_sha256: "c".repeat(64),
    public_publication_requested_at: "2026-07-25 00:00:00",
    public_publication_approved_at: "2026-07-25 00:02:00",
    public_publication_withdrawn_at: null
  };
}
