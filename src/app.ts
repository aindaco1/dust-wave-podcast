import {
  createAdminEpisode,
  listAdminEpisodes,
  listAdminShows,
  listDistributionDestinations,
  publishAdminEpisode,
  updateAdminEpisode,
  updateAdminShow
} from "./admin";
import {
  exchangeAdminLogin,
  getAdminSession,
  logoutAdmin,
  startAdminLogin
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { getBillingReadiness, handleStripeWebhook } from "./billing";
import { servePublicFeed } from "./feed";
import { json, options, privateJson } from "./http";
import { servePublicEpisodeAudio } from "./media";
import { getPublicShow, listPublicShows } from "./shows";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  uploadMultipartPart
} from "./uploads";
import { readJsonObject, RequestValidationError } from "./validation";

const SHOW_PATH = /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const FEED_PATH = /^\/(?:v1\/feeds\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
const MEDIA_PATH = /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)(?:\/audio)?$/;
const ADMIN_SHOW_PATH = /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)$/;
const ADMIN_SHOW_EPISODES_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/episodes$/;
const ADMIN_EPISODE_PATH = /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_PUBLISH_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/publish$/;
const ADMIN_EPISODE_DISTRIBUTION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution$/;
const ADMIN_UPLOAD_PART_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/parts\/(\d+)$/;
const ADMIN_UPLOAD_COMPLETE_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/complete$/;
const ADMIN_UPLOAD_PATH = /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)$/;

export async function handleRequest(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    throw error;
  }
}

async function routeRequest(request: Request, env: PodcastEnv): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (method === "OPTIONS") {
    return options(request, env.ALLOWED_ORIGINS);
  }

  if (url.pathname === "/health" && (method === "GET" || method === "HEAD")) {
    return json(request, env.ALLOWED_ORIGINS, {
      ok: true,
      service: "dust-wave-podcast",
      environment: env.ENVIRONMENT
    });
  }

  if (
    (url.pathname === "/v1/shows" || url.pathname === "/v1/shows/")
    && (method === "GET" || method === "HEAD")
  ) {
    const shows = await listPublicShows(env.DB);
    return json(request, env.ALLOWED_ORIGINS, { shows });
  }

  const showMatch = url.pathname.match(SHOW_PATH);
  if (showMatch && (method === "GET" || method === "HEAD")) {
    const show = await getPublicShow(env.DB, showMatch[1]);
    if (!show) {
      return json(
        request,
        env.ALLOWED_ORIGINS,
        { error: "show_not_found" },
        { status: 404 }
      );
    }
    return json(request, env.ALLOWED_ORIGINS, { show });
  }

  const feedMatch = url.pathname.match(FEED_PATH);
  if (feedMatch && (method === "GET" || method === "HEAD")) {
    return servePublicFeed(request, env, feedMatch[1]);
  }

  const mediaMatch = url.pathname.match(MEDIA_PATH);
  if (mediaMatch && (method === "GET" || method === "HEAD")) {
    return servePublicEpisodeAudio(request, env, mediaMatch[1]);
  }

  if (url.pathname === "/v1/admin/auth/start" && method === "POST") {
    return startAdminLogin(request, env, await readJsonObject(request));
  }
  if (url.pathname === "/v1/admin/auth/exchange" && method === "POST") {
    return exchangeAdminLogin(request, env, await readJsonObject(request));
  }
  if (url.pathname === "/v1/admin/session" && method === "GET") {
    return getAdminSession(request, env);
  }
  if (url.pathname === "/v1/admin/logout" && method === "POST") {
    return logoutAdmin(request, env);
  }
  if (url.pathname === "/v1/admin/shows" && method === "GET") {
    return listAdminShows(request, env);
  }
  if (url.pathname === "/v1/admin/distribution" && method === "GET") {
    return listDistributionDestinations(request, env);
  }
  if (url.pathname === "/v1/admin/billing/readiness" && method === "GET") {
    return getBillingReadiness(request, env);
  }
  if (url.pathname === "/v1/webhooks/stripe" && method === "POST") {
    return handleStripeWebhook(request, env);
  }

  const adminShowEpisodesMatch = url.pathname.match(ADMIN_SHOW_EPISODES_PATH);
  if (adminShowEpisodesMatch) {
    if (method === "GET") {
      return listAdminEpisodes(request, env, adminShowEpisodesMatch[1]);
    }
    if (method === "POST") {
      return createAdminEpisode(request, env, adminShowEpisodesMatch[1]);
    }
  }
  const adminShowMatch = url.pathname.match(ADMIN_SHOW_PATH);
  if (adminShowMatch && method === "PATCH") {
    return updateAdminShow(request, env, adminShowMatch[1]);
  }
  const adminEpisodePublishMatch = url.pathname.match(ADMIN_EPISODE_PUBLISH_PATH);
  if (adminEpisodePublishMatch && method === "POST") {
    return publishAdminEpisode(request, env, adminEpisodePublishMatch[1]);
  }
  const adminEpisodeDistributionMatch = url.pathname.match(
    ADMIN_EPISODE_DISTRIBUTION_PATH
  );
  if (adminEpisodeDistributionMatch && method === "GET") {
    return listDistributionDestinations(
      request,
      env,
      adminEpisodeDistributionMatch[1]
    );
  }
  const adminEpisodeMatch = url.pathname.match(ADMIN_EPISODE_PATH);
  if (adminEpisodeMatch && method === "PATCH") {
    return updateAdminEpisode(request, env, adminEpisodeMatch[1]);
  }

  if (url.pathname === "/v1/admin/uploads" && method === "POST") {
    return createMultipartUpload(request, env);
  }
  const uploadPartMatch = url.pathname.match(ADMIN_UPLOAD_PART_PATH);
  if (uploadPartMatch && method === "PUT") {
    return uploadMultipartPart(
      request,
      env,
      uploadPartMatch[1],
      uploadPartMatch[2]
    );
  }
  const uploadCompleteMatch = url.pathname.match(ADMIN_UPLOAD_COMPLETE_PATH);
  if (uploadCompleteMatch && method === "POST") {
    return completeMultipartUpload(request, env, uploadCompleteMatch[1]);
  }
  const uploadMatch = url.pathname.match(ADMIN_UPLOAD_PATH);
  if (uploadMatch && method === "DELETE") {
    return abortMultipartUpload(request, env, uploadMatch[1]);
  }

  const knownPath = url.pathname === "/health"
    || url.pathname.startsWith("/v1/shows")
    || url.pathname.startsWith("/v1/admin")
    || Boolean(feedMatch)
    || Boolean(mediaMatch);
  return json(
    request,
    env.ALLOWED_ORIGINS,
    { error: knownPath ? "method_not_allowed" : "not_found" },
    { status: knownPath ? 405 : 404 }
  );
}
