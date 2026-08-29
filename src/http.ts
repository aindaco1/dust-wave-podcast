import { createCorsJsonHelpers } from "@dustwave/worker-core/http";

import type { PodcastEnv } from "./env";

const helpers = createCorsJsonHelpers({
  allowedMethods: "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders:
    "content-type,if-none-match,if-range,range,x-podcast-csrf,x-podcast-upload-bytes,x-turnstile-token",
  accessControlMaxAge: "86400",
  jsonHeaders: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  },
  privateHeaders: {
    "cache-control": "private, no-store, max-age=0",
    "x-robots-tag": "noindex, nofollow, noarchive"
  }
});

export const {
  json,
  options,
  privateJson,
  trustedAllowedOrigin
} = helpers;

export function privateCorsHeaders(
  request: Request,
  allowedOrigins: string
): HeadersInit {
  return helpers.corsHeaders(request, allowedOrigins, { credentials: true });
}

export function privateAudioHeaders(
  request: Request,
  allowedOrigins: string,
  etag: string
): Headers {
  const headers = new Headers({
    ...privateCorsHeaders(request, allowedOrigins),
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store, max-age=0",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-site",
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  headers.set(
    "access-control-expose-headers",
    "accept-ranges,content-disposition,content-length,content-range,etag"
  );
  return headers;
}

export function privateConflict(
  request: Request,
  env: PodcastEnv,
  error: string,
  detail: Record<string, unknown> = {}
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error, ...detail },
    { status: 409 }
  );
}

export function privateNotFound(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "not_found" },
    { status: 404 }
  );
}

export function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*"
      || value === etag
      || (value.startsWith("W/") && value.slice(2) === etag);
  });
}
