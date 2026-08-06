import { createCorsJsonHelpers } from "@dustwave/worker-core/http";

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
