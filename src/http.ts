const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

function corsHeaders(
  request: Request,
  allowedOrigins: string,
  { credentials = false } = {}
): HeadersInit {
  const origin = trustedAllowedOrigin(request, allowedOrigins);
  if (!origin) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,if-none-match,if-range,range,x-podcast-csrf,x-podcast-upload-bytes,x-turnstile-token",
    "access-control-max-age": "86400",
    ...(credentials ? { "access-control-allow-credentials": "true" } : {}),
    vary: "Origin"
  };
}

export function trustedAllowedOrigin(
  request: Request,
  allowedOrigins: string
): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = new Set(
    allowedOrigins
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return allowed.has(origin) ? origin : null;
}

export function privateCorsHeaders(
  request: Request,
  allowedOrigins: string
): HeadersInit {
  return corsHeaders(request, allowedOrigins, { credentials: true });
}

export function json(
  request: Request,
  allowedOrigins: string,
  body: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers({
    ...JSON_HEADERS,
    ...corsHeaders(request, allowedOrigins),
    ...init.headers
  });

  return new Response(JSON.stringify(body), { ...init, headers });
}

export function privateJson(
  request: Request,
  allowedOrigins: string,
  body: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers({
    ...JSON_HEADERS,
    ...privateCorsHeaders(request, allowedOrigins),
    ...init.headers
  });
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function options(
  request: Request,
  allowedOrigins: string,
  { credentials = true } = {}
): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, allowedOrigins, { credentials })
  });
}
