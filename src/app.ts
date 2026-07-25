import {
  createAdminEpisode,
  listAdminEpisodes,
  listAdminShows,
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
  grantAdminUserRole,
  inviteAdminUser,
  listAdminUsers,
  revokeAdminUserRole,
  updateAdminUserStatus
} from "./admin-users";
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
  completeClipRender,
  getClipRenderProcessorManifest,
  getClipRenderProcessorSource,
  listAdminEpisodeClips,
  listAdminShowClips,
  queueAdminClipRender,
  saveAdminEpisodeClip,
  serveAdminClipRenderMedia,
  uploadClipRenderProcessorOutput
} from "./clips";
import {
  approveAdminEpisodeChapters,
  getAdminEpisodeChapters,
  saveAdminEpisodeChapters,
  servePrivateEpisodeChapters,
  servePublicEpisodeChapters
} from "./chapters";
import {
  createAdminEpisodeReviewComment,
  listAdminEpisodeReviews,
  updateAdminProductionReview,
  updateAdminProductionReviewComment
} from "./production-reviews";
import {
  approveAdminClipYouTubePublication,
  createAdminClipYouTubeDraft
} from "./clip-youtube";
import {
  serveStagingVirtualAudioDiagnostic,
  serveStagingVirtualAudioPlayer
} from "./diagnostics";
import {
  listDistributionDestinations,
  retryDistributionJob,
  updateEpisodeDistributionObservation,
  updateShowDistributionDestination
} from "./distribution";
import { servePrivateFeed, servePublicFeed } from "./feed";
import { json, options, privateJson } from "./http";
import {
  exchangeListenerLogin,
  getListenerSession,
  logoutListener,
  startListenerLogin
} from "./listener-auth";
import {
  dryRunAdminMarketingAnnouncement
} from "./marketing";
import {
  servePrivateEpisodeAudio,
  servePublicEpisodeAudio
} from "./media";
import {
  createListenerPrivateFeed,
  rotateListenerPrivateFeed
} from "./private-feeds";
import {
  updateListenerNotificationPreference
} from "./notification-preferences";
import {
  handlePoolGrantEvent,
  redeemPoolCode
} from "./pool-redemptions";
import { getPublicShow, listPublicShows } from "./shows";
import {
  createListenerBillingPortal,
  createSubscriptionCheckout
} from "./subscription-checkout";
import {
  quoteSubscriptionTax,
  subscriptionCheckoutConfigured
} from "./tax-quotes";
import {
  approveAdminEpisodeTranscript,
  listAdminEpisodeTranscripts,
  saveAdminEpisodeTranscript,
  servePublicEpisodeTranscripts
} from "./transcripts";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  uploadMultipartPart
} from "./uploads";
import { readJsonObject, RequestValidationError } from "./validation";

const SHOW_PATH = /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const SHOW_TAX_QUOTE_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/tax\/quote$/;
const SHOW_CHECKOUT_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/checkout$/;
const SHOW_EPISODE_TRANSCRIPTS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts$/;
const SHOW_EPISODE_CHAPTERS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
const FEED_PATH = /^\/(?:v1\/feeds\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
const MEDIA_PATH = /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)(?:\/audio)?$/;
const PRIVATE_FEED_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
const PRIVATE_MEDIA_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/episodes\/([A-Za-z0-9_-]+)\/audio$/;
const PRIVATE_CHAPTERS_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
const MEMBER_SHOW_FEED_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/feed$/;
const MEMBER_SHOW_FEED_ROTATE_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/feed\/rotate$/;
const MEMBER_SHOW_PORTAL_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/billing\/portal$/;
const MEMBER_SHOW_NOTIFICATIONS_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/notifications$/;
const MEMBER_POOL_REDEMPTION_PATH = "/v1/member/redemptions/pool";
const INTERNAL_POOL_GRANTS_PATH = "/v1/internal/pool/grants";
const ADMIN_SHOW_PATH = /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)$/;
const ADMIN_SHOW_CLIPS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/clips$/;
const ADMIN_SHOW_EPISODES_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/episodes$/;
const ADMIN_SHOW_MARKETING_DRY_RUN_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements\/dry-run$/;
const ADMIN_SHOW_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_PATH = /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_PUBLISH_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/publish$/;
const ADMIN_EPISODE_DISTRIBUTION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution$/;
const ADMIN_EPISODE_DISTRIBUTION_RETRY_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)\/retry$/;
const ADMIN_EPISODE_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_TRANSCRIPTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts$/;
const ADMIN_EPISODE_TRANSCRIPT_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)$/;
const ADMIN_EPISODE_TRANSCRIPT_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)\/approve$/;
const ADMIN_EPISODE_CHAPTERS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters$/;
const ADMIN_EPISODE_CHAPTERS_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters\/approve$/;
const ADMIN_EPISODE_REVIEWS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/reviews$/;
const ADMIN_REVIEW_PATH =
  /^\/v1\/admin\/reviews\/([A-Za-z0-9_-]+)$/;
const ADMIN_REVIEW_COMMENT_PATH =
  /^\/v1\/admin\/review-comments\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_CLIPS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips$/;
const ADMIN_EPISODE_CLIP_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips\/([A-Za-z0-9_-]+)$/;
const ADMIN_CLIP_RENDER_PATH =
  /^\/v1\/admin\/clips\/([A-Za-z0-9_-]+)\/render$/;
const ADMIN_CLIP_RENDER_MEDIA_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/media$/;
const ADMIN_CLIP_RENDER_YOUTUBE_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/youtube$/;
const ADMIN_CLIP_YOUTUBE_APPROVE_PATH =
  /^\/v1\/admin\/clip-youtube-publications\/([A-Za-z0-9_-]+)\/approve$/;
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
const PROCESSOR_CLIP_RENDER_COMPLETE_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_CLIP_RENDER_MANIFEST_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_CLIP_RENDER_SOURCE_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_CLIP_RENDER_OUTPUT_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/output$/;
const AD_DECISION_AUDIO_PATH =
  /^\/v1\/ads\/decisions\/([A-Za-z0-9_-]+)\/audio$/;
const VIRTUAL_AUDIO_DIAGNOSTIC_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_-]{32,128})(?:\/(virtual|baseline))?$/;
const ADMIN_USER_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)$/;
const ADMIN_USER_ROLES_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles$/;
const ADMIN_USER_ROLE_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles\/(super_admin|admin|producer|analyst)$/;

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
    return json(request, env.ALLOWED_ORIGINS, {
      shows,
      checkoutEnabled: subscriptionCheckoutConfigured(env)
    });
  }

  const showTaxQuoteMatch = url.pathname.match(SHOW_TAX_QUOTE_PATH);
  if (showTaxQuoteMatch && method === "POST") {
    return quoteSubscriptionTax(request, env, showTaxQuoteMatch[1]);
  }
  const showCheckoutMatch = url.pathname.match(SHOW_CHECKOUT_PATH);
  if (showCheckoutMatch && method === "POST") {
    return createSubscriptionCheckout(request, env, showCheckoutMatch[1]);
  }
  const showEpisodeTranscriptsMatch = url.pathname.match(
    SHOW_EPISODE_TRANSCRIPTS_PATH
  );
  if (
    showEpisodeTranscriptsMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePublicEpisodeTranscripts(
      request,
      env,
      showEpisodeTranscriptsMatch[1],
      showEpisodeTranscriptsMatch[2]
    );
  }
  const showEpisodeChaptersMatch = url.pathname.match(
    SHOW_EPISODE_CHAPTERS_PATH
  );
  if (
    showEpisodeChaptersMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePublicEpisodeChapters(
      request,
      env,
      showEpisodeChaptersMatch[1],
      showEpisodeChaptersMatch[2]
    );
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
    return json(request, env.ALLOWED_ORIGINS, {
      show,
      checkoutEnabled: subscriptionCheckoutConfigured(env)
    });
  }

  const feedMatch = url.pathname.match(FEED_PATH);
  if (feedMatch && (method === "GET" || method === "HEAD")) {
    return servePublicFeed(request, env, feedMatch[1]);
  }

  const privateFeedMatch = url.pathname.match(PRIVATE_FEED_PATH);
  if (privateFeedMatch && (method === "GET" || method === "HEAD")) {
    return servePrivateFeed(
      request,
      env,
      privateFeedMatch[1],
      privateFeedMatch[2]
    );
  }
  const privateChaptersMatch = url.pathname.match(PRIVATE_CHAPTERS_PATH);
  if (
    privateChaptersMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePrivateEpisodeChapters(
      request,
      env,
      privateChaptersMatch[1],
      privateChaptersMatch[2],
      privateChaptersMatch[3]
    );
  }
  const privateMediaMatch = url.pathname.match(PRIVATE_MEDIA_PATH);
  if (privateMediaMatch && (method === "GET" || method === "HEAD")) {
    return servePrivateEpisodeAudio(
      request,
      env,
      privateMediaMatch[1],
      privateMediaMatch[2]
    );
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

  if (url.pathname === "/v1/member/auth/start" && method === "POST") {
    return startListenerLogin(request, env, await readJsonObject(request));
  }
  if (url.pathname === "/v1/member/auth/exchange" && method === "POST") {
    return exchangeListenerLogin(request, env, await readJsonObject(request));
  }
  if (url.pathname === "/v1/member/session" && method === "GET") {
    return getListenerSession(request, env);
  }
  if (url.pathname === "/v1/member/logout" && method === "POST") {
    return logoutListener(request, env);
  }
  const memberShowFeedRotateMatch = url.pathname.match(
    MEMBER_SHOW_FEED_ROTATE_PATH
  );
  if (memberShowFeedRotateMatch && method === "POST") {
    return rotateListenerPrivateFeed(
      request,
      env,
      memberShowFeedRotateMatch[1]
    );
  }
  const memberShowFeedMatch = url.pathname.match(MEMBER_SHOW_FEED_PATH);
  if (memberShowFeedMatch && method === "POST") {
    return createListenerPrivateFeed(
      request,
      env,
      memberShowFeedMatch[1]
    );
  }
  const memberShowPortalMatch = url.pathname.match(MEMBER_SHOW_PORTAL_PATH);
  if (memberShowPortalMatch && method === "POST") {
    return createListenerBillingPortal(
      request,
      env,
      memberShowPortalMatch[1]
    );
  }
  const memberShowNotificationsMatch = url.pathname.match(
    MEMBER_SHOW_NOTIFICATIONS_PATH
  );
  if (memberShowNotificationsMatch && method === "PUT") {
    return updateListenerNotificationPreference(
      request,
      env,
      memberShowNotificationsMatch[1]
    );
  }
  if (url.pathname === MEMBER_POOL_REDEMPTION_PATH && method === "POST") {
    return redeemPoolCode(request, env);
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
  if (url.pathname === "/v1/admin/users") {
    if (method === "GET") return listAdminUsers(request, env);
    if (method === "POST") return inviteAdminUser(request, env);
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
  if (url.pathname === INTERNAL_POOL_GRANTS_PATH && method === "POST") {
    return handlePoolGrantEvent(request, env);
  }
  if (
    url.pathname === "/v1/internal/ad-qualifications"
    && method === "POST"
  ) {
    return recordTrustedAdQualificationCallback(request, env);
  }

  const adminShowClipsMatch = url.pathname.match(ADMIN_SHOW_CLIPS_PATH);
  if (adminShowClipsMatch && method === "GET") {
    return listAdminShowClips(request, env, adminShowClipsMatch[1]);
  }
  const adminShowMarketingDryRunMatch = url.pathname.match(
    ADMIN_SHOW_MARKETING_DRY_RUN_PATH
  );
  if (adminShowMarketingDryRunMatch && method === "POST") {
    return dryRunAdminMarketingAnnouncement(
      request,
      env,
      adminShowMarketingDryRunMatch[1]
    );
  }
  const adminShowDistributionDestinationMatch = url.pathname.match(
    ADMIN_SHOW_DISTRIBUTION_DESTINATION_PATH
  );
  if (adminShowDistributionDestinationMatch && method === "PATCH") {
    return updateShowDistributionDestination(
      request,
      env,
      adminShowDistributionDestinationMatch[1],
      adminShowDistributionDestinationMatch[2]
    );
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
  const adminUserRoleMatch = url.pathname.match(ADMIN_USER_ROLE_PATH);
  if (adminUserRoleMatch && method === "DELETE") {
    return revokeAdminUserRole(
      request,
      env,
      adminUserRoleMatch[1],
      adminUserRoleMatch[2]
    );
  }
  const adminUserRolesMatch = url.pathname.match(ADMIN_USER_ROLES_PATH);
  if (adminUserRolesMatch && method === "POST") {
    return grantAdminUserRole(request, env, adminUserRolesMatch[1]);
  }
  const adminUserMatch = url.pathname.match(ADMIN_USER_PATH);
  if (adminUserMatch && method === "PATCH") {
    return updateAdminUserStatus(request, env, adminUserMatch[1]);
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
  const adminEpisodeDistributionRetryMatch = url.pathname.match(
    ADMIN_EPISODE_DISTRIBUTION_RETRY_PATH
  );
  if (adminEpisodeDistributionRetryMatch && method === "POST") {
    return retryDistributionJob(
      request,
      env,
      adminEpisodeDistributionRetryMatch[1],
      adminEpisodeDistributionRetryMatch[2]
    );
  }
  const adminEpisodeDistributionDestinationMatch = url.pathname.match(
    ADMIN_EPISODE_DISTRIBUTION_DESTINATION_PATH
  );
  if (adminEpisodeDistributionDestinationMatch && method === "PATCH") {
    return updateEpisodeDistributionObservation(
      request,
      env,
      adminEpisodeDistributionDestinationMatch[1],
      adminEpisodeDistributionDestinationMatch[2]
    );
  }
  const adminEpisodeTranscriptApproveMatch = url.pathname.match(
    ADMIN_EPISODE_TRANSCRIPT_APPROVE_PATH
  );
  if (adminEpisodeTranscriptApproveMatch && method === "POST") {
    return approveAdminEpisodeTranscript(
      request,
      env,
      adminEpisodeTranscriptApproveMatch[1],
      adminEpisodeTranscriptApproveMatch[2]
    );
  }
  const adminEpisodeChaptersApproveMatch = url.pathname.match(
    ADMIN_EPISODE_CHAPTERS_APPROVE_PATH
  );
  if (adminEpisodeChaptersApproveMatch && method === "POST") {
    return approveAdminEpisodeChapters(
      request,
      env,
      adminEpisodeChaptersApproveMatch[1]
    );
  }
  const adminEpisodeChaptersMatch = url.pathname.match(
    ADMIN_EPISODE_CHAPTERS_PATH
  );
  if (adminEpisodeChaptersMatch) {
    if (method === "GET") {
      return getAdminEpisodeChapters(
        request,
        env,
        adminEpisodeChaptersMatch[1]
      );
    }
    if (method === "PUT") {
      return saveAdminEpisodeChapters(
        request,
        env,
        adminEpisodeChaptersMatch[1]
      );
    }
  }
  const adminEpisodeReviewsMatch = url.pathname.match(
    ADMIN_EPISODE_REVIEWS_PATH
  );
  if (adminEpisodeReviewsMatch) {
    if (method === "GET") {
      return listAdminEpisodeReviews(
        request,
        env,
        adminEpisodeReviewsMatch[1]
      );
    }
    if (method === "POST") {
      return createAdminEpisodeReviewComment(
        request,
        env,
        adminEpisodeReviewsMatch[1]
      );
    }
  }
  const adminReviewMatch = url.pathname.match(ADMIN_REVIEW_PATH);
  if (adminReviewMatch && method === "PATCH") {
    return updateAdminProductionReview(
      request,
      env,
      adminReviewMatch[1]
    );
  }
  const adminReviewCommentMatch = url.pathname.match(
    ADMIN_REVIEW_COMMENT_PATH
  );
  if (adminReviewCommentMatch && method === "PATCH") {
    return updateAdminProductionReviewComment(
      request,
      env,
      adminReviewCommentMatch[1]
    );
  }
  const adminEpisodeTranscriptMatch = url.pathname.match(
    ADMIN_EPISODE_TRANSCRIPT_PATH
  );
  if (adminEpisodeTranscriptMatch && method === "PUT") {
    return saveAdminEpisodeTranscript(
      request,
      env,
      adminEpisodeTranscriptMatch[1],
      adminEpisodeTranscriptMatch[2]
    );
  }
  const adminEpisodeTranscriptsMatch = url.pathname.match(
    ADMIN_EPISODE_TRANSCRIPTS_PATH
  );
  if (adminEpisodeTranscriptsMatch && method === "GET") {
    return listAdminEpisodeTranscripts(
      request,
      env,
      adminEpisodeTranscriptsMatch[1]
    );
  }
  const adminEpisodeClipMatch = url.pathname.match(
    ADMIN_EPISODE_CLIP_PATH
  );
  if (adminEpisodeClipMatch && method === "PUT") {
    return saveAdminEpisodeClip(
      request,
      env,
      adminEpisodeClipMatch[1],
      adminEpisodeClipMatch[2]
    );
  }
  const adminEpisodeClipsMatch = url.pathname.match(
    ADMIN_EPISODE_CLIPS_PATH
  );
  if (adminEpisodeClipsMatch && method === "GET") {
    return listAdminEpisodeClips(
      request,
      env,
      adminEpisodeClipsMatch[1]
    );
  }
  const adminClipRenderMatch = url.pathname.match(
    ADMIN_CLIP_RENDER_PATH
  );
  if (adminClipRenderMatch && method === "POST") {
    return queueAdminClipRender(
      request,
      env,
      adminClipRenderMatch[1]
    );
  }
  const adminClipRenderMediaMatch = url.pathname.match(
    ADMIN_CLIP_RENDER_MEDIA_PATH
  );
  if (
    adminClipRenderMediaMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdminClipRenderMedia(
      request,
      env,
      adminClipRenderMediaMatch[1]
    );
  }
  const adminClipRenderYouTubeMatch = url.pathname.match(
    ADMIN_CLIP_RENDER_YOUTUBE_PATH
  );
  if (adminClipRenderYouTubeMatch && method === "POST") {
    return createAdminClipYouTubeDraft(
      request,
      env,
      adminClipRenderYouTubeMatch[1]
    );
  }
  const adminClipYouTubeApproveMatch = url.pathname.match(
    ADMIN_CLIP_YOUTUBE_APPROVE_PATH
  );
  if (adminClipYouTubeApproveMatch && method === "POST") {
    return approveAdminClipYouTubePublication(
      request,
      env,
      adminClipYouTubeApproveMatch[1]
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
  const processorClipRenderCompleteMatch = url.pathname.match(
    PROCESSOR_CLIP_RENDER_COMPLETE_PATH
  );
  if (processorClipRenderCompleteMatch && method === "POST") {
    return completeClipRender(
      request,
      env,
      processorClipRenderCompleteMatch[1]
    );
  }
  const processorClipRenderManifestMatch = url.pathname.match(
    PROCESSOR_CLIP_RENDER_MANIFEST_PATH
  );
  if (processorClipRenderManifestMatch && method === "POST") {
    return getClipRenderProcessorManifest(
      request,
      env,
      processorClipRenderManifestMatch[1]
    );
  }
  const processorClipRenderSourceMatch = url.pathname.match(
    PROCESSOR_CLIP_RENDER_SOURCE_PATH
  );
  if (processorClipRenderSourceMatch && method === "POST") {
    return getClipRenderProcessorSource(
      request,
      env,
      processorClipRenderSourceMatch[1]
    );
  }
  const processorClipRenderOutputMatch = url.pathname.match(
    PROCESSOR_CLIP_RENDER_OUTPUT_PATH
  );
  if (processorClipRenderOutputMatch && method === "PUT") {
    return uploadClipRenderProcessorOutput(
      request,
      env,
      processorClipRenderOutputMatch[1]
    );
  }

  const knownPath = url.pathname === "/health"
    || url.pathname.startsWith("/v1/shows")
    || url.pathname.startsWith("/v1/admin")
    || url.pathname.startsWith("/v1/ads")
    || url.pathname.startsWith("/v1/diagnostics")
    || url.pathname.startsWith("/v1/internal")
    || url.pathname.startsWith("/v1/member")
    || url.pathname.startsWith("/v1/private")
    || Boolean(feedMatch)
    || Boolean(mediaMatch)
    || Boolean(privateFeedMatch)
    || Boolean(privateMediaMatch)
    || Boolean(adDecisionAudioMatch);
  return json(
    request,
    env.ALLOWED_ORIGINS,
    { error: knownPath ? "method_not_allowed" : "not_found" },
    { status: knownPath ? 405 : 404 }
  );
}
