const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ARTWORK_BYTES = 1_500_000;
const SHOW_PATH = "/opera-en-la-selva/rss.xml";
const ARTWORK_PATH = "/img/podcasts/opera-en-la-selva/artwork-feed.jpg";

const TARGETS = Object.freeze({
  staging: Object.freeze({
    feedOrigin: "https://dust-wave-podcast-staging.jogo.workers.dev",
    artworkOrigin: "https://dust-wave-website-staging.pages.dev"
  }),
  production: Object.freeze({
    feedOrigin: "https://feeds.dustwave.xyz",
    artworkOrigin: "https://dustwave.xyz"
  })
});

export async function runPublicReleaseGate({
  environment,
  fetchImpl = fetch,
  timeoutMs = 10_000
}) {
  const target = TARGETS[environment];
  if (!target) {
    throw new Error("Environment must be exactly staging or production.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("The release-gate timeout must be between 1 and 30000 ms.");
  }

  const feedUrl = `${target.feedOrigin}${SHOW_PATH}`;
  const expectedArtworkUrl = `${target.artworkOrigin}${ARTWORK_PATH}`;
  const feedResponse = await releaseFetch(fetchImpl, feedUrl, {
    headers: { accept: "application/rss+xml, application/xml;q=0.9" }
  }, timeoutMs);
  assertStatus(feedResponse, 200, "RSS feed");
  assertHeaderStartsWith(feedResponse, "content-type", "application/rss+xml", "RSS feed");
  assertHeaderEquals(feedResponse, "x-content-type-options", "nosniff", "RSS feed");
  assertPublicCache(feedResponse, "RSS feed");
  assertContentLength(feedResponse, MAX_FEED_BYTES, "RSS feed", { optional: true });

  const etag = feedResponse.headers.get("etag") || "";
  if (!/^(?:W\/)?"[a-f0-9]{64}"$/.test(etag)) {
    throw new Error("RSS feed did not return its SHA-256 ETag.");
  }
  const feedXml = await readBoundedText(feedResponse, MAX_FEED_BYTES, "RSS feed");
  assertFeedXml(feedXml, feedUrl, expectedArtworkUrl);
  const conditionalEtag = etag.replace(/^W\//, "");

  const [artworkResponse, conditionalResponse] = await Promise.all([
    releaseFetch(fetchImpl, expectedArtworkUrl, {
      headers: { accept: "image/jpeg" }
    }, timeoutMs),
    releaseFetch(fetchImpl, feedUrl, {
      headers: {
        accept: "application/rss+xml, application/xml;q=0.9",
        "if-none-match": conditionalEtag
      }
    }, timeoutMs)
  ]);

  assertStatus(artworkResponse, 200, "feed artwork");
  assertHeaderStartsWith(artworkResponse, "content-type", "image/jpeg", "feed artwork");
  assertHeaderEquals(artworkResponse, "x-content-type-options", "nosniff", "feed artwork");
  assertPublicCache(artworkResponse, "feed artwork");
  const declaredArtworkBytes = assertContentLength(
    artworkResponse,
    MAX_ARTWORK_BYTES,
    "feed artwork",
    { optional: true }
  );
  const artworkBytes = await readBoundedBytes(
    artworkResponse,
    MAX_ARTWORK_BYTES,
    "feed artwork"
  );
  if (artworkBytes === 0) {
    throw new Error("Feed artwork returned an empty body.");
  }
  if (declaredArtworkBytes !== null && declaredArtworkBytes !== artworkBytes) {
    throw new Error("Feed artwork body does not match its content-length header.");
  }

  assertStatus(conditionalResponse, 304, "conditional RSS feed");
  if ((conditionalResponse.headers.get("etag") || "").replace(/^W\//, "") !== conditionalEtag) {
    throw new Error("Conditional RSS response changed the feed ETag.");
  }

  return Object.freeze({
    schemaVersion: "dust-wave-public-release-gate-v1",
    environment,
    feedUrl,
    feedBytes: new TextEncoder().encode(feedXml).byteLength,
    feedEtag: etag,
    artworkUrl: expectedArtworkUrl,
    artworkBytes,
    conditionalStatus: conditionalResponse.status,
    passed: true
  });
}

async function releaseFetch(fetchImpl, url, init, timeoutMs) {
  return fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expected}.`);
  }
}

function assertHeaderStartsWith(response, name, expected, label) {
  const actual = response.headers.get(name) || "";
  if (!actual.toLowerCase().startsWith(expected)) {
    throw new Error(`${label} returned an invalid ${name} header.`);
  }
}

function assertHeaderEquals(response, name, expected, label) {
  const actual = response.headers.get(name) || "";
  if (actual.toLowerCase() !== expected) {
    throw new Error(`${label} returned an invalid ${name} header.`);
  }
}

function assertPublicCache(response, label) {
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  const directives = cacheControl.split(",").map((value) => value.trim());
  const maxAge = directives.find((value) => /^max-age=\d+$/.test(value));
  if (
    directives.includes("private")
    || directives.includes("no-store")
    || !maxAge
    || Number(maxAge.slice("max-age=".length)) < 1
  ) {
    throw new Error(`${label} is missing its safe shared-cache policy.`);
  }
}

function assertContentLength(response, maximum, label, { optional = false } = {}) {
  const raw = response.headers.get("content-length");
  if (raw === null && optional) return null;
  if (!/^[1-9]\d*$/.test(raw || "")) {
    throw new Error(`${label} returned an invalid content-length header.`);
  }
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes > maximum) {
    throw new Error(`${label} exceeds its ${maximum}-byte release budget.`);
  }
  return bytes;
}

async function readBoundedText(response, maximum, label) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error(`${label} exceeds its ${maximum}-byte release budget.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readBoundedBytes(response, maximum, label) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error(`${label} exceeds its ${maximum}-byte release budget.`);
    }
  }
}

function assertFeedXml(xml, feedUrl, artworkUrl) {
  if (!xml.startsWith("<?xml") || !xml.includes("<rss version=\"2.0\"")) {
    throw new Error("RSS feed body is not the expected RSS 2.0 document.");
  }
  if (!xml.includes("<title>Ópera en la Selva</title>")) {
    throw new Error("RSS feed body is missing the canonical show title.");
  }
  if (!xml.includes(`<atom:link href="${feedUrl}" rel="self"`)) {
    throw new Error("RSS feed body is missing its exact canonical self link.");
  }
  if (!xml.includes(`<itunes:image href="${artworkUrl}"/>`)) {
    throw new Error("RSS feed body is missing the exact release artwork URL.");
  }
}
