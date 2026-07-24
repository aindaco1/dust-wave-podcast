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
    "Usage: run-virtual-audio-load-gate.mjs "
    + "--origin https://worker.example --output /absolute/evidence.json "
    + "[--pairs 5000] [--concurrency 12]"
  );
}
const origin = new URL(options.origin);
if (origin.protocol !== "https:" || origin.pathname !== "/") {
  fail("--origin must be an HTTPS origin without a path.");
}
const pairCount = boundedInteger(options.pairs ?? "5000", "pairs", 1, 10_000);
const concurrency = boundedInteger(
  options.concurrency ?? "12",
  "concurrency",
  1,
  50
);
const outputPath = path.resolve(options.output);
const fixtureRoot = `/v1/diagnostics/virtual-audio/${encodeURIComponent(token)}`;
const urls = {
  virtual: new URL(`${fixtureRoot}/virtual`, origin),
  baseline: new URL(`${fixtureRoot}/baseline`, origin)
};
const TOTAL_BYTES = 193_932;
const MAX_RECORDED_ERRORS = 20;
const WARMUP_PAIRS = Math.min(20, pairCount);
const metrics = {
  virtual: [],
  baseline: []
};
const patterns = new Map();
const errors = [];
let failedRequests = 0;
let contentMismatches = 0;
let completedRequests = 0;

await verifyHeads();
for (let index = 0; index < WARMUP_PAIRS; index += 1) {
  await executePair(index, false);
}

let nextPair = 0;
await Promise.all(
  Array.from(
    { length: Math.min(concurrency, pairCount) },
    async () => {
      while (true) {
        const index = nextPair;
        nextPair += 1;
        if (index >= pairCount) return;
        await executePair(index, true);
      }
    }
  )
);

const virtualDurations = sorted(metrics.virtual);
const baselineDurations = sorted(metrics.baseline);
const virtualP95 = percentile(virtualDurations, 0.95);
const baselineP95 = percentile(baselineDurations, 0.95);
const p95AddedMs = round(virtualP95 - baselineP95);
const requestCount = pairCount * 2;
const errorRate = failedRequests / requestCount;
const thresholds = {
  maximumErrorRate: 0.001,
  maximumP95AddedMs: 250,
  maximumContentMismatches: 0
};
const passed =
  completedRequests === requestCount
  && errorRate < thresholds.maximumErrorRate
  && p95AddedMs <= thresholds.maximumP95AddedMs
  && contentMismatches === thresholds.maximumContentMismatches;
const evidence = {
  schemaVersion: "dust-wave-virtual-audio-paired-load-gate-v1",
  generatedAt: new Date().toISOString(),
  targetOrigin: origin.origin,
  targetPaths: {
    virtual: "/v1/diagnostics/virtual-audio/[redacted]/virtual",
    baseline: "/v1/diagnostics/virtual-audio/[redacted]/baseline"
  },
  scope: {
    fixtureBytes: TOTAL_BYTES,
    pairedRequests: pairCount,
    totalMeasuredRequests: requestCount,
    concurrency,
    warmupPairsExcluded: WARMUP_PAIRS,
    nativeClientValidation: false,
    note:
      "Paired edge-to-Worker timings include public-network variance. "
      + "The baseline is the byte-identical preassembled private-R2 object."
  },
  thresholds,
  summary: {
    passed,
    completedRequests,
    failedRequests,
    errorRate,
    contentMismatches,
    virtual: summarize(virtualDurations),
    baseline: summarize(baselineDurations),
    p95AddedMs
  },
  patterns: [...patterns.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      pairs: value.pairs,
      contentMismatches: value.contentMismatches,
      virtual: summarize(sorted(value.virtual)),
      baseline: summarize(sorted(value.baseline))
    })),
  errors
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600
});
process.stdout.write(
  `Paired load gate ${passed ? "passed" : "failed"}: `
  + `${requestCount} requests; errors=${failedRequests}; `
  + `contentMismatches=${contentMismatches}; `
  + `p95AddedMs=${p95AddedMs}; evidence=${outputPath}\n`
);
if (!passed) process.exit(1);

async function verifyHeads() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const [virtual, baseline] = await Promise.all([
      fetch(urls.virtual, { method: "HEAD", redirect: "error" }),
      fetch(urls.baseline, { method: "HEAD", redirect: "error" })
    ]);
    const valid = [virtual, baseline].every((response) =>
      response.status === 200
      && Number(response.headers.get("content-length")) === TOTAL_BYTES
      && noStore(response.headers)
    ) && virtual.headers.get("etag") === baseline.headers.get("etag");
    if (valid) return;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail("diagnostic HEAD invariants did not stabilize after three attempts");
}

async function executePair(index, measured) {
  const pattern = requestPattern(index);
  const order = index % 2 === 0
    ? ["virtual", "baseline"]
    : ["baseline", "virtual"];
  const pairResults = await Promise.all(
    order.map((variant) => probe(variant, pattern))
  );
  const byVariant = Object.fromEntries(
    pairResults.map((result) => [result.variant, result])
  );
  if (!measured) return;

  const patternMetrics = patterns.get(pattern.name) ?? {
    pairs: 0,
    contentMismatches: 0,
    virtual: [],
    baseline: []
  };
  patternMetrics.pairs += 1;
  for (const variant of ["virtual", "baseline"]) {
    const result = byVariant[variant];
    completedRequests += 1;
    metrics[variant].push(result.durationMs);
    patternMetrics[variant].push(result.durationMs);
    if (!result.ok) {
      failedRequests += 1;
      if (errors.length < MAX_RECORDED_ERRORS) {
        errors.push({
          pair: index,
          pattern: pattern.name,
          variant,
          code: result.code,
          status: result.status
        });
      }
    }
  }
  if (
    byVariant.virtual.ok
    && byVariant.baseline.ok
    && byVariant.virtual.sha256 !== byVariant.baseline.sha256
  ) {
    contentMismatches += 1;
    patternMetrics.contentMismatches += 1;
    if (errors.length < MAX_RECORDED_ERRORS) {
      errors.push({
        pair: index,
        pattern: pattern.name,
        variant: "pair",
        code: "content_mismatch",
        status: null
      });
    }
  }
  patterns.set(pattern.name, patternMetrics);
}

async function probe(variant, pattern) {
  const startedAt = performance.now();
  try {
    const response = await fetch(urls[variant], {
      redirect: "error",
      headers: {
        range: pattern.range,
        "cache-control": "no-cache"
      }
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const durationMs = round(performance.now() - startedAt);
    const expectedLength = pattern.endsAt - pattern.startsAt + 1;
    const expectedContentRange =
      `bytes ${pattern.startsAt}-${pattern.endsAt}/${TOTAL_BYTES}`;
    const ok =
      response.status === 206
      && body.byteLength === expectedLength
      && response.headers.get("content-range") === expectedContentRange
      && noStore(response.headers);
    return {
      variant,
      ok,
      code: ok ? null : "protocol_mismatch",
      status: response.status,
      durationMs,
      sha256: createHash("sha256").update(body).digest("hex")
    };
  } catch {
    return {
      variant,
      ok: false,
      code: "fetch_failed",
      status: null,
      durationMs: round(performance.now() - startedAt),
      sha256: null
    };
  }
}

function requestPattern(index) {
  switch (index % 5) {
    case 0:
      return boundedPattern("first-4k", 0, 4_095);
    case 1:
      return boundedPattern("middle-4k", 65_536, 69_631);
    case 2:
      return boundedPattern("first-boundary", 80_600, 80_731);
    case 3:
      return boundedPattern("second-boundary", 113_200, 113_331);
    default:
      return {
        name: "suffix-8k",
        range: "bytes=-8192",
        startsAt: TOTAL_BYTES - 8_192,
        endsAt: TOTAL_BYTES - 1
      };
  }
}

function boundedPattern(name, startsAt, endsAt) {
  return {
    name,
    range: `bytes=${startsAt}-${endsAt}`,
    startsAt,
    endsAt
  };
}

function noStore(headers) {
  return String(headers.get("cache-control") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase() === "no-store");
}

function summarize(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maximumMs: values.at(-1)
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  return values[
    Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)
  ];
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`Paired load gate failed: ${message}\n`);
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
