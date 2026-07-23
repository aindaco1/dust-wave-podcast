import { sha256Hex } from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";

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
  title: string;
  summary: string;
  guid: string;
  public_at: string;
  canonical_url: string;
  duration_seconds: number;
  audio_mime_type: string;
  audio_bytes: number;
  audio_filename: string | null;
  explicit: number;
  season_number: number | null;
  episode_number: number | null;
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
         id, title, summary, guid, public_at, canonical_url, duration_seconds,
         audio_mime_type, audio_bytes, audio_filename, explicit,
         season_number, episode_number
       FROM episodes
       WHERE show_id = ?
         AND status = 'published'
         AND public_at <= datetime('now')
         AND access IN ('public', 'early_access', 'free_mini')
         AND media_status = 'ready'
         AND audio_key IS NOT NULL
         AND guid IS NOT NULL
       ORDER BY public_at DESC, created_at DESC`
    )
    .bind(show.id)
    .all<FeedEpisode>();
  const feedUrl = `${env.FEED_ORIGIN.replace(/\/$/, "")}/${show.rss_slug}/rss.xml`;
  const ownerEmail = env.PODCAST_OWNER_EMAIL || "podcasts@dustwave.xyz";
  const authorName = env.PODCAST_AUTHOR_NAME || show.author_name;
  const items = episodes.results.map((episode) => renderEpisode(episode, env)).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
  const etag = `"${await sha256Hex(xml)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: publicFeedHeaders(etag)
    });
  }
  return new Response(request.method === "HEAD" ? null : xml, {
    headers: publicFeedHeaders(etag)
  });
}

function renderEpisode(episode: FeedEpisode, env: PodcastEnv): string {
  const enclosureUrl = `${env.MEDIA_ORIGIN.replace(/\/$/, "")}/episodes/${episode.id}/audio`;
  return `<item>
      <title>${escapeXml(episode.title)}</title>
      <description>${escapeXml(episode.summary)}</description>
      <content:encoded><![CDATA[${safeCdata(episode.summary)}]]></content:encoded>
      <link>${escapeXml(episode.canonical_url)}</link>
      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>
      <pubDate>${new Date(episode.public_at).toUTCString()}</pubDate>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${episode.audio_bytes}" type="${escapeXml(episode.audio_mime_type)}"/>
      <itunes:duration>${episode.duration_seconds}</itunes:duration>
      <itunes:explicit>${episode.explicit === 1 ? "true" : "false"}</itunes:explicit>
      ${episode.season_number ? `<itunes:season>${episode.season_number}</itunes:season>` : ""}
      ${episode.episode_number ? `<itunes:episode>${episode.episode_number}</itunes:episode>` : ""}
    </item>`;
}

function publicFeedHeaders(etag: string): Headers {
  return new Headers({
    "content-type": "application/rss+xml; charset=utf-8",
    "cache-control": "public, max-age=60, stale-while-revalidate=300",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    etag
  });
}

function xmlError(code: string, status: number): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(code)}</error>`,
    {
      status,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
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
