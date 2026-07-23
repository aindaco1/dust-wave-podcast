import { timingSafeEqual } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import { serveVirtualMedia, type VirtualMediaManifest } from "./virtual-media";

const SYNTHETIC_MIDROLL_MANIFEST: VirtualMediaManifest = {
  schemaVersion: "1",
  id: "synthetic-midroll-fixture",
  episodeId: "synthetic-episode",
  decisionId: "synthetic-direct-ad-decision",
  etag: '"fe3fd3084f9720103f1a548162f5d707321d991565a54809c29297c784c5c249"',
  contentType: "audio/mpeg",
  streamProfile: "mp3-44100-stereo-cbr128-raw-frames-v1",
  validatedAt: "2026-07-23T20:39:00.158Z",
  segments: [
    {
      id: "program-pre",
      kind: "program",
      objectKey: "fixtures/virtual-audio/program-pre.mp3",
      objectBytes: 80_666,
      sourceOffset: 0,
      byteLength: 80_666,
      contentType: "audio/mpeg",
      streamProfile: "mp3-44100-stereo-cbr128-raw-frames-v1"
    },
    {
      id: "direct-ad",
      kind: "direct_ad",
      objectKey: "fixtures/virtual-audio/direct-ad.mp3",
      objectBytes: 32_600,
      sourceOffset: 0,
      byteLength: 32_600,
      contentType: "audio/mpeg",
      streamProfile: "mp3-44100-stereo-cbr128-raw-frames-v1"
    },
    {
      id: "program-post",
      kind: "program",
      objectKey: "fixtures/virtual-audio/program-post.mp3",
      objectBytes: 80_666,
      sourceOffset: 0,
      byteLength: 80_666,
      contentType: "audio/mpeg",
      streamProfile: "mp3-44100-stereo-cbr128-raw-frames-v1"
    }
  ]
};

export async function serveStagingVirtualAudioDiagnostic(
  request: Request,
  env: PodcastEnv,
  suppliedToken: string
): Promise<Response> {
  if (
    env.ENVIRONMENT !== "staging"
    || !env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN
    || !timingSafeEqual(suppliedToken, env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN)
  ) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }
  return serveVirtualMedia(request, env.MEDIA_BUCKET, SYNTHETIC_MIDROLL_MANIFEST);
}
