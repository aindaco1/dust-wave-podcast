import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import {
  hashPrivateFeedToken,
  privateFeedTokenNeedsTouch,
  touchPrivateFeedToken
} from "./private-feeds";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  loadVerifiedApprovedTranscriptLanguagesByEpisode
} from "./transcripts";

type FeedShow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  language: string;
  artwork_url: string | null;
  canonical_url: string;
  rss_slug: string;
  author_name: string;
  category: string;
  explicit: number;
};

type FeedEpisode = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  guid: string;
  release_at: string;
  canonical_url: string;
  duration_seconds: number;
  audio_mime_type: string;
  audio_bytes: number;
  audio_filename: string | null;
  explicit: number;
  season_number: number | null;
  episode_number: number | null;
  has_approved_chapters: number;
  approvedTranscriptLanguages: Array<"en" | "es">;
};

type FeedEpisodeRow = Omit<FeedEpisode, "approvedTranscriptLanguages">;

type PrivateFeedShow = FeedShow & {
  last_used_at: string | null;
};

export async function servePublicFeed(
  request: Request,
  env: PodcastEnv,
  rssSlug: string
): Promise<Response> {
  const show = await env.DB
    .prepare(
      `SELECT
         id, slug, title, description, language, artwork_url, canonical_url,
         rss_slug, author_name, category, explicit
       FROM shows
       WHERE rss_slug = ? AND status != 'archived'`
    )
    .bind(rssSlug)
    .first<FeedShow>();
  if (!show) return xmlError("feed_not_found", 404);
  const episodes = await env.DB
    .prepare(
      `SELECT
         episode.id, episode.slug, episode.title, episode.summary, episode.guid,
         episode.public_at AS release_at, episode.canonical_url,
         episode.duration_seconds, episode.audio_mime_type,
         episode.audio_bytes, episode.audio_filename, episode.explicit,
         episode.season_number, episode.episode_number,
         EXISTS (
           SELECT 1
           FROM episode_chapter_approvals approval
           WHERE approval.episode_id = episode.id
         ) AS has_approved_chapters
       FROM episodes episode
       WHERE episode.show_id = ?
         AND episode.status = 'published'
         AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
         AND episode.access IN ('public', 'early_access', 'free_mini')
         AND episode.media_status = 'ready'
         AND episode.audio_key IS NOT NULL
         AND episode.guid IS NOT NULL
       ORDER BY episode.public_at DESC, episode.created_at DESC`
    )
    .bind(show.id)
    .all<FeedEpisodeRow>();
  const feedEpisodes = await attachVerifiedTranscriptLanguages(
    env.DB,
    episodes.results
  );
  const feedUrl = `${env.FEED_ORIGIN.replace(/\/$/, "")}/${show.rss_slug}/rss.xml`;
  return feedResponse(
    request,
    renderFeed(
      show,
      feedEpisodes,
      feedUrl,
      env,
      (episode) =>
        `${env.MEDIA_ORIGIN.replace(/\/$/, "")}/episodes/${episode.id}/audio`,
      (episode) => episode.has_approved_chapters === 1
        ? `${env.FEED_ORIGIN.replace(/\/$/, "")}/v1/shows/${show.slug}`
          + `/episodes/${episode.slug}/chapters.json`
        : null,
      (episode, language) =>
        `${env.FEED_ORIGIN.replace(/\/$/, "")}/v1/shows/${show.slug}`
          + `/episodes/${episode.slug}/transcripts/${language}.vtt`
    ),
    "public"
  );
}

export async function servePrivateFeed(
  request: Request,
  env: PodcastEnv,
  rawToken: string,
  rssSlug: string
): Promise<Response> {
  if (!env.FEED_TOKEN_PEPPER) return xmlError("feed_not_found", 404);
  const tokenHash = await hashPrivateFeedToken(
    rawToken,
    env.FEED_TOKEN_PEPPER
  );
  const show = await env.DB
    .prepare(
      `SELECT
         sh.id, sh.slug, sh.title, sh.description, sh.language,
         sh.artwork_url, sh.canonical_url, sh.rss_slug, sh.author_name,
         sh.category, sh.explicit, f.last_used_at
       FROM private_feed_tokens f
       JOIN subscriptions s
         ON s.listener_id = f.listener_id
        AND s.show_id = f.show_id
       JOIN shows sh ON sh.id = f.show_id
       WHERE f.token_hash = ?
         AND f.revoked_at IS NULL
         AND sh.rss_slug = ?
         AND sh.status != 'archived'
         AND s.status = 'active'
         AND (
           s.current_period_end IS NULL
           OR s.current_period_end > ${SQL_UTC_NOW_RFC3339}
         )
       LIMIT 1`
    )
    .bind(tokenHash, rssSlug)
    .first<PrivateFeedShow>();
  if (!show) return xmlError("feed_not_found", 404);

  const episodes = await env.DB
    .prepare(
      `SELECT
         episode.id, episode.slug, episode.title, episode.summary, episode.guid,
         CASE
           WHEN episode.access IN ('early_access', 'premium_bonus')
             THEN COALESCE(episode.premium_at, episode.public_at)
           ELSE episode.public_at
         END AS release_at,
         episode.canonical_url, episode.duration_seconds,
         episode.audio_mime_type, episode.audio_bytes, episode.audio_filename,
         episode.explicit, episode.season_number, episode.episode_number,
         EXISTS (
           SELECT 1
           FROM episode_chapter_approvals approval
           WHERE approval.episode_id = episode.id
         ) AS has_approved_chapters
       FROM episodes episode
       WHERE episode.show_id = ?
         AND episode.status IN ('scheduled', 'published')
         AND episode.media_status = 'ready'
         AND episode.audio_key IS NOT NULL
         AND episode.guid IS NOT NULL
         AND (
           (
             episode.access IN ('public', 'free_mini')
             AND episode.public_at <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             episode.access = 'early_access'
             AND COALESCE(episode.premium_at, episode.public_at)
               <= ${SQL_UTC_NOW_RFC3339}
           )
           OR (
             episode.access = 'premium_bonus'
             AND episode.premium_at <= ${SQL_UTC_NOW_RFC3339}
           )
         )
       ORDER BY release_at DESC, episode.created_at DESC`
    )
    .bind(show.id)
    .all<FeedEpisodeRow>();
  const feedEpisodes = await attachVerifiedTranscriptLanguages(
    env.DB,
    episodes.results
  );
  if (privateFeedTokenNeedsTouch(show.last_used_at)) {
    await touchPrivateFeedToken(env.DB, tokenHash);
  }

  const feedUrl = `${
    env.FEED_ORIGIN.replace(/\/$/, "")
  }/v1/private/${rawToken}/${show.rss_slug}/rss.xml`;
  return feedResponse(
    request,
    renderFeed(
      show,
      feedEpisodes,
      feedUrl,
      env,
      (episode) =>
        `${
          env.MEDIA_ORIGIN.replace(/\/$/, "")
        }/v1/private/${rawToken}/episodes/${episode.id}/audio`,
      (episode) => episode.has_approved_chapters === 1
        ? `${env.FEED_ORIGIN.replace(/\/$/, "")}/v1/private/${rawToken}/`
          + `${show.rss_slug}/episodes/${episode.slug}/chapters.json`
        : null,
      (episode, language) =>
        `${env.FEED_ORIGIN.replace(/\/$/, "")}/v1/private/${rawToken}/`
          + `${show.rss_slug}/episodes/${episode.slug}/transcripts/`
          + `${language}.vtt`
    ),
    "private"
  );
}

function renderFeed(
  show: FeedShow,
  episodes: FeedEpisode[],
  feedUrl: string,
  env: PodcastEnv,
  enclosureUrl: (episode: FeedEpisode) => string,
  chapterUrl: (episode: FeedEpisode) => string | null,
  transcriptUrl: (
    episode: FeedEpisode,
    language: "en" | "es"
  ) => string
): string {
  const ownerEmail = env.PODCAST_OWNER_EMAIL || "podcasts@dustwave.xyz";
  const authorName = env.PODCAST_AUTHOR_NAME || show.author_name;
  const items = episodes
    .map((episode) =>
      renderEpisode(
        episode,
        enclosureUrl(episode),
        chapterUrl(episode),
        transcriptUrl
      )
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>${escapeXml(show.title)}</title>
    <link>${escapeXml(show.canonical_url)}</link>
    <description>${escapeXml(show.description)}</description>
    <language>${escapeXml(show.language)}</language>
    <generator>Dust Wave Podcasts</generator>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <itunes:author>${escapeXml(authorName)}</itunes:author>
    <itunes:summary>${escapeXml(show.description)}</itunes:summary>
    <itunes:explicit>${show.explicit === 1 ? "true" : "false"}</itunes:explicit>
    <itunes:category text="${escapeXml(show.category)}"/>
    <itunes:owner>
      <itunes:name>${escapeXml(authorName)}</itunes:name>
      <itunes:email>${escapeXml(ownerEmail)}</itunes:email>
    </itunes:owner>
    ${show.artwork_url ? `<itunes:image href="${escapeXml(show.artwork_url)}"/>` : ""}
    <podcast:locked owner="${escapeXml(ownerEmail)}">yes</podcast:locked>
    ${items}
  </channel>
</rss>`;
}

async function feedResponse(
  request: Request,
  xml: string,
  visibility: "public" | "private"
): Promise<Response> {
  const etag = `"${await sha256Hex(xml)}"`;
  const headers = feedHeaders(etag, visibility);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers
    });
  }
  return new Response(request.method === "HEAD" ? null : xml, {
    headers
  });
}

function renderEpisode(
  episode: FeedEpisode,
  enclosureUrl: string,
  chapterUrl: string | null,
  transcriptUrl: (
    episode: FeedEpisode,
    language: "en" | "es"
  ) => string
): string {
  const transcriptTags = approvedTranscriptLanguages(episode)
    .map((language) =>
      `<podcast:transcript url="${
        escapeXml(transcriptUrl(episode, language))
      }" type="text/vtt" language="${language}"/>`
    )
    .join("\n      ");
  return `<item>
      <title>${escapeXml(episode.title)}</title>
      <description>${escapeXml(episode.summary)}</description>
      <content:encoded><![CDATA[${safeCdata(episode.summary)}]]></content:encoded>
      <link>${escapeXml(episode.canonical_url)}</link>
      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>
      <pubDate>${new Date(episode.release_at).toUTCString()}</pubDate>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${episode.audio_bytes}" type="${escapeXml(episode.audio_mime_type)}"/>
      <itunes:duration>${episode.duration_seconds}</itunes:duration>
      <itunes:explicit>${episode.explicit === 1 ? "true" : "false"}</itunes:explicit>
      ${episode.season_number ? `<itunes:season>${episode.season_number}</itunes:season>` : ""}
      ${episode.episode_number ? `<itunes:episode>${episode.episode_number}</itunes:episode>` : ""}
      ${chapterUrl ? `<podcast:chapters url="${escapeXml(chapterUrl)}" type="application/json+chapters"/>` : ""}
      ${transcriptTags}
    </item>`;
}

function approvedTranscriptLanguages(
  episode: FeedEpisode
): Array<"en" | "es"> {
  const available = new Set(episode.approvedTranscriptLanguages);
  return (["en", "es"] as const).filter((language) =>
    available.has(language)
  );
}

async function attachVerifiedTranscriptLanguages(
  db: D1Database,
  episodes: FeedEpisodeRow[]
): Promise<FeedEpisode[]> {
  const languages = await loadVerifiedApprovedTranscriptLanguagesByEpisode(
    db,
    episodes.map(({ id }) => id)
  );
  return episodes.map((episode) => ({
    ...episode,
    approvedTranscriptLanguages: languages.get(episode.id) ?? []
  }));
}

function feedHeaders(
  etag: string,
  visibility: "public" | "private"
): Headers {
  const headers = new Headers({
    "content-type": "application/rss+xml; charset=utf-8",
    "cache-control": visibility === "public"
      ? "public, max-age=60, stale-while-revalidate=300"
      : "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag
  });
  if (visibility === "public") {
    headers.set("access-control-allow-origin", "*");
  } else {
    headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  }
  return headers;
}

function xmlError(code: string, status: number): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(code)}</error>`,
    {
      status,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow, noarchive"
      }
    }
  );
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeCdata(value: unknown): string {
  return String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>");
}
