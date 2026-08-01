import { sha256Hex } from "@dustwave/worker-core/crypto";

import { requireAdmin } from "./admin-auth";
import { prepareAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { servePublicFeed } from "./feed";
import { PublicFeedValidationError } from "./feed-validation-error";
import { validatePublicFeedResources } from "./feed-validation-resources";
import { privateJson } from "./http";
import { isPodcastGuid } from "./podcast-guid";
import { validIdentifier } from "./validation";

export const PUBLIC_FEED_VALIDATOR_VERSION =
  "dustwave-rss-launch-v4";
const MAXIMUM_FEED_BYTES = 5 * 1024 * 1024;

type FeedValidationShow = {
  id: string;
  rss_slug: string;
};

const FEED_VALIDATION_ROLES = [
  "super_admin",
  "admin",
  "producer"
] as const;

export type PublicFeedValidationEvidence = {
  showId: string;
  feedUrl: string;
  validatorVersion: string;
  feedSha256: string;
  itemCount: number;
  checkedAt: string;
  validatedAt: string;
};

export { PublicFeedValidationError } from "./feed-validation-error";

export async function retryAdminPublicFeedValidation(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...FEED_VALIDATION_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  try {
    const evidence = await validateAndRecordPublicFeed(
      env,
      showId,
      { adminUserId: auth.authorization.identity.id }
    );
    return privateJson(request, env.ALLOWED_ORIGINS, {
      valid: true,
      validatorVersion: evidence.validatorVersion,
      itemCount: evidence.itemCount,
      checkedAt: evidence.checkedAt,
      validatedAt: evidence.validatedAt
    });
  } catch (error) {
    const code = error instanceof PublicFeedValidationError
      ? error.code
      : "feed_validation_failed";
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: code },
      { status: code === "feed_show_not_found" ? 404 : 409 }
    );
  }
}

export async function validateAndRecordPublicFeed(
  env: PodcastEnv,
  showId: string,
  audit?: { adminUserId: string }
): Promise<PublicFeedValidationEvidence> {
  const show = await env.DB.prepare(
    `SELECT id, rss_slug
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<FeedValidationShow>();
  if (!show) {
    throw new PublicFeedValidationError(
      "The show is unavailable for feed validation.",
      "feed_show_not_found"
    );
  }
  const feedUrl = validatedFeedUrl(env.FEED_ORIGIN, show.rss_slug);
  const checkedAt = new Date().toISOString();
  try {
    const response = await servePublicFeed(
      new Request(feedUrl),
      env,
      show.rss_slug
    );
    if (response.status !== 200) {
      throw new PublicFeedValidationError(
        "The canonical feed did not return a successful response.",
        "feed_response_not_successful"
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/rss+xml")) {
      throw new PublicFeedValidationError(
        "The canonical feed returned an unexpected content type.",
        "feed_content_type_invalid"
      );
    }
    const xml = await readBoundedFeedText(response, MAXIMUM_FEED_BYTES);
    const validation = validatePublicPodcastFeed(xml, feedUrl);
    await validatePublicFeedResources(env, xml, feedUrl);
    const feedSha256 = await sha256Hex(xml);
    if (response.headers.get("etag") !== `"${feedSha256}"`) {
      throw new PublicFeedValidationError(
        "The canonical feed ETag does not match its exact body.",
        "feed_etag_mismatch"
      );
    }
    const evidence: PublicFeedValidationEvidence = {
      showId: show.id,
      feedUrl,
      validatorVersion: PUBLIC_FEED_VALIDATOR_VERSION,
      feedSha256,
      itemCount: validation.itemCount,
      checkedAt,
      validatedAt: checkedAt
    };
    await recordFeedValidation(env.DB, {
      ...evidence,
      status: "valid",
      failureCode: null
    }, audit);
    return evidence;
  } catch (error) {
    const failureCode = error instanceof PublicFeedValidationError
      ? error.code
      : "feed_validation_failed";
    await recordFeedValidation(env.DB, {
      showId: show.id,
      feedUrl,
      validatorVersion: PUBLIC_FEED_VALIDATOR_VERSION,
      feedSha256: null,
      itemCount: null,
      checkedAt,
      validatedAt: null,
      status: "failed",
      failureCode
    }, audit);
    if (error instanceof PublicFeedValidationError) throw error;
    throw new PublicFeedValidationError(
      "The canonical feed could not be validated.",
      failureCode
    );
  }
}

export function validatePublicPodcastFeed(
  xml: string,
  expectedFeedUrl: string
): { itemCount: number } {
  const normalized = xml.trim();
  if (
    !normalized.startsWith('<?xml version="1.0" encoding="UTF-8"?>')
    || !normalized.endsWith("</rss>")
    || countMatches(normalized, /<rss\b/gu) !== 1
    || countMatches(normalized, /<channel>/gu) !== 1
    || countMatches(normalized, /<\/channel>/gu) !== 1
    || /<!DOCTYPE|<!ENTITY/iu.test(normalized)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)
  ) {
    throw new PublicFeedValidationError(
      "The canonical feed is not a safe RSS document.",
      "feed_document_invalid"
    );
  }
  const requiredRootFragments = [
    '<rss version="2.0"',
    'xmlns:atom="http://www.w3.org/2005/Atom"',
    'xmlns:content="http://purl.org/rss/1.0/modules/content/"',
    'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"',
    'xmlns:podcast="https://podcastindex.org/namespace/1.0"',
    `<atom:link href="${escapeXml(expectedFeedUrl)}" rel="self" `
      + 'type="application/rss+xml"/>',
    "<generator>Dust Wave Podcasts</generator>",
    "<itunes:owner>",
    "<itunes:email>",
    "<podcast:locked owner="
  ];
  if (requiredRootFragments.some((fragment) => !normalized.includes(fragment))) {
    throw new PublicFeedValidationError(
      "The canonical feed is missing required launch metadata.",
      "feed_metadata_incomplete"
    );
  }
  const channelOpen = normalized.indexOf("<channel>");
  const firstItem = normalized.indexOf("<item>");
  const channelMetadata = normalized.slice(
    channelOpen,
    firstItem === -1 ? normalized.indexOf("</channel>") : firstItem
  );
  for (const tag of [
    "title",
    "link",
    "description",
    "language",
    "itunes:author",
    "itunes:summary",
    "itunes:explicit"
  ]) {
    if (!new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]+?<\\/${tag}>`, "u")
      .test(channelMetadata)) {
      throw new PublicFeedValidationError(
        "The canonical feed channel metadata is incomplete.",
        "feed_channel_metadata_incomplete"
      );
    }
  }
  if (!/<itunes:category text="[^"]+"\/>/u.test(channelMetadata)) {
    throw new PublicFeedValidationError(
      "The canonical feed channel category is missing.",
      "feed_channel_metadata_incomplete"
    );
  }
  const channelGuids = [...channelMetadata.matchAll(
    /<podcast:guid>([^<]+)<\/podcast:guid>/gu
  )];
  if (
    channelGuids.length !== 1
    || countMatches(channelMetadata, /<podcast:guid\b/gu) !== 1
    || !isPodcastGuid(channelGuids[0]?.[1])
  ) {
    throw new PublicFeedValidationError(
      "The canonical feed channel GUID is invalid.",
      "feed_channel_guid_invalid"
    );
  }

  const items = [...normalized.matchAll(/<item>([\s\S]*?)<\/item>/gu)];
  const guids = new Set<string>();
  for (const [, item] of items) {
    const requiredItemPatterns = [
      /<title>[\s\S]+?<\/title>/u,
      /<description>[\s\S]+?<\/description>/u,
      /<link>https:\/\/[\s\S]+?<\/link>/u,
      /<pubDate>[\s\S]+?<\/pubDate>/u,
      /<itunes:duration>[1-9][0-9]*<\/itunes:duration>/u,
      /<itunes:explicit>(?:true|false)<\/itunes:explicit>/u,
      /<enclosure url="https:\/\/[^"]+" length="[1-9][0-9]*" type="audio\/(?:mpeg|mp4)"\/>/u
    ];
    if (requiredItemPatterns.some((pattern) => !pattern.test(item))) {
      throw new PublicFeedValidationError(
        "A canonical feed item is incomplete.",
        "feed_item_metadata_incomplete"
      );
    }
    const transcriptTags = [...item.matchAll(
      /<podcast:transcript url="(https:\/\/[^"]+)" type="text\/vtt" language="(en|es)"\/>/gu
    )];
    if (
      transcriptTags.length
      !== countMatches(item, /<podcast:transcript\b/gu)
      || new Set(transcriptTags.map((match) => match[2])).size
        !== transcriptTags.length
    ) {
      throw new PublicFeedValidationError(
        "A canonical feed transcript link is invalid.",
        "feed_transcript_metadata_invalid"
      );
    }
    const guid = item.match(
      /<guid isPermaLink="false">([^<]+)<\/guid>/u
    )?.[1];
    if (!guid || guids.has(guid)) {
      throw new PublicFeedValidationError(
        "Canonical feed GUIDs must be present and unique.",
        "feed_guid_invalid"
      );
    }
    guids.add(guid);
  }
  return { itemCount: items.length };
}

async function recordFeedValidation(
  db: D1Database,
  evidence: {
    showId: string;
    status: "valid" | "failed";
    feedUrl: string;
    validatorVersion: string;
    feedSha256: string | null;
    itemCount: number | null;
    failureCode: string | null;
    checkedAt: string;
    validatedAt: string | null;
  },
  audit?: { adminUserId: string }
): Promise<void> {
  const validation = db.prepare(
    `INSERT INTO show_feed_validations (
       show_id, status, feed_url, validator_version, feed_sha256, item_count,
       failure_code, checked_at, validated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(show_id) DO UPDATE SET
       status = excluded.status,
       feed_url = excluded.feed_url,
       validator_version = excluded.validator_version,
       feed_sha256 = excluded.feed_sha256,
       item_count = excluded.item_count,
       failure_code = excluded.failure_code,
       checked_at = excluded.checked_at,
       validated_at = excluded.validated_at,
       updated_at = datetime('now')`
  ).bind(
    evidence.showId,
    evidence.status,
    evidence.feedUrl,
    evidence.validatorVersion,
    evidence.feedSha256,
    evidence.itemCount,
    evidence.failureCode,
    evidence.checkedAt,
    evidence.validatedAt
  );
  if (!audit) {
    await validation.run();
    return;
  }
  await db.batch([
    validation,
    prepareAdminAudit(db, {
      adminUserId: audit.adminUserId,
      action: "feed.validation_retried",
      targetType: "show",
      targetId: evidence.showId,
      metadata: {
        result: evidence.status,
        validatorVersion: evidence.validatorVersion,
        ...(evidence.status === "valid"
          ? { itemCount: evidence.itemCount }
          : { failureCode: evidence.failureCode })
      }
    })
  ]);
}

async function readBoundedFeedText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isSafeInteger(declaredLength)
    && declaredLength > maximumBytes
  ) {
    throw new PublicFeedValidationError(
      "The canonical feed exceeds the validation limit.",
      "feed_too_large"
    );
  }
  if (!response.body) {
    throw new PublicFeedValidationError(
      "The canonical feed response has no body.",
      "feed_body_missing"
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
      if (total > maximumBytes) {
        try {
          await reader.cancel("feed_too_large");
        } catch {
          // Preserve the stable validation error if cancellation fails.
        }
        throw new PublicFeedValidationError(
          "The canonical feed exceeds the validation limit.",
          "feed_too_large"
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
  return new TextDecoder(
    "utf-8",
    { fatal: true, ignoreBOM: false }
  ).decode(bytes);
}

function validatedFeedUrl(originValue: string, rssSlug: string): string {
  const origin = new URL(originValue);
  if (
    origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
  ) {
    throw new PublicFeedValidationError(
      "The canonical feed origin is invalid.",
      "feed_origin_invalid"
    );
  }
  return new URL(
    `/${encodeURIComponent(rssSlug)}/rss.xml`,
    `${origin.origin}/`
  ).toString();
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
