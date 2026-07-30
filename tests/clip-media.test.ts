import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { serveAdminClipRenderMedia } from "../src/clips";
import type { PodcastEnv } from "../src/env";

const outputSha256 = "a".repeat(64);
const manifestSha256 = "b".repeat(64);
const objectEtag = '"clip-etag"';

describe("private clip render media", () => {
  it("authorizes by show and streams one conditional byte range", async () => {
    let r2Reads = 0;
    const bucket = {
      async head(key: string) {
        r2Reads += 1;
        expect(key).toBe("podcasts/show/episode/clips/render_fixture.mp4");
        return clipObjectHead();
      },
      async get(_key: string, options: R2GetOptions) {
        r2Reads += 1;
        expect(options.range).toEqual({ offset: 2, length: 4 });
        expect(new Headers(options.onlyIf as Headers).get("if-match"))
          .toBe(objectEtag);
        return {
          ...clipObjectHead(),
          body: new Response("2345").body,
          range: { offset: 2, length: 4 }
        };
      }
    } as unknown as R2Bucket;
    const response = await serveAdminClipRenderMedia(
      adminRequest({ headers: { range: "bytes=2-5" } }),
      authorizedEnv(bucket),
      "render_fixture"
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store, max-age=0");
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://dustwave.xyz");
    expect(response.headers.get("access-control-allow-credentials"))
      .toBe("true");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(await response.text()).toBe("2345");
    expect(r2Reads).toBe(2);
  });

  it("serves HEAD and attachment metadata without reading the body", async () => {
    let bodyReads = 0;
    const bucket = {
      async head() {
        return clipObjectHead();
      },
      async get() {
        bodyReads += 1;
        return null;
      }
    } as unknown as R2Bucket;
    const head = await serveAdminClipRenderMedia(
      adminRequest({ method: "HEAD" }),
      authorizedEnv(bucket),
      "render_fixture"
    );

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("etag")).toBe(objectEtag);
    expect(await head.text()).toBe("");
    expect(bodyReads).toBe(0);

    const downloadableBucket = {
      async head() {
        return clipObjectHead();
      },
      async get() {
        return {
          ...clipObjectHead(),
          body: new Response("0123456789").body
        };
      }
    } as unknown as R2Bucket;
    const download = await serveAdminClipRenderMedia(
      adminRequest({ urlSuffix: "?download=1" }),
      authorizedEnv(downloadableBucket, {
        clip_title: "Ópera / launch clip"
      }),
      "render_fixture"
    );

    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="-pera---launch-clip-render_fixture.mp4"'
    );
  });

  it("fails closed before R2 for an out-of-scope show", async () => {
    let r2Reads = 0;
    const bucket = {
      async head() {
        r2Reads += 1;
        return clipObjectHead();
      }
    } as unknown as R2Bucket;
    const response = await serveAdminClipRenderMedia(
      adminRequest(),
      authorizedEnv(bucket, {}, "show_other"),
      "render_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "clip_render_not_found"
    });
    expect(r2Reads).toBe(0);
  });

  it("rejects stale object evidence and malformed ranges", async () => {
    const staleBucket = {
      async head() {
        return {
          ...clipObjectHead(),
          customMetadata: {
            sha256: "c".repeat(64),
            "render-manifest-sha256": manifestSha256
          }
        };
      }
    } as unknown as R2Bucket;
    const stale = await serveAdminClipRenderMedia(
      adminRequest(),
      authorizedEnv(staleBucket),
      "render_fixture"
    );

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "clip_render_object_mismatch"
    });

    let bodyReads = 0;
    const validBucket = {
      async head() {
        return clipObjectHead();
      },
      async get() {
        bodyReads += 1;
        return null;
      }
    } as unknown as R2Bucket;
    const invalidRange = await serveAdminClipRenderMedia(
      adminRequest({ headers: { range: "bytes=0-1,4-5" } }),
      authorizedEnv(validBucket),
      "render_fixture"
    );

    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("content-range")).toBe("bytes */10");
    expect(bodyReads).toBe(0);
  });

  it("ignores Range when If-Range no longer matches", async () => {
    const bucket = {
      async head() {
        return clipObjectHead();
      },
      async get(_key: string, options: R2GetOptions) {
        expect(options.range).toBeUndefined();
        return {
          ...clipObjectHead(),
          body: new Response("0123456789").body
        };
      }
    } as unknown as R2Bucket;
    const response = await serveAdminClipRenderMedia(
      adminRequest({
        headers: {
          range: "bytes=2-5",
          "if-range": '"older-etag"'
        }
      }),
      authorizedEnv(bucket),
      "render_fixture"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe("0123456789");
  });
});

function adminRequest({
  method = "GET",
  headers = {},
  urlSuffix = ""
}: {
  method?: string;
  headers?: Record<string, string>;
  urlSuffix?: string;
} = {}): Request {
  return new Request(
    `https://feeds.dustwave.xyz/v1/admin/clip-renders/render_fixture/media${urlSuffix}`,
    {
      method,
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
        origin: "https://dustwave.xyz",
        ...headers
      }
    }
  );
}

function authorizedEnv(
  bucket: R2Bucket,
  renderOverrides: Record<string, unknown> = {},
  roleShowId = "show_fixture"
): PodcastEnv {
  const db = {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("FROM admin_sessions s")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: "unused"
            };
          }
          if (query.includes("FROM clip_renders r")) {
            return {
              id: "render_fixture",
              clip_id: "clip_fixture",
              clip_revision: 1,
              recipe_sha256: "d".repeat(64),
              processor_manifest_sha256: manifestSha256,
              output_object_key:
                "podcasts/show/episode/clips/render_fixture.mp4",
              status: "ready",
              output_object_bytes: 10,
              output_sha256: outputSha256,
              output_mime_type: "video/mp4",
              output_width: 1080,
              output_height: 1920,
              output_duration_ms: 2_000,
              processor_version: "captioned-waveform-v1",
              failure_code: null,
              requested_at: "2026-07-25 00:00:00",
              completed_at: "2026-07-25 00:01:00",
              show_id: "show_fixture",
              clip_title: "Ópera / launch clip",
              ...renderOverrides
            };
          }
          return null;
        },
        async all() {
          return {
            results: [{
              role: "producer",
              show_id: roleShowId
            }]
          };
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
    DB: db,
    MEDIA_BUCKET: bucket
  } as unknown as PodcastEnv;
}

function clipObjectHead(): R2Object {
  return {
    key: "podcasts/show/episode/clips/render_fixture.mp4",
    version: "fixture",
    size: 10,
    etag: "clip-etag",
    httpEtag: objectEtag,
    uploaded: new Date("2026-07-25T00:01:00Z"),
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: {
      sha256: outputSha256,
      "render-manifest-sha256": manifestSha256
    },
    range: undefined,
    checksums: {
      toJSON() {
        return { sha256: outputSha256 };
      }
    },
    writeHttpMetadata() {}
  } as unknown as R2Object;
}
