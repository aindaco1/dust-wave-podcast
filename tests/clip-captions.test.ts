import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { serveAdminClipRenderCaptions } from "../src/clips";
import type { PodcastEnv } from "../src/env";

const outputSha256 = "a".repeat(64);
const recipeSha256 = "d".repeat(64);
const transcriptSha256 = "e".repeat(64);
const outputEtag = '"clip-output-etag"';
const sourceEtag = '"clip-source-etag"';

describe("private clip render WebVTT", () => {
  it("rebuilds exact evidence and downloads escaped relative captions", async () => {
    let storedManifestSha256 = "b".repeat(64);
    const env = authorizedEnv(() => storedManifestSha256);

    const mismatch = await serveAdminClipRenderCaptions(
      adminRequest(),
      env,
      "render_fixture"
    );
    expect(mismatch.status).toBe(409);
    const mismatchBody = await mismatch.json() as {
      error: string;
      rebuiltManifestSha256: string;
    };
    expect(mismatchBody.error).toBe("clip_render_manifest_mismatch");
    expect(mismatchBody.rebuiltManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    storedManifestSha256 = mismatchBody.rebuiltManifestSha256;

    const response = await serveAdminClipRenderCaptions(
      adminRequest(),
      env,
      "render_fixture"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type"))
      .toBe("text/vtt; charset=utf-8");
    expect(response.headers.get("content-language")).toBe("es");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="-pera---launch-clip-render_fixture.vtt"'
    );
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store, max-age=0");
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://dustwave.xyz");
    expect(response.headers.get("access-control-allow-credentials"))
      .toBe("true");
    expect(response.headers.get("cross-origin-resource-policy"))
      .toBe("same-site");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(await response.text()).toBe([
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:02.000",
      "<v Jay>Hola &amp; selva</v>",
      ""
    ].join("\n"));

    const subRip = await serveAdminClipRenderCaptions(
      adminRequest({ path: "captions.srt" }),
      env,
      "render_fixture",
      "srt"
    );
    expect(subRip.status).toBe(200);
    expect(subRip.headers.get("content-type"))
      .toBe("application/x-subrip; charset=utf-8");
    expect(subRip.headers.get("content-language")).toBe("es");
    expect(subRip.headers.get("content-disposition")).toBe(
      'attachment; filename="-pera---launch-clip-render_fixture.srt"'
    );
    expect(await subRip.text()).toBe([
      "1",
      "00:00:00,000 --> 00:00:02,000",
      "Jay: Hola &amp; selva",
      ""
    ].join("\n"));
    expect(subRip.headers.get("etag")).not.toBe(response.headers.get("etag"));

    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const notModified = await serveAdminClipRenderCaptions(
      adminRequest({ headers: { "if-none-match": etag as string } }),
      env,
      "render_fixture"
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-length")).toBeNull();
    expect(await notModified.text()).toBe("");

    const head = await serveAdminClipRenderCaptions(
      adminRequest({ method: "HEAD" }),
      env,
      "render_fixture"
    );
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(1);
    expect(await head.text()).toBe("");
  });

  it("fails closed before object or transcript lookup outside show scope", async () => {
    let objectReads = 0;
    const env = authorizedEnv(
      () => "b".repeat(64),
      "show_other",
      () => {
        objectReads += 1;
      }
    );
    const response = await serveAdminClipRenderCaptions(
      adminRequest({ path: "captions.srt" }),
      env,
      "render_fixture",
      "srt"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "clip_render_not_found"
    });
    expect(objectReads).toBe(0);
  });
});

function adminRequest({
  method = "GET",
  headers = {},
  path = "captions.vtt"
}: {
  method?: string;
  headers?: Record<string, string>;
  path?: "captions.vtt" | "captions.srt";
} = {}): Request {
  return new Request(
    "https://feeds.dustwave.xyz/v1/admin/clip-renders/"
      + `render_fixture/${path}`,
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
  manifestSha256: () => string,
  roleShowId = "show_fixture",
  onObjectRead: () => void = () => {}
): PodcastEnv {
  const sourceObjectKey =
    "podcasts/show_fixture/episode_fixture/delivery.mp3";
  const outputObjectKey = [
    "podcasts/show_fixture/episode_fixture/clips/clip_fixture",
    "revision-1/render_fixture.mp4"
  ].join("/");
  const recipe = {
    schemaVersion: 1,
    title: "Ópera / launch clip",
    aspectRatio: "9:16",
    templateId: "captioned-waveform-v1",
    captionLanguage: "es",
    boundaryMode: "segment",
    startsAtMs: 1_000,
    endsAtMs: 3_000,
    startCueId: "cue_fixture",
    endCueId: "cue_fixture",
    startWordId: null,
    endWordId: null,
    transcriptId: "transcript_fixture",
    transcriptRevision: 1,
    transcriptSha256,
    alignmentRevisionId: null,
    captionStyle: "high-contrast-v1",
    safeArea: {
      topPercent: 8,
      rightPercent: 8,
      bottomPercent: 18,
      leftPercent: 8
    }
  };
  const transcriptContent = {
    schemaVersion: 1,
    language: "es",
    cues: [{
      id: "cue_fixture",
      startsAtMs: 1_000,
      endsAtMs: 3_000,
      speakerLabel: "Jay",
      speakerConfirmed: true,
      textMarkdown: "**Hola** & <u>selva</u>"
    }]
  };
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
              recipe_sha256: recipeSha256,
              processor_manifest_sha256: manifestSha256(),
              output_object_key: outputObjectKey,
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
              expected_object_etag: null
            };
          }
          if (query.includes("FROM clip_revisions cr")) {
            return {
              clip_id: "clip_fixture",
              episode_id: "episode_fixture",
              show_id: "show_fixture",
              clip_revision: 1,
              recipe_json: JSON.stringify(recipe),
              recipe_sha256: recipeSha256,
              transcript_id: "transcript_fixture",
              transcript_revision: 1,
              transcript_sha256: transcriptSha256,
              alignment_revision_id: null,
              source_object_key: sourceObjectKey,
              source_object_bytes: 100,
              source_object_etag: sourceEtag,
              transcript_content_json: JSON.stringify(transcriptContent),
              transcript_status: "approved",
              current_transcript_revision: 1,
              current_transcript_sha256: transcriptSha256,
              audio_key: sourceObjectKey,
              audio_bytes: 100,
              audio_etag: sourceEtag,
              audio_mime_type: "audio/mpeg",
              media_status: "ready"
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
  const bucket = {
    async head(key: string) {
      onObjectRead();
      if (key === sourceObjectKey) {
        return {
          key,
          size: 100,
          httpEtag: sourceEtag
        } as unknown as R2Object;
      }
      expect(key).toBe(outputObjectKey);
      return {
        key,
        version: "fixture",
        size: 10,
        etag: "clip-output-etag",
        httpEtag: outputEtag,
        uploaded: new Date("2026-07-25T00:01:00Z"),
        httpMetadata: { contentType: "video/mp4" },
        customMetadata: {
          sha256: outputSha256,
          "render-manifest-sha256": manifestSha256()
        },
        checksums: {
          toJSON() {
            return { sha256: outputSha256 };
          }
        },
        writeHttpMetadata() {}
      } as unknown as R2Object;
    }
  } as unknown as R2Bucket;
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
