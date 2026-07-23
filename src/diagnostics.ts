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
    return diagnosticNotFound();
  }
  return serveVirtualMedia(request, env.MEDIA_BUCKET, SYNTHETIC_MIDROLL_MANIFEST);
}

export function serveStagingVirtualAudioPlayer(
  env: PodcastEnv
): Response {
  if (env.ENVIRONMENT !== "staging") return diagnosticNotFound();
  const nonce = "dust-wave-virtual-audio-diagnostic";
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Dust Wave virtual-audio diagnostic</title>
</head>
<body>
  <main>
    <h1>Virtual-audio diagnostic</h1>
    <p>Synthetic tones only. The staging token is kept in this page's memory.</p>
    <form id="fixture-form">
      <label for="fixture-token">Staging token</label>
      <input id="fixture-token" type="password" required autocomplete="off">
      <button type="submit">Load and play fixture</button>
    </form>
    <audio id="fixture-audio" controls preload="metadata"></audio>
    <button id="seek" type="button" disabled>Seek to 7 seconds</button>
    <button id="pause" type="button" disabled>Pause</button>
    <output id="status" aria-live="polite">Waiting for a token.</output>
  </main>
  <script nonce="${nonce}">
    const form = document.querySelector("#fixture-form");
    const token = document.querySelector("#fixture-token");
    const audio = document.querySelector("#fixture-audio");
    const seek = document.querySelector("#seek");
    const pause = document.querySelector("#pause");
    const status = document.querySelector("#status");
    const report = (event) => {
      const duration = Number.isFinite(audio.duration)
        ? audio.duration.toFixed(3)
        : "unknown";
      status.textContent =
        event + " | duration=" + duration
        + " | current=" + audio.currentTime.toFixed(3)
        + " | ready=" + audio.readyState
        + " | network=" + audio.networkState;
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const supplied = token.value;
      token.value = "";
      audio.src =
        "/v1/diagnostics/virtual-audio/" + encodeURIComponent(supplied);
      audio.load();
      report("loading");
      try {
        await audio.play();
        report("playing");
      } catch {
        report("play-blocked");
      }
    });
    audio.addEventListener("loadedmetadata", () => {
      seek.disabled = false;
      pause.disabled = false;
      report("loadedmetadata");
    });
    audio.addEventListener("canplay", () => report("canplay"));
    audio.addEventListener("playing", () => report("playing"));
    audio.addEventListener("seeked", () => report("seeked"));
    audio.addEventListener("error", () => report("error"));
    seek.addEventListener("click", () => {
      audio.currentTime = 7;
      void audio.play();
      report("seeking");
    });
    pause.addEventListener("click", () => {
      audio.pause();
      report("paused");
    });
  </script>
</body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; media-src 'self'; script-src 'nonce-${nonce}'; `
        + "style-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

function diagnosticNotFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
