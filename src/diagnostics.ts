import {
  hmacSha256,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import syntheticFixture from "../config/virtual-audio-synthetic-fixture.json";
import type { PodcastEnv } from "./env";
import {
  compileVirtualMediaManifest,
  serveVirtualMedia,
  type VirtualMediaManifest,
  type VirtualMediaSegmentKind
} from "./virtual-media";
import {
  readBoundedBytes,
  readJsonObject,
  RequestValidationError
} from "./validation";

const DIAGNOSTIC_CAPABILITY_MAXIMUM_SECONDS = 15 * 60;
const {
  virtual: SYNTHETIC_MIDROLL_MANIFEST,
  baseline: SYNTHETIC_BASELINE_MANIFEST
} = syntheticFixtureManifests();
const SYNTHETIC_FIXTURE_OBJECTS = new Map([
  ...syntheticFixture.sources.map((source) => [
    source.filename,
    {
      filename: source.filename,
      objectKey: source.objectKey,
      bytes: source.bytes,
      sha256: source.sha256
    }
  ] as const),
  [
    syntheticFixture.assemblies.virtual.filename,
    {
      filename: syntheticFixture.assemblies.virtual.filename,
      objectKey: syntheticFixture.assemblies.virtual.objectKey,
      bytes: syntheticFixture.assemblies.virtual.bytes,
      sha256: syntheticFixture.assemblies.virtual.sha256
    }
  ] as const
]);

export async function serveStagingVirtualAudioDiagnostic(
  request: Request,
  env: PodcastEnv,
  suppliedToken: string,
  variant: "virtual" | "baseline" = "virtual"
): Promise<Response> {
  if (!await verifyStagingDiagnosticCapability(env, suppliedToken)) {
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

export async function issueStagingVirtualAudioCapability(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!stagingDiagnosticConfigured(env)) return diagnosticNotFound();
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, 1_000);
  } catch {
    return diagnosticJson({ error: "invalid_diagnostic_lease" }, 400);
  }
  const leaseId = String(body.leaseId ?? "").trim();
  const leaseToken = String(body.token ?? "").trim();
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(leaseId)
    || !/^[A-Za-z0-9_-]{32,128}$/.test(leaseToken)
  ) {
    return diagnosticJson({ error: "invalid_diagnostic_lease" }, 400);
  }
  const tokenHash = await sha256Hex([
    "dust-wave-virtual-audio-lease-v1",
    leaseId,
    leaseToken
  ].join("\n"));
  const lease = await env.DB.prepare(
    `UPDATE virtual_audio_diagnostic_leases
     SET exchanged_at = datetime('now')
     WHERE
       id = ?
       AND token_hash = ?
       AND exchanged_at IS NULL
       AND expires_at > datetime('now')
     RETURNING expires_at`
  ).bind(leaseId, tokenHash).first<{ expires_at: string }>();
  if (!lease) return diagnosticNotFound();
  const expires = parseDiagnosticExpiry(lease.expires_at);
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(expires)
    || expires <= now
    || expires > now + DIAGNOSTIC_CAPABILITY_MAXIMUM_SECONDS
  ) {
    return diagnosticNotFound();
  }
  const signature = await signDiagnosticCapability(
    leaseId,
    expires,
    env.AD_DECISION_SIGNING_SECRET as string
  );
  return diagnosticJson({
    capability: `${leaseId}.${expires}.${signature}`,
    expiresAt: new Date(expires * 1_000).toISOString()
  }, 201);
}

export async function manageStagingVirtualAudioFixtureObject(
  request: Request,
  env: PodcastEnv,
  suppliedToken: string,
  filename: string
): Promise<Response> {
  const capability = await verifyStagingDiagnosticCapability(
    env,
    suppliedToken
  );
  if (
    !capability
    || !await stagingDiagnosticLeaseActive(env.DB, capability.leaseId)
  ) {
    return diagnosticNotFound();
  }
  const fixture = SYNTHETIC_FIXTURE_OBJECTS.get(filename);
  if (!fixture) return diagnosticNotFound();

  if (request.method === "DELETE") {
    await env.MEDIA_BUCKET.delete(fixture.objectKey);
    return new Response(null, {
      status: 204,
      headers: diagnosticHeaders()
    });
  }

  if (request.method === "PUT") {
    const declaredLength = Number(request.headers.get("content-length"));
    const contentType = request.headers.get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength !== fixture.bytes
      || contentType !== syntheticFixture.contentType
    ) {
      return diagnosticJson({ error: "invalid_fixture_upload" }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBytes(
        request,
        fixture.bytes,
        "Synthetic fixture"
      );
    } catch (error) {
      return diagnosticJson(
        { error: "invalid_fixture_upload" },
        error instanceof RequestValidationError ? error.status : 400
      );
    }
    if (
      bytes.byteLength !== fixture.bytes
      || await sha256Bytes(bytes) !== fixture.sha256
    ) {
      return diagnosticJson({ error: "fixture_contract_mismatch" }, 400);
    }
    const stored = await env.MEDIA_BUCKET.put(fixture.objectKey, bytes, {
      httpMetadata: {
        contentType: syntheticFixture.contentType,
        cacheControl: "private, no-store"
      }
    });
    if (stored.size !== fixture.bytes) {
      return diagnosticJson({ error: "fixture_storage_failed" }, 503);
    }
    return diagnosticJson({
      filename: fixture.filename,
      bytes: stored.size,
      sha256: fixture.sha256,
      matches: true
    }, 201);
  }

  const object = await env.MEDIA_BUCKET.get(fixture.objectKey);
  if (!object) return diagnosticNotFound();
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: diagnosticHeaders({
        "content-length": String(object.size)
      })
    });
  }
  if (object.size > fixture.bytes) {
    return diagnosticJson({
      filename: fixture.filename,
      bytes: object.size,
      sha256: null,
      matches: false
    });
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = await sha256Bytes(bytes);
  return diagnosticJson({
    filename: fixture.filename,
    bytes: bytes.byteLength,
    sha256: digest,
    matches:
      bytes.byteLength === fixture.bytes
      && digest === fixture.sha256
  });
}

export function serveStagingVirtualAudioPlayer(
  env: PodcastEnv
): Response {
  if (!stagingDiagnosticConfigured(env)) {
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
    <p>Synthetic tones only. The staging capability stays in page memory.</p>
    <form id="fixture-form">
      <label for="fixture-token">Staging capability</label>
      <input id="fixture-token" type="password" required autocomplete="off">
      <button type="submit">Load and play fixture</button>
    </form>
    <audio id="fixture-audio" controls preload="metadata"></audio>
    <button id="seek" type="button" disabled>Seek to 7 seconds</button>
    <button id="pause" type="button" disabled>Pause</button>
    <output id="status" aria-live="polite">Waiting for a capability.</output>
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
  return diagnosticJson({ error: "not_found" }, 404);
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

async function verifyStagingDiagnosticCapability(
  env: PodcastEnv,
  suppliedToken: string
): Promise<{ leaseId: string; expires: number } | null> {
  if (!stagingDiagnosticConfigured(env)) return null;
  const match = suppliedToken.match(
    /^([A-Za-z0-9_-]{16,64})\.([0-9]{10})\.([a-f0-9]{64})$/
  );
  if (!match) return null;
  const expires = Number(match[2]);
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(expires)
    || expires <= now
    || expires > now + DIAGNOSTIC_CAPABILITY_MAXIMUM_SECONDS
  ) {
    return null;
  }
  const expected = await signDiagnosticCapability(
    match[1],
    expires,
    env.AD_DECISION_SIGNING_SECRET as string
  );
  return timingSafeEqual(match[3], expected)
    ? { leaseId: match[1], expires }
    : null;
}

function stagingDiagnosticConfigured(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && env.AD_DECISION_MODE === "staging_validate"
    && Boolean(env.AD_DECISION_SIGNING_SECRET);
}

function signDiagnosticCapability(
  leaseId: string,
  expires: number,
  secret: string
): Promise<string> {
  return hmacSha256(
    [
      "dust-wave-virtual-audio-capability-v1",
      leaseId,
      String(expires)
    ].join("\n"),
    secret,
    "hex"
  );
}

function parseDiagnosticExpiry(value: string): number {
  const normalized = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  return Math.floor(Date.parse(normalized) / 1_000);
}

async function stagingDiagnosticLeaseActive(
  db: D1Database,
  leaseId: string
): Promise<boolean> {
  const lease = await db.prepare(
    `SELECT id
     FROM virtual_audio_diagnostic_leases
     WHERE
       id = ?
       AND exchanged_at IS NOT NULL
       AND expires_at > datetime('now')`
  ).bind(leaseId).first<{ id: string }>();
  return Boolean(lease);
}

export async function cleanupVirtualAudioDiagnosticLeases(
  db: D1Database
): Promise<void> {
  await db.prepare(
    `DELETE FROM virtual_audio_diagnostic_leases
     WHERE
       expires_at <= datetime('now')
       OR exchanged_at < datetime('now', '-1 day')`
  ).run();
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function diagnosticJson(
  payload: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: diagnosticHeaders({
      "content-type": "application/json; charset=utf-8"
    })
  });
}

function diagnosticHeaders(
  additions: Record<string, string> = {}
): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    ...additions
  });
}
