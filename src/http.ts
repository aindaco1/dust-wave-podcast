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
  const origin = request.headers.get("origin");
  const allowed = new Set(
    allowedOrigins
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

  if (!origin || !allowed.has(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,x-podcast-csrf,x-podcast-upload-bytes,x-turnstile-token",
    "access-control-max-age": "86400",
    ...(credentials ? { "access-control-allow-credentials": "true" } : {}),
    vary: "Origin"
  };
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
    ...corsHeaders(request, allowedOrigins, { credentials: true }),
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
