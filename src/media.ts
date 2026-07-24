import type { PodcastEnv } from "./env";
import {
  hashPrivateFeedToken,
  privateFeedTokenNeedsTouch,
  touchPrivateFeedToken
} from "./private-feeds";

type MediaEpisode = {
  audio_key: string;
  audio_bytes: number;
  audio_mime_type: string;
  audio_filename: string | null;
  audio_etag: string | null;
};

type PrivateMediaEpisode = MediaEpisode & {
  last_used_at: string | null;
};

export async function servePublicEpisodeAudio(
  request: Request,
  env: PodcastEnv,
  episodeId: string
): Promise<Response> {
  const episode = await env.DB
    .prepare(
      `SELECT
         audio_key, audio_bytes, audio_mime_type, audio_filename, audio_etag
       FROM episodes
       WHERE id = ?
         AND status = 'published'
         AND public_at <= datetime('now')
         AND access IN ('public', 'early_access', 'free_mini')
         AND media_status = 'ready'
         AND audio_key IS NOT NULL`
    )
    .bind(episodeId)
    .first<MediaEpisode>();
  if (!episode) return mediaError("media_not_found", 404);
  return serveEpisodeAudio(request, env, episode, episodeId, "public");
}

export async function servePrivateEpisodeAudio(
  request: Request,
  env: PodcastEnv,
  rawToken: string,
  episodeId: string
): Promise<Response> {
  if (!env.FEED_TOKEN_PEPPER) return mediaError("media_not_found", 404);
  const tokenHash = await hashPrivateFeedToken(
    rawToken,
    env.FEED_TOKEN_PEPPER
  );
  const episode = await env.DB
    .prepare(
      `SELECT
         e.audio_key, e.audio_bytes, e.audio_mime_type, e.audio_filename,
         e.audio_etag, f.last_used_at
       FROM private_feed_tokens f
       JOIN subscriptions s
         ON s.listener_id = f.listener_id
        AND s.show_id = f.show_id
       JOIN episodes e
         ON e.id = ?
        AND e.show_id = f.show_id
       WHERE f.token_hash = ?
         AND f.revoked_at IS NULL
         AND s.status = 'active'
         AND (
           s.current_period_end IS NULL
           OR s.current_period_end > datetime('now')
         )
         AND e.status IN ('scheduled', 'published')
         AND e.media_status = 'ready'
         AND e.audio_key IS NOT NULL
         AND (
           (
             e.access IN ('public', 'free_mini')
             AND e.public_at <= datetime('now')
           )
           OR (
             e.access = 'early_access'
             AND COALESCE(e.premium_at, e.public_at) <= datetime('now')
           )
           OR (
             e.access = 'premium_bonus'
             AND e.premium_at <= datetime('now')
           )
         )
       LIMIT 1`
    )
    .bind(episodeId, tokenHash)
    .first<PrivateMediaEpisode>();
  if (!episode) return mediaError("media_not_found", 404);
  if (privateFeedTokenNeedsTouch(episode.last_used_at)) {
    await touchPrivateFeedToken(env.DB, tokenHash);
  }
  return serveEpisodeAudio(request, env, episode, episodeId, "private");
}

async function serveEpisodeAudio(
  request: Request,
  env: PodcastEnv,
  episode: MediaEpisode,
  episodeId: string,
  visibility: "public" | "private"
): Promise<Response> {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && episode.audio_etag && ifNoneMatch === episode.audio_etag) {
    return new Response(null, {
      status: 304,
      headers: mediaHeaders(episode, visibility)
    });
  }
  if (request.method === "HEAD") {
    const object = await env.MEDIA_BUCKET.head(episode.audio_key);
    if (!object) return mediaError("media_not_found", 404);
    const headers = mediaHeaders(episode, visibility);
    object.writeHttpMetadata(headers);
    enforceMediaPolicy(headers, visibility);
    headers.set("content-length", String(object.size));
    headers.set("etag", object.httpEtag);
    return new Response(null, { headers });
  }

  const range = parseRange(request.headers.get("range"), episode.audio_bytes);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${episode.audio_bytes}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }
  const object = await env.MEDIA_BUCKET.get(episode.audio_key, {
    ...(range ? { range } : {})
  });
  if (!object) return mediaError("media_not_found", 404);

  const headers = mediaHeaders(episode, visibility);
  object.writeHttpMetadata(headers);
  enforceMediaPolicy(headers, visibility);
  headers.set("etag", object.httpEtag);
  if (new URL(request.url).searchParams.get("download") === "1") {
    headers.set(
      "content-disposition",
      `attachment; filename="${safeDownloadFilename(episode.audio_filename || `${episodeId}.mp3`)}"`
    );
  }
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-length", String(length));
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${episode.audio_bytes}`
    );
  } else {
    headers.set("content-length", String(episode.audio_bytes));
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers
  });
}

function parseRange(header: string | null, totalBytes: number): R2Range | "invalid" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { suffix: Math.min(suffix, totalBytes) };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || start >= totalBytes
    || end < start
  ) {
    return "invalid";
  }
  return {
    offset: start,
    length: Math.min(end, totalBytes - 1) - start + 1
  };
}

function mediaHeaders(
  episode: MediaEpisode,
  visibility: "public" | "private"
): Headers {
  const headers = new Headers({
    "content-type": episode.audio_mime_type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(episode.audio_etag ? { etag: episode.audio_etag } : {})
  });
  enforceMediaPolicy(headers, visibility);
  return headers;
}

function enforceMediaPolicy(
  headers: Headers,
  visibility: "public" | "private"
): void {
  if (visibility === "public") {
    headers.set(
      "cache-control",
      "public, max-age=300, stale-while-revalidate=3600"
    );
    headers.set("access-control-allow-origin", "*");
    headers.set(
      "access-control-expose-headers",
      "accept-ranges,content-length,content-range,etag"
    );
    headers.delete("x-robots-tag");
    return;
  }
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-expose-headers");
}

function mediaError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow, noarchive"
    }
  });
}

function safeDownloadFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180);
}
