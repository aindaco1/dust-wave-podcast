import type { PodcastEnv } from "./env";

type PublicMediaEpisode = {
  audio_key: string;
  audio_bytes: number;
  audio_mime_type: string;
  audio_filename: string | null;
  audio_etag: string | null;
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
    .first<PublicMediaEpisode>();
  if (!episode) return mediaError("media_not_found", 404);

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && episode.audio_etag && ifNoneMatch === episode.audio_etag) {
    return new Response(null, {
      status: 304,
      headers: publicMediaHeaders(episode)
    });
  }
  if (request.method === "HEAD") {
    const object = await env.MEDIA_BUCKET.head(episode.audio_key);
    if (!object) return mediaError("media_not_found", 404);
    const headers = publicMediaHeaders(episode);
    object.writeHttpMetadata(headers);
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
        "cache-control": "no-store"
      }
    });
  }
  const object = await env.MEDIA_BUCKET.get(episode.audio_key, {
    ...(range ? { range } : {})
  });
  if (!object) return mediaError("media_not_found", 404);

  const headers = publicMediaHeaders(episode);
  object.writeHttpMetadata(headers);
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

function publicMediaHeaders(episode: PublicMediaEpisode): Headers {
  return new Headers({
    "content-type": episode.audio_mime_type,
    "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges,content-length,content-range,etag",
    "x-content-type-options": "nosniff",
    ...(episode.audio_etag ? { etag: episode.audio_etag } : {})
  });
}

function mediaError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function safeDownloadFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180);
}
