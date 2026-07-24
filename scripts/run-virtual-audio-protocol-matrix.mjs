#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const options = parseOptions(process.argv.slice(2));
const token = process.env.VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN;
if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
  fail(
    "VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN must be supplied through the environment."
  );
}
if (!options.origin || !options.output) {
  fail(
    "Usage: run-virtual-audio-protocol-matrix.mjs "
    + "--origin https://worker.example --output /absolute/evidence.json"
  );
}
const origin = new URL(options.origin);
if (origin.protocol !== "https:" || origin.pathname !== "/") {
  fail("--origin must be an HTTPS origin without a path.");
}
const outputPath = path.resolve(options.output);
const diagnosticUrl = new URL(
  `/v1/diagnostics/virtual-audio/${encodeURIComponent(token)}`,
  origin
);
const results = [];

const head = await probe("head", { method: "HEAD" });
assertStatus(head, 200);
const totalBytes = positiveHeaderInteger(head.headers, "content-length");
const etag = requiredHeader(head.headers, "etag");
assertHeader(head.headers, "accept-ranges", "bytes");

const full = await probe("full-get");
assertStatus(full, 200);
assertBodyLength(full, totalBytes);
assertHeader(full.headers, "etag", etag);

const first = await rangedProbe("bounded-first-byte", "bytes=0-0", 0, 0);
const middleStart = Math.floor(totalBytes / 2);
await rangedProbe(
  "open-ended-resume",
  `bytes=${middleStart}-`,
  middleStart,
  totalBytes - 1
);
const suffixLength = Math.min(8_192, totalBytes);
await rangedProbe(
  "suffix-resume",
  `bytes=-${suffixLength}`,
  totalBytes - suffixLength,
  totalBytes - 1
);

const retry = await rangedProbe(
  "bounded-retry",
  "bytes=0-0",
  0,
  0
);
assert(
  retry.sha256 === first.sha256,
  "bounded retry returned different bytes"
);

const notModified = await probe("if-none-match", {
  headers: { "if-none-match": etag }
});
assertStatus(notModified, 304);
assertBodyLength(notModified, 0);

const ifRange = await rangedProbe(
  "matching-if-range",
  "bytes=0-0",
  0,
  0,
  { "if-range": etag }
);
assert(ifRange.sha256 === first.sha256, "matching If-Range changed bytes");

const staleIfRange = await probe("stale-if-range", {
  headers: {
    range: "bytes=0-0",
    "if-range": '"stale-diagnostic-etag"'
  }
});
assertStatus(staleIfRange, 200);
assertBodyLength(staleIfRange, totalBytes);

const unsatisfiable = await probe("unsatisfiable-range", {
  headers: { range: `bytes=${totalBytes}-` }
});
assertStatus(unsatisfiable, 416);
assertHeader(
  unsatisfiable.headers,
  "content-range",
  `bytes */${totalBytes}`
);

const multipart = await probe("multipart-range-rejected", {
  headers: { range: "bytes=0-0,2-2" }
});
assertStatus(multipart, 416);

const clientProfiles = [
  {
    name: "apple-podcasts-emulation",
    userAgent: "Podcasts/1700.1 CFNetwork iPhone OS/19.0"
  },
  {
    name: "spotify-emulation",
    userAgent: "Spotify/9.0 (Linux; Android 16; Mobile)"
  },
  {
    name: "overcast-emulation",
    userAgent: "Overcast/2026.7 CFNetwork iPhone OS/19.0"
  },
  {
    name: "pocket-casts-emulation",
    userAgent: "Pocket Casts/7.80 (Linux; Android 16; Mobile)"
  },
  {
    name: "podcast-addict-emulation",
    userAgent: "PodcastAddict/2026.7 (Linux; Android 16; Mobile)"
  }
];
for (const profile of clientProfiles) {
  await rangedProbe(
    profile.name,
    "bytes=0-4095",
    0,
    Math.min(4_095, totalBytes - 1),
    { "user-agent": profile.userAgent },
    profile.name
  );
}

const concurrent = await Promise.all(
  Array.from({ length: 8 }, (_, index) =>
    rangedProbe(
      `concurrent-range-${index + 1}`,
      "bytes=0-4095",
      0,
      Math.min(4_095, totalBytes - 1)
    )
  )
);
assert(
  new Set(concurrent.map(({ sha256 }) => sha256)).size === 1,
  "concurrent requests returned different bytes"
);
assert(
  concurrent.every(({ etag: value }) => value === etag),
  "concurrent requests returned different ETags"
);

const durations = results.map(({ durationMs }) => durationMs).sort(
  (left, right) => left - right
);
const evidence = {
  schemaVersion: "dust-wave-virtual-audio-protocol-matrix-v1",
  generatedAt: new Date().toISOString(),
  targetOrigin: origin.origin,
  targetPath: "/v1/diagnostics/virtual-audio/[redacted]",
  fixture: {
    bytes: totalBytes,
    etag,
    sha256: full.sha256
  },
  scope: {
    syntheticProtocolEmulation: true,
    nativeClientValidation: false,
    note:
      "User-Agent probes validate HTTP invariants only; they do not count "
      + "as real native-app playback evidence."
  },
  summary: {
    passed: true,
    probes: results.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    maximumDurationMs: durations.at(-1)
  },
  probes: results
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600
});
process.stdout.write(
  `Protocol matrix passed: ${results.length} probes; evidence=${outputPath}\n`
);

async function rangedProbe(
  name,
  range,
  startsAt,
  endsAt,
  extraHeaders = {},
  clientProfile = null
) {
  const result = await probe(name, {
    headers: { ...extraHeaders, range }
  }, clientProfile);
  assertStatus(result, 206);
  assertHeader(
    result.headers,
    "content-range",
    `bytes ${startsAt}-${endsAt}/${totalBytes}`
  );
  assertBodyLength(result, endsAt - startsAt + 1);
  assertHeader(result.headers, "etag", etag);
  return result;
}

async function probe(name, init = {}, clientProfile = null) {
  const startedAt = performance.now();
  const response = await fetch(diagnosticUrl, {
    redirect: "error",
    ...init
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const result = {
    name,
    ...(clientProfile ? { clientProfile } : {}),
    status: response.status,
    durationMs: round(performance.now() - startedAt),
    bytes: body.byteLength,
    etag: response.headers.get("etag"),
    contentRange: response.headers.get("content-range"),
    cacheControl: response.headers.get("cache-control"),
    sha256: createHash("sha256").update(body).digest("hex")
  };
  results.push(result);
  return {
    ...result,
    headers: response.headers
  };
}

function assertStatus(result, expected) {
  assert(
    result.status === expected,
    `${result.name} returned ${result.status}, expected ${expected}`
  );
}

function assertBodyLength(result, expected) {
  assert(
    result.bytes === expected,
    `${result.name} returned ${result.bytes} bytes, expected ${expected}`
  );
}

function assertHeader(headers, name, expected) {
  const actual = headers.get(name);
  assert(actual === expected, `${name} was ${actual}, expected ${expected}`);
}

function requiredHeader(headers, name) {
  const value = headers.get(name);
  assert(Boolean(value), `${name} header is required`);
  return value;
}

function positiveHeaderInteger(headers, name) {
  const value = Number(requiredHeader(headers, name));
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be positive`);
  return value;
}

function percentile(values, ratio) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`Protocol matrix failed: ${message}\n`);
  process.exit(1);
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) fail("Invalid command arguments.");
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}
