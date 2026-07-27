import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { fetchWithTimeout } from "./fetch-with-timeout";
import { privateJson } from "./http";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const IMPORT_PREVIEW_SCHEMA = "dustwave-rss-import-preview-v1";
const MAXIMUM_FEED_BYTES = 5 * 1024 * 1024;
const MAXIMUM_FEED_ITEMS = 500;
const MAXIMUM_PREVIEW_ITEMS = 25;
const MAXIMUM_REDIRECTS = 2;
const FEED_FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml"
]);
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/x-wav"
]);
const RESERVED_HOST_SUFFIXES = [
  ".example",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".test"
];

type PreviewShowRow = {
  id: string;
  title: string;
};

type ImportFeedResponse = {
  xml: string;
  resolvedUrl: string;
  redirectCount: number;
};

type EnclosurePreview = {
  url: string | null;
  mimeType: string | null;
  bytes: number | null;
};

export type RssImportEpisodePreview = {
  sourceIdentitySha256: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  explicit: boolean | null;
  canonicalUrl: string | null;
  enclosure: EnclosurePreview;
  migrationReady: boolean;
  blockers: string[];
  warnings: string[];
};

export type RssImportPreview = {
  schemaVersion: typeof IMPORT_PREVIEW_SCHEMA;
  requestedUrl: string;
  resolvedUrl: string;
  redirectCount: number;
  feedSha256: string;
  title: string;
  description: string;
  language: string | null;
  artworkUrl: string | null;
  ownerEmailPresent: boolean;
  itemCount: number;
  audioItemCount: number;
  migratableItemCount: number;
  previewItemCount: number;
  previewTruncated: boolean;
  episodes: RssImportEpisodePreview[];
  limits: {
    maximumFeedBytes: number;
    maximumFeedItems: number;
    maximumPreviewItems: number;
  };
};

export async function previewAdminRssImport(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;

  const body = await readJsonObject(request, 5_000);
  requireExactKeys(body, ["feedUrl", "ownershipConfirmed"]);
  if (body.ownershipConfirmed !== true) {
    throw new RequestValidationError(
      "You must confirm that Dust Wave owns or may import this podcast.",
      "rss_import_ownership_confirmation_required"
    );
  }
  const requestedUrl = validatedImportFeedUrl(
    requiredText(body.feedUrl, "feedUrl", 2_000)
  );
  const show = await env.DB.prepare(
    `SELECT id, title
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<PreviewShowRow>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }

  const source = await fetchImportFeed(requestedUrl);
  const preview = await parsePodcastRssImportPreview(
    source.xml,
    requestedUrl,
    source.resolvedUrl,
    source.redirectCount
  );
  return privateJson(request, env.ALLOWED_ORIGINS, {
    show: {
      id: show.id,
      title: show.title
    },
    preview,
    importMutationPerformed: false
  });
}

export async function parsePodcastRssImportPreview(
  xml: string,
  requestedUrlValue: string,
  resolvedUrlValue = requestedUrlValue,
  redirectCount = 0
): Promise<RssImportPreview> {
  const requestedUrl = validatedImportFeedUrl(requestedUrlValue);
  const resolvedUrl = validatedImportFeedUrl(resolvedUrlValue);
  if (
    !Number.isSafeInteger(redirectCount)
    || redirectCount < 0
    || redirectCount > MAXIMUM_REDIRECTS
  ) {
    throw new RequestValidationError(
      "The feed redirect count is invalid.",
      "rss_import_redirect_invalid",
      422
    );
  }
  const normalized = xml.trim();
  if (
    !normalized
    || /<!DOCTYPE|<!ENTITY/iu.test(normalized)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)
    || countMatches(normalized, /<rss\b/giu) !== 1
    || countMatches(normalized, /<channel\b/giu) !== 1
  ) {
    throw new RequestValidationError(
      "The source is not a safe RSS document.",
      "rss_import_document_invalid",
      422
    );
  }
  const channel = normalized.match(
    /<channel\b[^>]*>([\s\S]*?)<\/channel>/iu
  )?.[1];
  if (!channel) {
    throw new RequestValidationError(
      "The RSS channel is missing.",
      "rss_import_channel_missing",
      422
    );
  }
  const items = [...channel.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)]
    .map((match) => match[1]);
  if (items.length > MAXIMUM_FEED_ITEMS) {
    throw new RequestValidationError(
      `The feed contains more than ${MAXIMUM_FEED_ITEMS} items.`,
      "rss_import_catalog_too_large",
      422
    );
  }
  const channelMetadata = channel.slice(
    0,
    channel.search(/<item\b/iu) === -1
      ? channel.length
      : channel.search(/<item\b/iu)
  );
  const title = elementText(channelMetadata, "title", 240);
  if (!title) {
    throw new RequestValidationError(
      "The RSS channel title is missing.",
      "rss_import_title_missing",
      422
    );
  }
  const description = (
    elementText(channelMetadata, "description", 4_000)
    || elementText(channelMetadata, "itunes:summary", 4_000)
  );
  const language = normalizedLanguage(
    elementText(channelMetadata, "language", 40)
  );
  const artworkUrl = channelArtworkUrl(channelMetadata);
  const ownerEmailPresent = Boolean(
    channelMetadata.match(
      /<itunes:owner\b[^>]*>[\s\S]*?<itunes:email\b[^>]*>[\s\S]+?<\/itunes:email>[\s\S]*?<\/itunes:owner>/iu
    )
  );
  const episodes = await Promise.all(items.map(parseEpisodePreview));
  const audioItemCount = episodes.filter(
    ({ enclosure }) => enclosure.mimeType?.startsWith("audio/")
  ).length;
  const migratableItemCount = episodes.filter(
    ({ migrationReady }) => migrationReady
  ).length;
  const previewEpisodes = episodes.slice(0, MAXIMUM_PREVIEW_ITEMS);

  return {
    schemaVersion: IMPORT_PREVIEW_SCHEMA,
    requestedUrl,
    resolvedUrl,
    redirectCount,
    feedSha256: await sha256Hex(normalized),
    title,
    description,
    language,
    artworkUrl,
    ownerEmailPresent,
    itemCount: episodes.length,
    audioItemCount,
    migratableItemCount,
    previewItemCount: previewEpisodes.length,
    previewTruncated: episodes.length > previewEpisodes.length,
    episodes: previewEpisodes,
    limits: {
      maximumFeedBytes: MAXIMUM_FEED_BYTES,
      maximumFeedItems: MAXIMUM_FEED_ITEMS,
      maximumPreviewItems: MAXIMUM_PREVIEW_ITEMS
    }
  };
}

export function validatedImportFeedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidFeedUrl();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hash
    || hostname.length > 253
    || !hostname.includes(".")
    || hostname === "metadata.google.internal"
    || hostname.includes(":")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)
    || RESERVED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw invalidFeedUrl();
  }
  return url.toString();
}

async function fetchImportFeed(requestedUrl: string): Promise<ImportFeedResponse> {
  let currentUrl = requestedUrl;
  const visited = new Set<string>();
  for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
    if (visited.has(currentUrl)) {
      throw new RequestValidationError(
        "The feed redirect looped.",
        "rss_import_redirect_loop",
        422
      );
    }
    visited.add(currentUrl);
    let response: Response;
    try {
      response = await fetchWithTimeout(
        currentUrl,
        {
          method: "GET",
          redirect: "manual",
          headers: {
            accept:
              "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
            "user-agent": "DustWavePodcastImportPreview/1.0"
          }
        },
        FEED_FETCH_TIMEOUT_MS
      );
    } catch {
      throw new RequestValidationError(
        "The podcast feed could not be fetched.",
        "rss_import_fetch_failed",
        502
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= MAXIMUM_REDIRECTS) {
        throw new RequestValidationError(
          "The podcast feed redirected too many times.",
          "rss_import_redirect_limit",
          422
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new RequestValidationError(
          "The podcast feed redirect is incomplete.",
          "rss_import_redirect_invalid",
          422
        );
      }
      currentUrl = validatedImportFeedUrl(
        new URL(location, currentUrl).toString()
      );
      continue;
    }
    if (response.status !== 200) {
      throw new RequestValidationError(
        "The podcast feed did not return a successful response.",
        "rss_import_response_not_successful",
        422
      );
    }
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new RequestValidationError(
        "The podcast feed returned an unsupported content type.",
        "rss_import_content_type_invalid",
        422
      );
    }
    return {
      xml: await readBoundedFeedText(response),
      resolvedUrl: currentUrl,
      redirectCount
    };
  }
  throw new RequestValidationError(
    "The podcast feed redirected too many times.",
    "rss_import_redirect_limit",
    422
  );
}

async function parseEpisodePreview(
  item: string
): Promise<RssImportEpisodePreview> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const title = elementText(item, "title", 240);
  const guid = elementText(item, "guid", 2_000);
  const summary = (
    elementText(item, "description", 4_000)
    || elementText(item, "itunes:summary", 4_000)
  );
  const publishedAt = parsedDate(elementText(item, "pubDate", 120));
  const durationSeconds = parsedDuration(
    elementText(item, "itunes:duration", 80)
  );
  const explicit = parsedExplicit(
    elementText(item, "itunes:explicit", 40)
  );
  const canonicalUrl = optionalPublicUrl(elementText(item, "link", 2_000));
  const enclosure = enclosurePreview(item);

  if (!title) blockers.push("missing_title");
  if (!guid) blockers.push("missing_guid");
  if (!publishedAt) blockers.push("missing_or_invalid_publication_date");
  if (!enclosure.url) blockers.push("missing_or_invalid_enclosure_url");
  if (!enclosure.mimeType || !ALLOWED_AUDIO_TYPES.has(enclosure.mimeType)) {
    blockers.push("unsupported_enclosure_type");
  }
  if (!enclosure.bytes) blockers.push("missing_or_invalid_enclosure_bytes");
  if (durationSeconds === null) warnings.push("missing_or_invalid_duration");
  if (explicit === null) warnings.push("missing_or_invalid_explicit_value");
  if (!canonicalUrl) warnings.push("missing_or_invalid_canonical_url");

  return {
    sourceIdentitySha256: await sha256Hex(
      `${guid}\n${enclosure.url ?? ""}`
    ),
    title,
    summary,
    publishedAt,
    durationSeconds,
    explicit,
    canonicalUrl,
    enclosure,
    migrationReady: blockers.length === 0,
    blockers,
    warnings
  };
}

function enclosurePreview(item: string): EnclosurePreview {
  const openTag = item.match(/<enclosure\b([^>]*)\/?>/iu)?.[1] ?? "";
  const attributes = elementAttributes(openTag);
  const mimeType = String(attributes.type ?? "").trim().toLowerCase() || null;
  const length = Number(attributes.length);
  return {
    url: optionalPublicUrl(attributes.url ?? ""),
    mimeType,
    bytes:
      Number.isSafeInteger(length) && length > 0
        ? length
        : null
  };
}

function channelArtworkUrl(channelMetadata: string): string | null {
  const itunesImage = channelMetadata.match(
    /<itunes:image\b([^>]*)\/?>/iu
  )?.[1];
  if (itunesImage) {
    const href = elementAttributes(itunesImage).href;
    const artwork = optionalPublicUrl(href ?? "");
    if (artwork) return artwork;
  }
  const image = channelMetadata.match(
    /<image\b[^>]*>([\s\S]*?)<\/image>/iu
  )?.[1];
  return image ? optionalPublicUrl(elementText(image, "url", 2_000)) : null;
}

function elementText(
  source: string,
  tag: string,
  maximumLength: number
): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = source.match(
    new RegExp(
      `<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`,
      "iu"
    )
  )?.[1] ?? "";
  return cleanFeedText(value).slice(0, maximumLength);
}

function cleanFeedText(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<[^>]*>/gu, " ")
  )
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, hex: string, decimal: string, named: string) => {
      if (hex) return safeCodePoint(Number.parseInt(hex, 16), entity);
      if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
      return {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"'
      }[String(named).toLowerCase()] ?? entity;
    }
  );
}

function safeCodePoint(value: number, fallback: string): string {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > 0x10ffff
    || (value >= 0xd800 && value <= 0xdfff)
  ) {
    return fallback;
  }
  return String.fromCodePoint(value);
}

function elementAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(
    /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu
  )) {
    attributes[match[1].toLowerCase()] = decodeXmlEntities(
      match[2] ?? match[3] ?? ""
    );
  }
  return attributes;
}

function optionalPublicUrl(value: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    return validatedImportFeedUrl(text);
  } catch {
    return null;
  }
}

function parsedDate(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parsedDuration(value: string): number | null {
  const text = value.trim();
  if (/^[0-9]+$/u.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  const parts = text.split(":").map(Number);
  if (
    parts.length < 2
    || parts.length > 3
    || parts.some((part) => !Number.isSafeInteger(part) || part < 0)
    || parts.slice(1).some((part) => part > 59)
  ) {
    return null;
  }
  const seconds = parts.length === 2
    ? parts[0] * 60 + parts[1]
    : parts[0] * 3_600 + parts[1] * 60 + parts[2];
  return seconds > 0 ? seconds : null;
}

function parsedExplicit(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "explicit"].includes(normalized)) return true;
  if (["false", "no", "clean"].includes(normalized)) return false;
  return null;
}

async function readBoundedFeedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isSafeInteger(declaredLength)
    && declaredLength > MAXIMUM_FEED_BYTES
  ) {
    throw new RequestValidationError(
      "The podcast feed exceeds the preview limit.",
      "rss_import_feed_too_large",
      413
    );
  }
  if (!response.body) {
    throw new RequestValidationError(
      "The podcast feed response has no body.",
      "rss_import_body_missing",
      422
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_FEED_BYTES) {
        try {
          await reader.cancel("rss_import_feed_too_large");
        } catch {
          // Preserve the stable validation error if cancellation fails.
        }
        throw new RequestValidationError(
          "The podcast feed exceeds the preview limit.",
          "rss_import_feed_too_large",
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false
    }).decode(bytes);
  } catch {
    throw new RequestValidationError(
      "The podcast feed is not valid UTF-8.",
      "rss_import_encoding_invalid",
      422
    );
  }
}

function normalizedLanguage(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(normalized)
    ? normalized
    : null;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[]
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestValidationError(
      "The RSS import preview request has unsupported fields."
    );
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function invalidFeedUrl(): RequestValidationError {
  return new RequestValidationError(
    "feedUrl must be a public HTTPS URL without credentials or a fragment.",
    "rss_import_feed_url_invalid"
  );
}
