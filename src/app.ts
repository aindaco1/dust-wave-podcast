import { json, options } from "./http";
import { getPublicShow, listPublicShows } from "./shows";

const SHOW_PATH = /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return options(request, env.ALLOWED_ORIGINS);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(request, env.ALLOWED_ORIGINS, { error: "method_not_allowed" }, { status: 405 });
  }

  if (url.pathname === "/health") {
    return json(request, env.ALLOWED_ORIGINS, {
      ok: true,
      service: "dust-wave-podcast",
      environment: env.ENVIRONMENT
    });
  }

  if (url.pathname === "/v1/shows" || url.pathname === "/v1/shows/") {
    const shows = await listPublicShows(env.DB);
    return json(request, env.ALLOWED_ORIGINS, { shows });
  }

  const showMatch = url.pathname.match(SHOW_PATH);
  if (showMatch) {
    const show = await getPublicShow(env.DB, showMatch[1]);
    if (!show) {
      return json(request, env.ALLOWED_ORIGINS, { error: "show_not_found" }, { status: 404 });
    }
    return json(request, env.ALLOWED_ORIGINS, { show });
  }

  return json(request, env.ALLOWED_ORIGINS, { error: "not_found" }, { status: 404 });
}

