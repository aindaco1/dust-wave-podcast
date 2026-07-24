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
  getAdminAdQualificationReconciliation
} from "./ad-reporting";
import {
  exchangeAdminLogin,
  getAdminSession,
  logoutAdmin,
  startAdminLogin
} from "./admin-auth";
import {
  approveAdminAdCampaign,
  createAdminAdCampaign,
  killAdminAdCampaign,
  listAdminAdCampaigns,
  updateAdminAdCampaign
} from "./ad-campaigns";
import {
  createAdminAdCreative,
  uploadAdminAdCreativeAudio,
  validateAdminAdCreative
} from "./ad-creatives";
import {
  approveAdminEpisodeAdPlan,
  completeEpisodeAdPlanProcessing,
  getAdminEpisodeAdPlan,
  rejectAdminEpisodeAdPlan,
  submitAdminEpisodeAdPlan
} from "./ad-plans";
import {
  issueAdminStagingAdDecision,
  recordTrustedAdQualificationCallback,
  serveStagingAdDecisionAudio
} from "./ad-runtime";
import { previewAdminAdDecision } from "./ads";
import type { PodcastEnv } from "./env";
import { getBillingReadiness, handleStripeWebhook } from "./billing";
import {
  serveStagingVirtualAudioDiagnostic,
  serveStagingVirtualAudioPlayer
} from "./diagnostics";
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
const ADMIN_EPISODE_AD_PLAN_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/ad-plan$/;
const ADMIN_UPLOAD_PART_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/parts\/(\d+)$/;
const ADMIN_UPLOAD_COMPLETE_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/complete$/;
const ADMIN_UPLOAD_PATH = /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)$/;
const ADMIN_AD_CAMPAIGN_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)$/;
const ADMIN_AD_CAMPAIGN_APPROVE_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_AD_CAMPAIGN_KILL_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/kill$/;
const ADMIN_AD_CAMPAIGN_CREATIVES_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/creatives$/;
const ADMIN_AD_CREATIVE_AUDIO_PATH =
  /^\/v1\/admin\/ads\/creatives\/([A-Za-z0-9_-]+)\/audio$/;
const ADMIN_AD_CREATIVE_VALIDATE_PATH =
  /^\/v1\/admin\/ads\/creatives\/([A-Za-z0-9_-]+)\/validate$/;
const ADMIN_AD_PLAN_APPROVE_PATH =
  /^\/v1\/admin\/ads\/plans\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_AD_PLAN_REJECT_PATH =
  /^\/v1\/admin\/ads\/plans\/([A-Za-z0-9_-]+)\/reject$/;
const PROCESSOR_AD_PLAN_COMPLETE_PATH =
  /^\/v1\/processor\/ad-plans\/([A-Za-z0-9_-]+)\/complete$/;
const AD_DECISION_AUDIO_PATH =
  /^\/v1\/ads\/decisions\/([A-Za-z0-9_-]+)\/audio$/;
const VIRTUAL_AUDIO_DIAGNOSTIC_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_-]{32,128})(?:\/(virtual|baseline))?$/;

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
  const adDecisionAudioMatch = url.pathname.match(AD_DECISION_AUDIO_PATH);
  if (
    adDecisionAudioMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveStagingAdDecisionAudio(
      request,
      env,
      adDecisionAudioMatch[1]
    );
  }

  if (
    url.pathname === "/v1/diagnostics/virtual-audio/player"
    && (method === "GET" || method === "HEAD")
  ) {
    return serveStagingVirtualAudioPlayer(env);
  }
  const virtualAudioDiagnosticMatch = url.pathname.match(
    VIRTUAL_AUDIO_DIAGNOSTIC_PATH
  );
  if (
    virtualAudioDiagnosticMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveStagingVirtualAudioDiagnostic(
      request,
      env,
      virtualAudioDiagnosticMatch[1],
      virtualAudioDiagnosticMatch[2] === "baseline"
        ? "baseline"
        : "virtual"
    );
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
  if (url.pathname === "/v1/admin/ads/preview" && method === "POST") {
    return previewAdminAdDecision(request, env);
  }
  if (
    url.pathname === "/v1/admin/ads/decisions/issue"
    && method === "POST"
  ) {
    return issueAdminStagingAdDecision(request, env);
  }
  if (
    url.pathname === "/v1/admin/ads/reconciliation"
    && method === "GET"
  ) {
    return getAdminAdQualificationReconciliation(request, env);
  }
  if (url.pathname === "/v1/admin/ads/campaigns") {
    if (method === "GET") return listAdminAdCampaigns(request, env);
    if (method === "POST") return createAdminAdCampaign(request, env);
  }
  if (url.pathname === "/v1/webhooks/stripe" && method === "POST") {
    return handleStripeWebhook(request, env);
  }
  if (
    url.pathname === "/v1/internal/ad-qualifications"
    && method === "POST"
  ) {
    return recordTrustedAdQualificationCallback(request, env);
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
  const adminEpisodeAdPlanMatch = url.pathname.match(
    ADMIN_EPISODE_AD_PLAN_PATH
  );
  if (adminEpisodeAdPlanMatch) {
    if (method === "GET") {
      return getAdminEpisodeAdPlan(request, env, adminEpisodeAdPlanMatch[1]);
    }
    if (method === "POST") {
      return submitAdminEpisodeAdPlan(
        request,
        env,
        adminEpisodeAdPlanMatch[1]
      );
    }
  }
  const adminEpisodeMatch = url.pathname.match(ADMIN_EPISODE_PATH);
  if (adminEpisodeMatch && method === "PATCH") {
    return updateAdminEpisode(request, env, adminEpisodeMatch[1]);
  }
  const adminAdCampaignApproveMatch = url.pathname.match(
    ADMIN_AD_CAMPAIGN_APPROVE_PATH
  );
  if (adminAdCampaignApproveMatch && method === "POST") {
    return approveAdminAdCampaign(
      request,
      env,
      adminAdCampaignApproveMatch[1]
    );
  }
  const adminAdCampaignKillMatch = url.pathname.match(
    ADMIN_AD_CAMPAIGN_KILL_PATH
  );
  if (adminAdCampaignKillMatch && method === "POST") {
    return killAdminAdCampaign(request, env, adminAdCampaignKillMatch[1]);
  }
  const adminAdCampaignCreativesMatch = url.pathname.match(
    ADMIN_AD_CAMPAIGN_CREATIVES_PATH
  );
  if (adminAdCampaignCreativesMatch && method === "POST") {
    return createAdminAdCreative(
      request,
      env,
      adminAdCampaignCreativesMatch[1]
    );
  }
  const adminAdCreativeAudioMatch = url.pathname.match(
    ADMIN_AD_CREATIVE_AUDIO_PATH
  );
  if (adminAdCreativeAudioMatch && method === "PUT") {
    return uploadAdminAdCreativeAudio(
      request,
      env,
      adminAdCreativeAudioMatch[1]
    );
  }
  const adminAdCreativeValidateMatch = url.pathname.match(
    ADMIN_AD_CREATIVE_VALIDATE_PATH
  );
  if (adminAdCreativeValidateMatch && method === "POST") {
    return validateAdminAdCreative(
      request,
      env,
      adminAdCreativeValidateMatch[1]
    );
  }
  const adminAdPlanApproveMatch = url.pathname.match(
    ADMIN_AD_PLAN_APPROVE_PATH
  );
  if (adminAdPlanApproveMatch && method === "POST") {
    return approveAdminEpisodeAdPlan(
      request,
      env,
      adminAdPlanApproveMatch[1]
    );
  }
  const adminAdPlanRejectMatch = url.pathname.match(
    ADMIN_AD_PLAN_REJECT_PATH
  );
  if (adminAdPlanRejectMatch && method === "POST") {
    return rejectAdminEpisodeAdPlan(
      request,
      env,
      adminAdPlanRejectMatch[1]
    );
  }
  const adminAdCampaignMatch = url.pathname.match(ADMIN_AD_CAMPAIGN_PATH);
  if (adminAdCampaignMatch && method === "PATCH") {
    return updateAdminAdCampaign(request, env, adminAdCampaignMatch[1]);
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
  const processorAdPlanCompleteMatch = url.pathname.match(
    PROCESSOR_AD_PLAN_COMPLETE_PATH
  );
  if (processorAdPlanCompleteMatch && method === "POST") {
    return completeEpisodeAdPlanProcessing(
      request,
      env,
      processorAdPlanCompleteMatch[1]
    );
  }

  const knownPath = url.pathname === "/health"
    || url.pathname.startsWith("/v1/shows")
    || url.pathname.startsWith("/v1/admin")
    || url.pathname.startsWith("/v1/ads")
    || url.pathname.startsWith("/v1/diagnostics")
    || url.pathname.startsWith("/v1/internal")
    || Boolean(feedMatch)
    || Boolean(mediaMatch)
    || Boolean(adDecisionAudioMatch);
  return json(
    request,
    env.ALLOWED_ORIGINS,
    { error: knownPath ? "method_not_allowed" : "not_found" },
    { status: knownPath ? 405 : 404 }
  );
}
