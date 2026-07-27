import { timingSafeEqual } from "@dustwave/worker-core/crypto";

import syntheticFixture from "../config/virtual-audio-synthetic-fixture.json";
import type { PodcastEnv } from "./env";
import {
  compileVirtualMediaManifest,
  serveVirtualMedia,
  type VirtualMediaManifest,
  type VirtualMediaSegmentKind
} from "./virtual-media";

const {
  virtual: SYNTHETIC_MIDROLL_MANIFEST,
  baseline: SYNTHETIC_BASELINE_MANIFEST
} = syntheticFixtureManifests();

export async function serveStagingVirtualAudioDiagnostic(
  request: Request,
  env: PodcastEnv,
  suppliedToken: string,
  variant: "virtual" | "baseline" = "virtual"
): Promise<Response> {
  if (
    env.ENVIRONMENT !== "staging"
    || !env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN
    || !timingSafeEqual(suppliedToken, env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN)
  ) {
    return diagnosticNotFound();
  }
  return serveVirtualMedia(
    request,
    env.MEDIA_BUCKET,
    variant === "baseline"
      ? SYNTHETIC_BASELINE_MANIFEST
      : SYNTHETIC_MIDROLL_MANIFEST
  );
}

export function serveStagingVirtualAudioPlayer(
  env: PodcastEnv
): Response {
  if (
    env.ENVIRONMENT !== "staging"
    || !env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN
  ) {
    return diagnosticNotFound();
  }
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
        "/v1/diagnostics/virtual-audio/" + encodeURIComponent(supplied)
        + "/virtual";
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

function syntheticFixtureManifests(): {
  virtual: VirtualMediaManifest;
  baseline: VirtualMediaManifest;
} {
  if (
    syntheticFixture.schemaVersion !== "dust-wave-virtual-audio-fixture-v1"
    || syntheticFixture.contentType !== "audio/mpeg"
  ) {
    throw new Error("Unsupported virtual-audio synthetic fixture contract.");
  }
  const shared = {
    schemaVersion: "1" as const,
    episodeId: syntheticFixture.manifest.episodeId,
    decisionId: syntheticFixture.manifest.decisionId,
    etag: `"${syntheticFixture.assemblies.virtual.sha256}"`,
    contentType: "audio/mpeg" as const,
    streamProfile: syntheticFixture.profile,
    validatedAt: syntheticFixture.validatedAt
  };
  const virtual: VirtualMediaManifest = {
    ...shared,
    id: syntheticFixture.manifest.id,
    segments: syntheticFixture.sources.map((source) => ({
      id: source.id,
      kind: syntheticSegmentKind(source.kind),
      objectKey: source.objectKey,
      objectBytes: source.bytes,
      sourceOffset: 0,
      byteLength: source.bytes,
      contentType: "audio/mpeg",
      streamProfile: syntheticFixture.profile
    }))
  };
  const baseline: VirtualMediaManifest = {
    ...shared,
    id: syntheticFixture.manifest.baselineId,
    segments: [{
      id: "preassembled-full-file",
      kind: "program",
      objectKey: syntheticFixture.assemblies.virtual.objectKey,
      objectBytes: syntheticFixture.assemblies.virtual.bytes,
      sourceOffset: 0,
      byteLength: syntheticFixture.assemblies.virtual.bytes,
      contentType: "audio/mpeg",
      streamProfile: syntheticFixture.profile
    }]
  };
  compileVirtualMediaManifest(virtual);
  compileVirtualMediaManifest(baseline);
  return { virtual, baseline };
}

function syntheticSegmentKind(value: string): VirtualMediaSegmentKind {
  if (value === "program" || value === "direct_ad") return value;
  throw new Error("Unsupported synthetic virtual-audio segment kind.");
}
