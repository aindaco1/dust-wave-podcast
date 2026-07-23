const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function corsHeaders(request: Request, allowedOrigins: string): HeadersInit {
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
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
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

export function options(request: Request, allowedOrigins: string): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, allowedOrigins)
  });
}

