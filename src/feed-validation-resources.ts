import { imageDimensions } from "@dustwave/media-core/image-dimensions";

import { servePublicEpisodeChapters } from "./chapters";
import type { PodcastEnv } from "./env";
import { PublicFeedValidationError } from "./feed-validation-error";
import { servePublicEpisodeAudioPreflight } from "./media";
import { servePublicEpisodeTranscriptVtt } from "./transcripts";

const MAXIMUM_ARTWORK_BYTES = 10 * 1024 * 1024;
const MAXIMUM_ARTWORK_PROBE_BYTES = 64 * 1024;
const MINIMUM_ARTWORK_DIMENSION = 1_400;
const MAXIMUM_ARTWORK_DIMENSION = 3_000;
const MAXIMUM_REDIRECTS = 3;
const RESOURCE_TIMEOUT_MS = 10_000;

type FeedEnclosure = {
  url: URL;
  episodeId: string;
  length: number;
  mimeType: string;
};

type FeedTranscript = {
  url: URL;
  showSlug: string;
  episodeSlug: string;
  language: "en" | "es";
};

type FeedChapter = {
  url: URL;
  showSlug: string;
  episodeSlug: string;
};

type FeedItemResources = {
  canonicalUrl: URL;
  enclosure: FeedEnclosure;
  transcripts: FeedTranscript[];
  chapter: FeedChapter | null;
};

type FeedResourceProjection = {
  canonicalUrl: URL;
  artworkUrl: URL;
  items: FeedItemResources[];
};

export async function validatePublicFeedResources(
  env: PodcastEnv,
  xml: string,
  expectedFeedUrl: string
): Promise<void> {
  const projection = resourceProjection(xml, expectedFeedUrl, env);
  const pageOrigins = approvedSiteOrigins(env);

  await validateHtmlPage(projection.canonicalUrl, pageOrigins);
  await validatePodcastArtwork(projection.artworkUrl, pageOrigins);
  for (const item of projection.items) {
    await validateHtmlPage(item.canonicalUrl, pageOrigins);
    await validateEnclosure(env, item.enclosure);
    for (const transcript of item.transcripts) {
      await validateTranscript(env, transcript);
    }
    if (item.chapter) await validateChapter(env, item.chapter);
  }
}

function resourceProjection(
  xml: string,
  expectedFeedUrl: string,
  env: PodcastEnv
): FeedResourceProjection {
  const channelOpen = xml.indexOf("<channel>");
  const firstItem = xml.indexOf("<item>");
  const channelMetadata = xml.slice(
    channelOpen,
    firstItem === -1 ? xml.indexOf("</channel>") : firstItem
  );
  const canonicalUrl = permanentUrl(
    requiredMatch(channelMetadata, /<link>([^<]+)<\/link>/u, "feed_canonical_url_invalid"),
    "feed_canonical_url_invalid"
  );
  const artworkUrl = permanentUrl(
    requiredMatch(
      channelMetadata,
      /<itunes:image href="([^"]+)"\/>/u,
      "feed_artwork_metadata_invalid"
    ),
    "feed_artwork_metadata_invalid"
  );
  const allowedSiteOrigins = approvedSiteOrigins(env);
  if (!allowedSiteOrigins.has(canonicalUrl.origin)) {
    fail(
      "The canonical show page is outside an approved site origin.",
      "feed_canonical_url_invalid"
    );
  }
  if (!allowedSiteOrigins.has(artworkUrl.origin)) {
    fail("Podcast artwork is outside an approved site origin.", "feed_artwork_url_invalid");
  }

  const feedOrigin = permanentUrl(
    expectedFeedUrl,
    "feed_resource_origin_invalid"
  ).origin;
  const configuredFeedOrigin = safeOrigin(env.FEED_ORIGIN);
  const mediaOrigin = safeOrigin(env.MEDIA_ORIGIN);
  if (feedOrigin !== configuredFeedOrigin) {
    fail("The feed URL does not match the configured origin.", "feed_resource_origin_invalid");
  }
  const canonicalUrls = new Set<string>();
  const enclosureUrls = new Set<string>();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)]
    .map(([, item]) => {
      const itemCanonicalUrl = permanentUrl(
        requiredMatch(item, /<link>(https:\/\/[^<]+)<\/link>/u, "feed_item_url_invalid"),
        "feed_item_url_invalid"
      );
      if (!allowedSiteOrigins.has(itemCanonicalUrl.origin)) {
        fail("An episode page is outside an approved site origin.", "feed_item_url_invalid");
      }
      uniqueUrl(canonicalUrls, itemCanonicalUrl, "feed_item_url_invalid");

      const enclosureMatch = item.match(
        /<enclosure url="([^"]+)" length="([1-9][0-9]*)" type="(audio\/(?:mpeg|mp4))"\/>/u
      );
      if (!enclosureMatch) {
        fail("An enclosure contract is invalid.", "feed_enclosure_metadata_invalid");
      }
      const enclosureUrl = permanentUrl(
        enclosureMatch[1],
        "feed_enclosure_url_invalid"
      );
      if (enclosureUrl.origin !== mediaOrigin) {
        fail("An enclosure is outside the media origin.", "feed_enclosure_url_invalid");
      }
      const enclosurePath = enclosureUrl.pathname.match(
        /^\/episodes\/([A-Za-z0-9_-]+)\/audio$/u
      );
      if (!enclosurePath) {
        fail("An enclosure path is invalid.", "feed_enclosure_url_invalid");
      }
      uniqueUrl(enclosureUrls, enclosureUrl, "feed_enclosure_url_invalid");

      const transcripts = [...item.matchAll(
        /<podcast:transcript url="([^"]+)" type="text\/vtt" language="(en|es)"\/>/gu
      )].map((match) => transcriptResource(match[1], match[2], feedOrigin));
      const chapterMatch = item.match(
        /<podcast:chapters url="([^"]+)" type="application\/json\+chapters"\/>/u
      );
      return {
        canonicalUrl: itemCanonicalUrl,
        enclosure: {
          url: enclosureUrl,
          episodeId: enclosurePath[1],
          length: Number(enclosureMatch[2]),
          mimeType: enclosureMatch[3]
        },
        transcripts,
        chapter: chapterMatch
          ? chapterResource(chapterMatch[1], feedOrigin)
          : null
      };
    });
  return { canonicalUrl, artworkUrl, items };
}

function transcriptResource(
  value: string,
  languageValue: string,
  feedOrigin: string
): FeedTranscript {
  const url = permanentUrl(value, "feed_transcript_url_invalid");
  const path = url.pathname.match(
    /^\/v1\/shows\/([A-Za-z0-9_-]+)\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)\.vtt$/u
  );
  if (url.origin !== feedOrigin || !path || path[3] !== languageValue) {
    fail("A transcript URL is not canonical.", "feed_transcript_url_invalid");
  }
  return {
    url,
    showSlug: path[1],
    episodeSlug: path[2],
    language: path[3] as "en" | "es"
  };
}

function chapterResource(value: string, feedOrigin: string): FeedChapter {
  const url = permanentUrl(value, "feed_chapter_url_invalid");
  const path = url.pathname.match(
    /^\/v1\/shows\/([A-Za-z0-9_-]+)\/episodes\/([A-Za-z0-9_-]+)\/chapters\.json$/u
  );
  if (url.origin !== feedOrigin || !path) {
    fail("A chapter URL is not canonical.", "feed_chapter_url_invalid");
  }
  return { url, showSlug: path[1], episodeSlug: path[2] };
}

async function validateHtmlPage(url: URL, allowedOrigins: Set<string>): Promise<void> {
  const response = await fetchApprovedResource(url, allowedOrigins, {
    method: "HEAD"
  }, "feed_canonical_page_unavailable");
  if (
    response.status !== 200
    || !mediaType(response).startsWith("text/html")
  ) {
    fail("A canonical page is unavailable.", "feed_canonical_page_unavailable");
  }
  await cancelBody(response);
}

async function validatePodcastArtwork(
  url: URL,
  allowedOrigins: Set<string>
): Promise<void> {
  const response = await fetchApprovedResource(url, allowedOrigins, {
    method: "GET",
    headers: { range: `bytes=0-${MAXIMUM_ARTWORK_PROBE_BYTES - 1}` }
  }, "feed_artwork_unavailable");
  if (![200, 206].includes(response.status)) {
    fail("Podcast artwork is unavailable.", "feed_artwork_unavailable");
  }
  const contentType = mediaType(response);
  if (!["image/jpeg", "image/png"].includes(contentType)) {
    fail("Podcast artwork must be JPEG or PNG.", "feed_artwork_type_invalid");
  }
  const totalBytes = response.status === 206
    ? contentRangeTotal(response.headers.get("content-range"))
    : positiveInteger(response.headers.get("content-length"));
  if (!totalBytes || totalBytes > MAXIMUM_ARTWORK_BYTES) {
    fail("Podcast artwork has an invalid byte length.", "feed_artwork_size_invalid");
  }
  const bytes = await readBoundedBytes(response, MAXIMUM_ARTWORK_PROBE_BYTES);
  const dimensions = imageDimensions(bytes, contentType);
  if (
    !dimensions
    || dimensions.width !== dimensions.height
    || dimensions.width < MINIMUM_ARTWORK_DIMENSION
    || dimensions.width > MAXIMUM_ARTWORK_DIMENSION
  ) {
    fail(
      "Podcast artwork must be square and between 1400 and 3000 pixels.",
      "feed_artwork_dimensions_invalid"
    );
  }
}

async function validateEnclosure(
  env: PodcastEnv,
  enclosure: FeedEnclosure
): Promise<void> {
  const head = await servePublicEpisodeAudioPreflight(
    new Request(enclosure.url, { method: "HEAD" }),
    env,
    enclosure.episodeId
  );
  if (
    head.status !== 200
    || mediaType(head) !== enclosure.mimeType
    || head.headers.get("accept-ranges") !== "bytes"
    || positiveInteger(head.headers.get("content-length")) !== enclosure.length
    || !head.headers.get("etag")
  ) {
    fail("An enclosure HEAD contract failed.", "feed_enclosure_head_invalid");
  }
  const range = await servePublicEpisodeAudioPreflight(
    new Request(enclosure.url, { headers: { range: "bytes=0-0" } }),
    env,
    enclosure.episodeId
  );
  if (
    range.status !== 206
    || range.headers.get("accept-ranges") !== "bytes"
    || range.headers.get("content-length") !== "1"
    || range.headers.get("content-range") !== `bytes 0-0/${enclosure.length}`
    || (await readBoundedBytes(range, 1)).byteLength !== 1
  ) {
    fail("An enclosure byte-range contract failed.", "feed_enclosure_range_invalid");
  }
}

async function validateTranscript(
  env: PodcastEnv,
  transcript: FeedTranscript
): Promise<void> {
  const response = await servePublicEpisodeTranscriptVtt(
    new Request(transcript.url, { method: "HEAD" }),
    env,
    transcript.showSlug,
    transcript.episodeSlug,
    transcript.language
  );
  assertDocumentResponse(response, "text/vtt", "feed_transcript_unavailable");
}

async function validateChapter(env: PodcastEnv, chapter: FeedChapter): Promise<void> {
  const response = await servePublicEpisodeChapters(
    new Request(chapter.url, { method: "HEAD" }),
    env,
    chapter.showSlug,
    chapter.episodeSlug
  );
  assertDocumentResponse(
    response,
    "application/json+chapters",
    "feed_chapter_unavailable"
  );
}

function assertDocumentResponse(
  response: Response,
  expectedType: string,
  code: string
): void {
  if (
    response.status !== 200
    || mediaType(response) !== expectedType
    || !response.headers.get("etag")
    || !response.headers.get("cache-control")?.includes("public")
  ) {
    fail("A public feed document is unavailable.", code);
  }
}

async function fetchApprovedResource(
  initialUrl: URL,
  allowedOrigins: Set<string>,
  init: RequestInit,
  failureCode: string
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= MAXIMUM_REDIRECTS; redirect += 1) {
    if (!allowedOrigins.has(currentUrl.origin)) {
      fail("A feed resource redirect left its approved origin.", failureCode);
    }
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(RESOURCE_TIMEOUT_MS)
      });
    } catch {
      fail("A public feed resource could not be fetched.", failureCode);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await cancelBody(response);
    if (!location || redirect === MAXIMUM_REDIRECTS) {
      fail("A public feed resource redirect is invalid.", failureCode);
    }
    currentUrl = permanentUrl(
      new URL(location, currentUrl).toString(),
      failureCode
    );
  }
  fail("A public feed resource redirect is invalid.", failureCode);
}

function permanentUrl(value: string, code: string): URL {
  let url: URL;
  try {
    url = new URL(decodeXml(value));
  } catch {
    fail("A public feed resource URL is invalid.", code);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    fail("A public feed resource URL is not permanent HTTPS.", code);
  }
  return url;
}

function safeOrigin(value: string): string {
  const url = permanentUrl(value, "feed_resource_origin_invalid");
  if (url.pathname !== "/") {
    fail("A configured resource origin contains a path.", "feed_resource_origin_invalid");
  }
  return url.origin;
}

function approvedSiteOrigins(env: PodcastEnv): Set<string> {
  return new Set([
    safeOrigin(env.SITE_ORIGIN),
    "https://dustwave.xyz",
    "https://www.dustwave.xyz"
  ]);
}

function requiredMatch(value: string, pattern: RegExp, code: string): string {
  const match = value.match(pattern)?.[1];
  if (!match) fail("Required feed resource metadata is missing.", code);
  return match;
}

function uniqueUrl(urls: Set<string>, url: URL, code: string): void {
  if (urls.has(url.href)) fail("A permanent feed URL is duplicated.", code);
  urls.add(url.href);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function contentRangeTotal(value: string | null): number | null {
  const total = value?.match(/^bytes [0-9]+-[0-9]+\/([1-9][0-9]*)$/u)?.[1];
  return positiveInteger(total ?? null);
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  if (!response.body) fail("A public feed resource has no body.", "feed_resource_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= maximumBytes) {
        await reader.cancel("resource_probe_complete").catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(Math.min(total, maximumBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= result.length) break;
    const remaining = result.length - offset;
    result.set(chunk.subarray(0, remaining), offset);
    offset += Math.min(chunk.byteLength, remaining);
  }
  return result;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function fail(message: string, code: string): never {
  throw new PublicFeedValidationError(message, code);
}
