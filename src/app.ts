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
  completeAudioQcRun,
  getAdminEpisodeAudioQc,
  getAdminShowAudioQcPolicy,
  getAudioQcProcessorManifest,
  getAudioQcProcessorSource,
  queueAdminEpisodeAudioQc,
  updateAdminShowAudioQcPolicy
} from "./audio-qc";
import {
  approveAdminEpisodeSourceMaster,
  completeAudioEnhancementPreview,
  getAdminEpisodeAudioMaster,
  getAudioEnhancementProcessorManifest,
  getAudioEnhancementProcessorSource,
  queueAdminAudioEnhancementPreview,
  serveAdminAudioEnhancementPreview,
  uploadAudioEnhancementProcessorOutput
} from "./audio-masters";
import {
  approveAdminAudioEnhancementDerivative,
  completeAudioEnhancementDerivative,
  completeAudioEnhancementDerivativeMultipartUpload,
  getAudioEnhancementDerivativeProcessorManifest,
  getAudioEnhancementDerivativeProcessorSource,
  listAdminAudioEnhancementDerivatives,
  queueAdminAudioEnhancementDerivative,
  serveAdminAudioEnhancementDerivative,
  uploadAudioEnhancementDerivativeProcessorPart
} from "./audio-enhancement-derivatives";
import {
  approveAdminDeliveryAudioJob,
  completeDeliveryAudioJob,
  completeDeliveryAudioMultipartUpload,
  getDeliveryAudioProcessorManifest,
  getDeliveryAudioProcessorSource,
  listAdminDeliveryAudioJobs,
  queueAdminDeliveryAudioJob,
  serveAdminDeliveryAudioJob,
  serveAdminDeliveryAudioPeaks,
  servePublicEpisodePeaks,
  uploadDeliveryAudioProcessorPart
} from "./delivery-audio";
import {
  issueAdminStagingAdDecision,
  recordTrustedAdQualificationCallback,
  serveAdDecisionAudio
} from "./ad-runtime";
import { previewAdminAdDecision } from "./ads";
import type { PodcastEnv } from "./env";
import { getBillingReadiness, handleStripeWebhook } from "./billing";
import { listBillingTaxEvidence } from "./billing-tax-evidence";
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
  getAdminEpisodePublicationReadiness
} from "./publication-readiness";
import {
  approveAdminClipYouTubePublication,
  createAdminClipYouTubeDraft
} from "./clip-youtube";
import {
  approveAdminClipPublication,
  createAdminClipPublicationDraft,
  listPublicEpisodeClips,
  servePublicClipMedia,
  withdrawAdminClipPublication
} from "./clip-publications";
import {
  approveAdminEpisodeYouTubePublication,
  createAdminEpisodeYouTubeDraft,
  reconcileAdminEpisodeYouTubePublication
} from "./episode-youtube";
import {
  completeYouTubeAudioRendition,
  completeYouTubeAudioRenditionMultipartUpload,
  getYouTubeAudioRenditionProcessorManifest,
  getYouTubeAudioRenditionProcessorSource,
  listAdminEpisodeYouTubeAudioRenditions,
  queueAdminEpisodeYouTubeAudioRendition,
  uploadYouTubeAudioRenditionProcessorPart
} from "./youtube-audio-renditions";
import {
  issueStagingVirtualAudioCapability,
  manageStagingVirtualAudioFixtureObject,
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
import {
  retryAdminPublicFeedValidation
} from "./feed-validation";
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
  deleteAdminMarketingLink,
  listAdminMarketingLinks,
  saveAdminMarketingLink
} from "./marketing-links";
import {
  servePrivateEpisodeAudio,
  servePublicEpisodeAudio
} from "./media";
import {
  exportAdminPodcastAnalyticsCsv,
  getAdminPodcastAnalyticsOverview,
  recordPodcastPlayerEvent
} from "./podcast-analytics";
import {
  createListenerPrivateFeed,
  rotateListenerPrivateFeed
} from "./private-feeds";
import {
  updateListenerNotificationPreference
} from "./notification-preferences";
import {
  approveAdminMarketingAnnouncement,
  handleResendWebhook,
  listAdminMarketingAnnouncements,
  serveAnnouncementUnsubscribe
} from "./announcement-delivery";
import {
  handlePoolGrantEvent,
  redeemPoolCode
} from "./pool-redemptions";
import { getPublicShow, listPublicShows } from "./shows";
import {
  createListenerBillingPortal,
  createSubscriptionCheckout
} from "./subscription-checkout";
import { listAdminSubscribers } from "./subscribers";
import {
  quoteSubscriptionTax,
  subscriptionCheckoutConfigured
} from "./tax-quotes";
import {
  approveAdminEpisodeAlignment,
  completeAlignmentProcessorJob,
  getAlignmentProcessorManifest,
  getAlignmentProcessorSource,
  listAdminEpisodeAlignmentJobs,
  queueAdminEpisodeAlignmentJob
} from "./alignment-jobs";
import {
  listAdminAlignmentBenchmarks,
  submitAdminAlignmentBenchmark
} from "./alignment-benchmarks";
import {
  completeTranscriptionChunkRun,
  getTranscriptionChunkProcessorManifest,
  getTranscriptionChunkProcessorSource,
  uploadTranscriptionChunkProcessorOutput
} from "./transcription-chunking";
import {
  listAdminEpisodeTranscriptionJobs,
  queueAdminEpisodeTranscription
} from "./transcription-jobs";
import {
  approveAdminEpisodeTranscript,
  listAdminEpisodeTranscripts,
  saveAdminEpisodeTranscript,
  servePrivateEpisodeTranscriptVtt,
  servePublicEpisodeTranscriptVtt,
  servePublicEpisodeTranscripts
} from "./transcripts";
import { previewAdminRssImport } from "./rss-import-preview";
import {
  assignAdminRssImportPodcastGuid
} from "./rss-import-identity";
import {
  cancelAdminRssImportPlan,
  createAdminRssImportPlan,
  listAdminRssImportPlans,
  reviewAdminRssImportPlan
} from "./rss-import-plans";
import {
  createAdminRssImportExecution,
  getAdminRssImportExecution
} from "./rss-import-executions";
import {
  createAdminRssImportCutoverPacket,
  createAdminRssImportReconciliation,
  createAdminRssImportRedirectAttestation,
  getAdminRssImportReconciliation
} from "./rss-import-reconciliations";
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
const SHOW_EPISODE_TRANSCRIPT_VTT_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts\/(en|es)\.vtt$/;
const SHOW_EPISODE_CHAPTERS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
const SHOW_EPISODE_CLIPS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/clips$/;
const SHOW_EPISODE_CLIP_MEDIA_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/clips\/([a-z0-9]+(?:-[a-z0-9]+)*)\.mp4$/;
const FEED_PATH = /^\/(?:v1\/feeds\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
const MEDIA_PATH = /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)(?:\/audio)?$/;
const PUBLIC_EPISODE_PEAKS_PATH =
  /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)\/peaks$/;
const PRIVATE_FEED_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
const PRIVATE_MEDIA_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/episodes\/([A-Za-z0-9_-]+)\/audio$/;
const PRIVATE_CHAPTERS_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
const PRIVATE_TRANSCRIPT_VTT_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts\/(en|es)\.vtt$/;
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
const ADMIN_SHOW_AUDIO_QC_POLICY_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/audio-qc-policy$/;
const ADMIN_SHOW_CLIPS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/clips$/;
const ADMIN_SHOW_EPISODES_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/episodes$/;
const ADMIN_SHOW_RSS_IMPORT_PREVIEW_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/preview$/;
const ADMIN_SHOW_RSS_IMPORT_PODCAST_GUID_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/podcast-guid$/;
const ADMIN_SHOW_RSS_IMPORT_PLANS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/plans$/;
const ADMIN_RSS_IMPORT_PLAN_REVIEW_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/review$/;
const ADMIN_RSS_IMPORT_PLAN_CANCEL_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/cancel$/;
const ADMIN_RSS_IMPORT_PLAN_EXECUTION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/execution$/;
const ADMIN_RSS_IMPORT_PLAN_RECONCILIATION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/reconciliation$/;
const ADMIN_RSS_IMPORT_REDIRECT_ATTESTATION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/redirect-attestation$/;
const ADMIN_RSS_IMPORT_CUTOVER_PACKET_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/cutover-packet$/;
const ADMIN_SHOW_MARKETING_DRY_RUN_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements\/dry-run$/;
const ADMIN_SHOW_MARKETING_ANNOUNCEMENTS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements$/;
const ADMIN_SHOW_MARKETING_APPROVE_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements\/approve$/;
const ADMIN_SHOW_MARKETING_LINKS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/links$/;
const ADMIN_SHOW_MARKETING_LINK_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/links\/([A-Za-z0-9_-]+)$/;
const ADMIN_SHOW_ANALYTICS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/analytics\/overview$/;
const ADMIN_SHOW_ANALYTICS_CSV_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/analytics\/overview\.csv$/;
const ANNOUNCEMENT_UNSUBSCRIBE_PATH =
  /^\/v1\/notifications\/unsubscribe\/([A-Za-z0-9_-]{43})$/;
const ADMIN_SHOW_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
const ADMIN_SHOW_FEED_VALIDATION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/feed-validation$/;
const ADMIN_EPISODE_PATH = /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_PUBLISH_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/publish$/;
const ADMIN_EPISODE_READINESS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/readiness$/;
const ADMIN_EPISODE_YOUTUBE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/youtube$/;
const ADMIN_EPISODE_YOUTUBE_AUDIO_RENDITIONS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/youtube-audio-renditions$/;
const ADMIN_EPISODE_AUDIO_QC_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-qc$/;
const ADMIN_EPISODE_AUDIO_MASTER_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-master$/;
const ADMIN_EPISODE_AUDIO_MASTER_APPROVE_SOURCE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-master\/approve-source$/;
const ADMIN_EPISODE_AUDIO_ENHANCEMENT_PREVIEWS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-enhancement-previews$/;
const ADMIN_EPISODE_AUDIO_ENHANCEMENT_DERIVATIVES_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-enhancement-derivatives$/;
const ADMIN_EPISODE_DELIVERY_AUDIO_JOBS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/delivery-audio-jobs$/;
const ADMIN_AUDIO_ENHANCEMENT_MEDIA_PATH =
  /^\/v1\/admin\/audio-enhancements\/([A-Za-z0-9_-]+)\/media\/(original|enhanced)$/;
const ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_APPROVE_PATH =
  /^\/v1\/admin\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_MEDIA_PATH =
  /^\/v1\/admin\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/media$/;
const ADMIN_DELIVERY_AUDIO_APPROVE_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_DELIVERY_AUDIO_MEDIA_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/media$/;
const ADMIN_DELIVERY_AUDIO_PEAKS_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/peaks$/;
const ADMIN_EPISODE_DISTRIBUTION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution$/;
const ADMIN_EPISODE_DISTRIBUTION_RETRY_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)\/retry$/;
const ADMIN_EPISODE_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
const ADMIN_EPISODE_TRANSCRIPTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts$/;
const ADMIN_EPISODE_TRANSCRIPTION_JOBS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcription-jobs$/;
const ADMIN_EPISODE_ALIGNMENTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/alignments$/;
const ADMIN_EPISODE_ALIGNMENT_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/alignments\/([A-Za-z0-9_-]+)\/approve$/;
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
const ADMIN_CLIP_RENDER_PUBLICATION_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/publication$/;
const ADMIN_CLIP_PUBLICATION_APPROVE_PATH =
  /^\/v1\/admin\/clip-publications\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_CLIP_PUBLICATION_WITHDRAW_PATH =
  /^\/v1\/admin\/clip-publications\/([A-Za-z0-9_-]+)\/withdraw$/;
const ADMIN_CLIP_YOUTUBE_APPROVE_PATH =
  /^\/v1\/admin\/clip-youtube-publications\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_EPISODE_YOUTUBE_APPROVE_PATH =
  /^\/v1\/admin\/episode-youtube-publications\/([A-Za-z0-9_-]+)\/approve$/;
const ADMIN_EPISODE_YOUTUBE_RECONCILE_PATH =
  /^\/v1\/admin\/episode-youtube-publications\/([A-Za-z0-9_-]+)\/reconcile$/;
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
const PROCESSOR_YOUTUBE_AUDIO_RENDITION_MANIFEST_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_YOUTUBE_AUDIO_RENDITION_SOURCE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/sources\/(audio|artwork)$/;
const PROCESSOR_YOUTUBE_AUDIO_RENDITION_PART_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
const PROCESSOR_YOUTUBE_AUDIO_RENDITION_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/upload-complete$/;
const PROCESSOR_YOUTUBE_AUDIO_RENDITION_COMPLETE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_AUDIO_QC_COMPLETE_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_AUDIO_QC_MANIFEST_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_AUDIO_QC_SOURCE_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_AUDIO_ENHANCEMENT_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_AUDIO_ENHANCEMENT_MANIFEST_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_AUDIO_ENHANCEMENT_SOURCE_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_AUDIO_ENHANCEMENT_OUTPUT_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/outputs\/(original|enhanced)$/;
const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_MANIFEST_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_SOURCE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_PART_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/upload-complete$/;
const PROCESSOR_DELIVERY_AUDIO_COMPLETE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_DELIVERY_AUDIO_MANIFEST_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_DELIVERY_AUDIO_SOURCE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_DELIVERY_AUDIO_PART_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
const PROCESSOR_DELIVERY_AUDIO_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/upload-complete$/;
const PROCESSOR_TRANSCRIPTION_CHUNK_COMPLETE_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_TRANSCRIPTION_CHUNK_MANIFEST_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_TRANSCRIPTION_CHUNK_SOURCE_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/source$/;
const PROCESSOR_TRANSCRIPTION_CHUNK_OUTPUT_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/chunks\/([0-9]{1,3})$/;
const PROCESSOR_ALIGNMENT_COMPLETE_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/complete$/;
const PROCESSOR_ALIGNMENT_MANIFEST_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/manifest$/;
const PROCESSOR_ALIGNMENT_SOURCE_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/source$/;
const AD_DECISION_AUDIO_PATH =
  /^\/v1\/ads\/decisions\/([A-Za-z0-9_-]+)\/audio$/;
const VIRTUAL_AUDIO_DIAGNOSTIC_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_.-]{80,180})(?:\/(virtual|baseline))?$/;
const VIRTUAL_AUDIO_FIXTURE_OBJECT_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_.-]{80,180})\/objects\/([A-Za-z0-9.-]{1,100})$/;
const ADMIN_USER_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)$/;
const ADMIN_USER_ROLES_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles$/;
const ADMIN_USER_ROLE_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles\/(super_admin|admin|producer|analyst)$/;
const ADMIN_ALIGNMENT_BENCHMARKS_PATH =
  "/v1/admin/alignment-benchmarks";

export async function handleRequest(
  request: Request,
  env: PodcastEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  try {
    return await routeRequest(request, env, ctx);
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

async function routeRequest(
  request: Request,
  env: PodcastEnv,
  ctx?: ExecutionContext
): Promise<Response> {
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

  const announcementUnsubscribeMatch = url.pathname.match(
    ANNOUNCEMENT_UNSUBSCRIBE_PATH
  );
  if (announcementUnsubscribeMatch) {
    return serveAnnouncementUnsubscribe(
      request,
      env,
      announcementUnsubscribeMatch[1]
    );
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
  if (url.pathname === "/v1/analytics/player-events" && method === "POST") {
    return recordPodcastPlayerEvent(request, env);
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
  const showEpisodeTranscriptVttMatch = url.pathname.match(
    SHOW_EPISODE_TRANSCRIPT_VTT_PATH
  );
  if (
    showEpisodeTranscriptVttMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePublicEpisodeTranscriptVtt(
      request,
      env,
      showEpisodeTranscriptVttMatch[1],
      showEpisodeTranscriptVttMatch[2],
      showEpisodeTranscriptVttMatch[3]
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
  const showEpisodeClipMediaMatch = url.pathname.match(
    SHOW_EPISODE_CLIP_MEDIA_PATH
  );
  if (
    showEpisodeClipMediaMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePublicClipMedia(
      request,
      env,
      showEpisodeClipMediaMatch[1],
      showEpisodeClipMediaMatch[2],
      showEpisodeClipMediaMatch[3]
    );
  }
  const showEpisodeClipsMatch = url.pathname.match(
    SHOW_EPISODE_CLIPS_PATH
  );
  if (
    showEpisodeClipsMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return listPublicEpisodeClips(
      request,
      env,
      showEpisodeClipsMatch[1],
      showEpisodeClipsMatch[2]
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
  const privateTranscriptVttMatch = url.pathname.match(
    PRIVATE_TRANSCRIPT_VTT_PATH
  );
  if (
    privateTranscriptVttMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePrivateEpisodeTranscriptVtt(
      request,
      env,
      privateTranscriptVttMatch[1],
      privateTranscriptVttMatch[2],
      privateTranscriptVttMatch[3],
      privateTranscriptVttMatch[4]
    );
  }
  const privateMediaMatch = url.pathname.match(PRIVATE_MEDIA_PATH);
  if (privateMediaMatch && (method === "GET" || method === "HEAD")) {
    return servePrivateEpisodeAudio(
      request,
      env,
      privateMediaMatch[1],
      privateMediaMatch[2],
      ctx
    );
  }
  const publicEpisodePeaksMatch = url.pathname.match(
    PUBLIC_EPISODE_PEAKS_PATH
  );
  if (
    publicEpisodePeaksMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return servePublicEpisodePeaks(
      request,
      env,
      publicEpisodePeaksMatch[1]
    );
  }
  const mediaMatch = url.pathname.match(MEDIA_PATH);
  if (mediaMatch && (method === "GET" || method === "HEAD")) {
    return servePublicEpisodeAudio(request, env, mediaMatch[1], ctx);
  }
  const adDecisionAudioMatch = url.pathname.match(AD_DECISION_AUDIO_PATH);
  if (
    adDecisionAudioMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdDecisionAudio(
      request,
      env,
      adDecisionAudioMatch[1],
      ctx
    );
  }

  if (
    url.pathname === "/v1/diagnostics/virtual-audio/player"
    && (method === "GET" || method === "HEAD")
  ) {
    return serveStagingVirtualAudioPlayer(env);
  }
  if (
    url.pathname === "/v1/diagnostics/virtual-audio/capability"
    && method === "POST"
  ) {
    return issueStagingVirtualAudioCapability(request, env);
  }
  const virtualAudioFixtureObjectMatch = url.pathname.match(
    VIRTUAL_AUDIO_FIXTURE_OBJECT_PATH
  );
  if (
    virtualAudioFixtureObjectMatch
    && ["GET", "HEAD", "PUT", "DELETE"].includes(method)
  ) {
    return manageStagingVirtualAudioFixtureObject(
      request,
      env,
      virtualAudioFixtureObjectMatch[1],
      virtualAudioFixtureObjectMatch[2]
    );
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
  if (url.pathname === "/v1/admin/billing/tax-evidence" && method === "GET") {
    return listBillingTaxEvidence(request, env);
  }
  if (url.pathname === "/v1/admin/subscribers" && method === "GET") {
    return listAdminSubscribers(request, env);
  }
  if (url.pathname === ADMIN_ALIGNMENT_BENCHMARKS_PATH) {
    if (method === "GET") {
      return listAdminAlignmentBenchmarks(request, env);
    }
    if (method === "POST") {
      return submitAdminAlignmentBenchmark(request, env);
    }
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
  if (url.pathname === "/v1/webhooks/resend" && method === "POST") {
    return handleResendWebhook(request, env);
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
  const adminShowRssImportPreviewMatch = url.pathname.match(
    ADMIN_SHOW_RSS_IMPORT_PREVIEW_PATH
  );
  if (adminShowRssImportPreviewMatch && method === "POST") {
    return previewAdminRssImport(
      request,
      env,
      adminShowRssImportPreviewMatch[1]
    );
  }
  const adminShowRssImportPodcastGuidMatch = url.pathname.match(
    ADMIN_SHOW_RSS_IMPORT_PODCAST_GUID_PATH
  );
  if (adminShowRssImportPodcastGuidMatch && method === "POST") {
    return assignAdminRssImportPodcastGuid(
      request,
      env,
      adminShowRssImportPodcastGuidMatch[1]
    );
  }
  const adminShowRssImportPlansMatch = url.pathname.match(
    ADMIN_SHOW_RSS_IMPORT_PLANS_PATH
  );
  if (adminShowRssImportPlansMatch) {
    if (method === "GET") {
      return listAdminRssImportPlans(
        request,
        env,
        adminShowRssImportPlansMatch[1]
      );
    }
    if (method === "POST") {
      return createAdminRssImportPlan(
        request,
        env,
        adminShowRssImportPlansMatch[1]
      );
    }
  }
  const adminRssImportPlanReviewMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_PLAN_REVIEW_PATH
  );
  if (adminRssImportPlanReviewMatch && method === "POST") {
    return reviewAdminRssImportPlan(
      request,
      env,
      adminRssImportPlanReviewMatch[1]
    );
  }
  const adminRssImportPlanCancelMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_PLAN_CANCEL_PATH
  );
  if (adminRssImportPlanCancelMatch && method === "POST") {
    return cancelAdminRssImportPlan(
      request,
      env,
      adminRssImportPlanCancelMatch[1]
    );
  }
  const adminRssImportPlanExecutionMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_PLAN_EXECUTION_PATH
  );
  if (adminRssImportPlanExecutionMatch) {
    if (method === "GET") {
      return getAdminRssImportExecution(
        request,
        env,
        adminRssImportPlanExecutionMatch[1]
      );
    }
    if (method === "POST") {
      return createAdminRssImportExecution(
        request,
        env,
        adminRssImportPlanExecutionMatch[1]
      );
    }
  }
  const adminRssImportPlanReconciliationMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_PLAN_RECONCILIATION_PATH
  );
  if (adminRssImportPlanReconciliationMatch) {
    if (method === "GET") {
      return getAdminRssImportReconciliation(
        request,
        env,
        adminRssImportPlanReconciliationMatch[1]
      );
    }
    if (method === "POST") {
      return createAdminRssImportReconciliation(
        request,
        env,
        adminRssImportPlanReconciliationMatch[1]
      );
    }
  }
  const adminRssImportRedirectAttestationMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_REDIRECT_ATTESTATION_PATH
  );
  if (
    adminRssImportRedirectAttestationMatch
    && method === "POST"
  ) {
    return createAdminRssImportRedirectAttestation(
      request,
      env,
      adminRssImportRedirectAttestationMatch[1]
    );
  }
  const adminRssImportCutoverPacketMatch = url.pathname.match(
    ADMIN_RSS_IMPORT_CUTOVER_PACKET_PATH
  );
  if (adminRssImportCutoverPacketMatch && method === "POST") {
    return createAdminRssImportCutoverPacket(
      request,
      env,
      adminRssImportCutoverPacketMatch[1]
    );
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
  const adminShowMarketingApproveMatch = url.pathname.match(
    ADMIN_SHOW_MARKETING_APPROVE_PATH
  );
  if (adminShowMarketingApproveMatch && method === "POST") {
    return approveAdminMarketingAnnouncement(
      request,
      env,
      adminShowMarketingApproveMatch[1]
    );
  }
  const adminShowMarketingAnnouncementsMatch = url.pathname.match(
    ADMIN_SHOW_MARKETING_ANNOUNCEMENTS_PATH
  );
  if (adminShowMarketingAnnouncementsMatch && method === "GET") {
    return listAdminMarketingAnnouncements(
      request,
      env,
      adminShowMarketingAnnouncementsMatch[1]
    );
  }
  const adminShowMarketingLinksMatch = url.pathname.match(
    ADMIN_SHOW_MARKETING_LINKS_PATH
  );
  if (adminShowMarketingLinksMatch) {
    if (method === "GET") {
      return listAdminMarketingLinks(
        request,
        env,
        adminShowMarketingLinksMatch[1]
      );
    }
    if (method === "POST") {
      return saveAdminMarketingLink(
        request,
        env,
        adminShowMarketingLinksMatch[1]
      );
    }
  }
  const adminShowAnalyticsCsvMatch = url.pathname.match(
    ADMIN_SHOW_ANALYTICS_CSV_PATH
  );
  if (adminShowAnalyticsCsvMatch && method === "GET") {
    return exportAdminPodcastAnalyticsCsv(
      request,
      env,
      adminShowAnalyticsCsvMatch[1]
    );
  }
  const adminShowAnalyticsMatch = url.pathname.match(
    ADMIN_SHOW_ANALYTICS_PATH
  );
  if (adminShowAnalyticsMatch && method === "GET") {
    return getAdminPodcastAnalyticsOverview(
      request,
      env,
      adminShowAnalyticsMatch[1]
    );
  }
  const adminShowMarketingLinkMatch = url.pathname.match(
    ADMIN_SHOW_MARKETING_LINK_PATH
  );
  if (adminShowMarketingLinkMatch && method === "DELETE") {
    return deleteAdminMarketingLink(
      request,
      env,
      adminShowMarketingLinkMatch[1],
      adminShowMarketingLinkMatch[2]
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
  const adminShowFeedValidationMatch = url.pathname.match(
    ADMIN_SHOW_FEED_VALIDATION_PATH
  );
  if (adminShowFeedValidationMatch && method === "POST") {
    return retryAdminPublicFeedValidation(
      request,
      env,
      adminShowFeedValidationMatch[1]
    );
  }
  const adminShowAudioQcPolicyMatch = url.pathname.match(
    ADMIN_SHOW_AUDIO_QC_POLICY_PATH
  );
  if (adminShowAudioQcPolicyMatch) {
    if (method === "GET") {
      return getAdminShowAudioQcPolicy(
        request,
        env,
        adminShowAudioQcPolicyMatch[1]
      );
    }
    if (method === "PATCH") {
      return updateAdminShowAudioQcPolicy(
        request,
        env,
        adminShowAudioQcPolicyMatch[1]
      );
    }
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
  const adminEpisodeReadinessMatch = url.pathname.match(
    ADMIN_EPISODE_READINESS_PATH
  );
  if (adminEpisodeReadinessMatch && method === "GET") {
    return getAdminEpisodePublicationReadiness(
      request,
      env,
      adminEpisodeReadinessMatch[1]
    );
  }
  const adminEpisodeAudioQcMatch = url.pathname.match(
    ADMIN_EPISODE_AUDIO_QC_PATH
  );
  if (adminEpisodeAudioQcMatch) {
    if (method === "GET") {
      return getAdminEpisodeAudioQc(
        request,
        env,
        adminEpisodeAudioQcMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminEpisodeAudioQc(
        request,
        env,
        adminEpisodeAudioQcMatch[1]
      );
    }
  }
  const adminEpisodeAudioMasterApproveSourceMatch = url.pathname.match(
    ADMIN_EPISODE_AUDIO_MASTER_APPROVE_SOURCE_PATH
  );
  if (
    adminEpisodeAudioMasterApproveSourceMatch
    && method === "POST"
  ) {
    return approveAdminEpisodeSourceMaster(
      request,
      env,
      adminEpisodeAudioMasterApproveSourceMatch[1]
    );
  }
  const adminEpisodeAudioEnhancementPreviewsMatch = url.pathname.match(
    ADMIN_EPISODE_AUDIO_ENHANCEMENT_PREVIEWS_PATH
  );
  if (
    adminEpisodeAudioEnhancementPreviewsMatch
    && method === "POST"
  ) {
    return queueAdminAudioEnhancementPreview(
      request,
      env,
      adminEpisodeAudioEnhancementPreviewsMatch[1]
    );
  }
  const adminEpisodeAudioEnhancementDerivativesMatch = url.pathname.match(
    ADMIN_EPISODE_AUDIO_ENHANCEMENT_DERIVATIVES_PATH
  );
  if (adminEpisodeAudioEnhancementDerivativesMatch) {
    if (method === "GET") {
      return listAdminAudioEnhancementDerivatives(
        request,
        env,
        adminEpisodeAudioEnhancementDerivativesMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminAudioEnhancementDerivative(
        request,
        env,
        adminEpisodeAudioEnhancementDerivativesMatch[1]
      );
    }
  }
  const adminAudioEnhancementDerivativeApproveMatch = url.pathname.match(
    ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_APPROVE_PATH
  );
  if (
    adminAudioEnhancementDerivativeApproveMatch
    && method === "POST"
  ) {
    return approveAdminAudioEnhancementDerivative(
      request,
      env,
      adminAudioEnhancementDerivativeApproveMatch[1]
    );
  }
  const adminAudioEnhancementDerivativeMediaMatch = url.pathname.match(
    ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_MEDIA_PATH
  );
  if (
    adminAudioEnhancementDerivativeMediaMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdminAudioEnhancementDerivative(
      request,
      env,
      adminAudioEnhancementDerivativeMediaMatch[1]
    );
  }
  const adminEpisodeDeliveryAudioJobsMatch = url.pathname.match(
    ADMIN_EPISODE_DELIVERY_AUDIO_JOBS_PATH
  );
  if (adminEpisodeDeliveryAudioJobsMatch) {
    if (method === "GET") {
      return listAdminDeliveryAudioJobs(
        request,
        env,
        adminEpisodeDeliveryAudioJobsMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminDeliveryAudioJob(
        request,
        env,
        adminEpisodeDeliveryAudioJobsMatch[1]
      );
    }
  }
  const adminDeliveryAudioApproveMatch = url.pathname.match(
    ADMIN_DELIVERY_AUDIO_APPROVE_PATH
  );
  if (adminDeliveryAudioApproveMatch && method === "POST") {
    return approveAdminDeliveryAudioJob(
      request,
      env,
      adminDeliveryAudioApproveMatch[1]
    );
  }
  const adminDeliveryAudioMediaMatch = url.pathname.match(
    ADMIN_DELIVERY_AUDIO_MEDIA_PATH
  );
  if (
    adminDeliveryAudioMediaMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdminDeliveryAudioJob(
      request,
      env,
      adminDeliveryAudioMediaMatch[1]
    );
  }
  const adminDeliveryAudioPeaksMatch = url.pathname.match(
    ADMIN_DELIVERY_AUDIO_PEAKS_PATH
  );
  if (
    adminDeliveryAudioPeaksMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdminDeliveryAudioPeaks(
      request,
      env,
      adminDeliveryAudioPeaksMatch[1]
    );
  }
  const adminEpisodeAudioMasterMatch = url.pathname.match(
    ADMIN_EPISODE_AUDIO_MASTER_PATH
  );
  if (adminEpisodeAudioMasterMatch && method === "GET") {
    return getAdminEpisodeAudioMaster(
      request,
      env,
      adminEpisodeAudioMasterMatch[1]
    );
  }
  const adminAudioEnhancementMediaMatch = url.pathname.match(
    ADMIN_AUDIO_ENHANCEMENT_MEDIA_PATH
  );
  if (
    adminAudioEnhancementMediaMatch
    && (method === "GET" || method === "HEAD")
  ) {
    return serveAdminAudioEnhancementPreview(
      request,
      env,
      adminAudioEnhancementMediaMatch[1],
      adminAudioEnhancementMediaMatch[2]
    );
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
  const adminEpisodeYouTubeMatch = url.pathname.match(
    ADMIN_EPISODE_YOUTUBE_PATH
  );
  if (adminEpisodeYouTubeMatch && method === "POST") {
    return createAdminEpisodeYouTubeDraft(
      request,
      env,
      adminEpisodeYouTubeMatch[1]
    );
  }
  const adminEpisodeYouTubeAudioRenditionsMatch = url.pathname.match(
    ADMIN_EPISODE_YOUTUBE_AUDIO_RENDITIONS_PATH
  );
  if (adminEpisodeYouTubeAudioRenditionsMatch) {
    if (method === "GET") {
      return listAdminEpisodeYouTubeAudioRenditions(
        request,
        env,
        adminEpisodeYouTubeAudioRenditionsMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminEpisodeYouTubeAudioRendition(
        request,
        env,
        adminEpisodeYouTubeAudioRenditionsMatch[1]
      );
    }
  }
  const adminEpisodeYouTubeApproveMatch = url.pathname.match(
    ADMIN_EPISODE_YOUTUBE_APPROVE_PATH
  );
  if (adminEpisodeYouTubeApproveMatch && method === "POST") {
    return approveAdminEpisodeYouTubePublication(
      request,
      env,
      adminEpisodeYouTubeApproveMatch[1]
    );
  }
  const adminEpisodeYouTubeReconcileMatch = url.pathname.match(
    ADMIN_EPISODE_YOUTUBE_RECONCILE_PATH
  );
  if (adminEpisodeYouTubeReconcileMatch && method === "POST") {
    return reconcileAdminEpisodeYouTubePublication(
      request,
      env,
      adminEpisodeYouTubeReconcileMatch[1]
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
  const adminEpisodeTranscriptionJobsMatch = url.pathname.match(
    ADMIN_EPISODE_TRANSCRIPTION_JOBS_PATH
  );
  if (adminEpisodeTranscriptionJobsMatch) {
    if (method === "GET") {
      return listAdminEpisodeTranscriptionJobs(
        request,
        env,
        adminEpisodeTranscriptionJobsMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminEpisodeTranscription(
        request,
        env,
        adminEpisodeTranscriptionJobsMatch[1]
      );
    }
  }
  const adminEpisodeAlignmentApproveMatch = url.pathname.match(
    ADMIN_EPISODE_ALIGNMENT_APPROVE_PATH
  );
  if (adminEpisodeAlignmentApproveMatch && method === "POST") {
    return approveAdminEpisodeAlignment(
      request,
      env,
      adminEpisodeAlignmentApproveMatch[1],
      adminEpisodeAlignmentApproveMatch[2]
    );
  }
  const adminEpisodeAlignmentsMatch = url.pathname.match(
    ADMIN_EPISODE_ALIGNMENTS_PATH
  );
  if (adminEpisodeAlignmentsMatch) {
    if (method === "GET") {
      return listAdminEpisodeAlignmentJobs(
        request,
        env,
        adminEpisodeAlignmentsMatch[1]
      );
    }
    if (method === "POST") {
      return queueAdminEpisodeAlignmentJob(
        request,
        env,
        adminEpisodeAlignmentsMatch[1]
      );
    }
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
  const adminClipRenderPublicationMatch = url.pathname.match(
    ADMIN_CLIP_RENDER_PUBLICATION_PATH
  );
  if (adminClipRenderPublicationMatch && method === "POST") {
    return createAdminClipPublicationDraft(
      request,
      env,
      adminClipRenderPublicationMatch[1]
    );
  }
  const adminClipPublicationApproveMatch = url.pathname.match(
    ADMIN_CLIP_PUBLICATION_APPROVE_PATH
  );
  if (adminClipPublicationApproveMatch && method === "POST") {
    return approveAdminClipPublication(
      request,
      env,
      adminClipPublicationApproveMatch[1]
    );
  }
  const adminClipPublicationWithdrawMatch = url.pathname.match(
    ADMIN_CLIP_PUBLICATION_WITHDRAW_PATH
  );
  if (adminClipPublicationWithdrawMatch && method === "POST") {
    return withdrawAdminClipPublication(
      request,
      env,
      adminClipPublicationWithdrawMatch[1]
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
  const processorYouTubeAudioRenditionManifestMatch = url.pathname.match(
    PROCESSOR_YOUTUBE_AUDIO_RENDITION_MANIFEST_PATH
  );
  if (
    processorYouTubeAudioRenditionManifestMatch
    && method === "POST"
  ) {
    return getYouTubeAudioRenditionProcessorManifest(
      request,
      env,
      processorYouTubeAudioRenditionManifestMatch[1]
    );
  }
  const processorYouTubeAudioRenditionSourceMatch = url.pathname.match(
    PROCESSOR_YOUTUBE_AUDIO_RENDITION_SOURCE_PATH
  );
  if (
    processorYouTubeAudioRenditionSourceMatch
    && method === "POST"
  ) {
    return getYouTubeAudioRenditionProcessorSource(
      request,
      env,
      processorYouTubeAudioRenditionSourceMatch[1],
      processorYouTubeAudioRenditionSourceMatch[2] as
        "audio" | "artwork"
    );
  }
  const processorYouTubeAudioRenditionPartMatch = url.pathname.match(
    PROCESSOR_YOUTUBE_AUDIO_RENDITION_PART_PATH
  );
  if (
    processorYouTubeAudioRenditionPartMatch
    && method === "PUT"
  ) {
    return uploadYouTubeAudioRenditionProcessorPart(
      request,
      env,
      processorYouTubeAudioRenditionPartMatch[1],
      processorYouTubeAudioRenditionPartMatch[2]
    );
  }
  const processorYouTubeAudioRenditionUploadCompleteMatch =
    url.pathname.match(
      PROCESSOR_YOUTUBE_AUDIO_RENDITION_UPLOAD_COMPLETE_PATH
    );
  if (
    processorYouTubeAudioRenditionUploadCompleteMatch
    && method === "POST"
  ) {
    return completeYouTubeAudioRenditionMultipartUpload(
      request,
      env,
      processorYouTubeAudioRenditionUploadCompleteMatch[1]
    );
  }
  const processorYouTubeAudioRenditionCompleteMatch = url.pathname.match(
    PROCESSOR_YOUTUBE_AUDIO_RENDITION_COMPLETE_PATH
  );
  if (
    processorYouTubeAudioRenditionCompleteMatch
    && method === "POST"
  ) {
    return completeYouTubeAudioRendition(
      request,
      env,
      processorYouTubeAudioRenditionCompleteMatch[1]
    );
  }
  const processorAudioQcCompleteMatch = url.pathname.match(
    PROCESSOR_AUDIO_QC_COMPLETE_PATH
  );
  if (processorAudioQcCompleteMatch && method === "POST") {
    return completeAudioQcRun(
      request,
      env,
      processorAudioQcCompleteMatch[1]
    );
  }
  const processorAudioQcManifestMatch = url.pathname.match(
    PROCESSOR_AUDIO_QC_MANIFEST_PATH
  );
  if (processorAudioQcManifestMatch && method === "POST") {
    return getAudioQcProcessorManifest(
      request,
      env,
      processorAudioQcManifestMatch[1]
    );
  }
  const processorAudioQcSourceMatch = url.pathname.match(
    PROCESSOR_AUDIO_QC_SOURCE_PATH
  );
  if (processorAudioQcSourceMatch && method === "POST") {
    return getAudioQcProcessorSource(
      request,
      env,
      processorAudioQcSourceMatch[1]
    );
  }
  const processorAudioEnhancementCompleteMatch = url.pathname.match(
    PROCESSOR_AUDIO_ENHANCEMENT_COMPLETE_PATH
  );
  if (processorAudioEnhancementCompleteMatch && method === "POST") {
    return completeAudioEnhancementPreview(
      request,
      env,
      processorAudioEnhancementCompleteMatch[1]
    );
  }
  const processorAudioEnhancementManifestMatch = url.pathname.match(
    PROCESSOR_AUDIO_ENHANCEMENT_MANIFEST_PATH
  );
  if (processorAudioEnhancementManifestMatch && method === "POST") {
    return getAudioEnhancementProcessorManifest(
      request,
      env,
      processorAudioEnhancementManifestMatch[1]
    );
  }
  const processorAudioEnhancementSourceMatch = url.pathname.match(
    PROCESSOR_AUDIO_ENHANCEMENT_SOURCE_PATH
  );
  if (processorAudioEnhancementSourceMatch && method === "POST") {
    return getAudioEnhancementProcessorSource(
      request,
      env,
      processorAudioEnhancementSourceMatch[1]
    );
  }
  const processorAudioEnhancementOutputMatch = url.pathname.match(
    PROCESSOR_AUDIO_ENHANCEMENT_OUTPUT_PATH
  );
  if (processorAudioEnhancementOutputMatch && method === "PUT") {
    return uploadAudioEnhancementProcessorOutput(
      request,
      env,
      processorAudioEnhancementOutputMatch[1],
      processorAudioEnhancementOutputMatch[2]
    );
  }
  const processorAudioEnhancementDerivativeManifestMatch =
    url.pathname.match(
      PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_MANIFEST_PATH
    );
  if (
    processorAudioEnhancementDerivativeManifestMatch
    && method === "POST"
  ) {
    return getAudioEnhancementDerivativeProcessorManifest(
      request,
      env,
      processorAudioEnhancementDerivativeManifestMatch[1]
    );
  }
  const processorAudioEnhancementDerivativeSourceMatch =
    url.pathname.match(
      PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_SOURCE_PATH
    );
  if (
    processorAudioEnhancementDerivativeSourceMatch
    && method === "POST"
  ) {
    return getAudioEnhancementDerivativeProcessorSource(
      request,
      env,
      processorAudioEnhancementDerivativeSourceMatch[1]
    );
  }
  const processorAudioEnhancementDerivativePartMatch =
    url.pathname.match(
      PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_PART_PATH
    );
  if (
    processorAudioEnhancementDerivativePartMatch
    && method === "PUT"
  ) {
    return uploadAudioEnhancementDerivativeProcessorPart(
      request,
      env,
      processorAudioEnhancementDerivativePartMatch[1],
      processorAudioEnhancementDerivativePartMatch[2]
    );
  }
  const processorAudioEnhancementDerivativeUploadCompleteMatch =
    url.pathname.match(
      PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_UPLOAD_COMPLETE_PATH
    );
  if (
    processorAudioEnhancementDerivativeUploadCompleteMatch
    && method === "POST"
  ) {
    return completeAudioEnhancementDerivativeMultipartUpload(
      request,
      env,
      processorAudioEnhancementDerivativeUploadCompleteMatch[1]
    );
  }
  const processorAudioEnhancementDerivativeCompleteMatch =
    url.pathname.match(
      PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_COMPLETE_PATH
    );
  if (
    processorAudioEnhancementDerivativeCompleteMatch
    && method === "POST"
  ) {
    return completeAudioEnhancementDerivative(
      request,
      env,
      processorAudioEnhancementDerivativeCompleteMatch[1]
    );
  }
  const processorDeliveryAudioManifestMatch = url.pathname.match(
    PROCESSOR_DELIVERY_AUDIO_MANIFEST_PATH
  );
  if (processorDeliveryAudioManifestMatch && method === "POST") {
    return getDeliveryAudioProcessorManifest(
      request,
      env,
      processorDeliveryAudioManifestMatch[1]
    );
  }
  const processorDeliveryAudioSourceMatch = url.pathname.match(
    PROCESSOR_DELIVERY_AUDIO_SOURCE_PATH
  );
  if (processorDeliveryAudioSourceMatch && method === "POST") {
    return getDeliveryAudioProcessorSource(
      request,
      env,
      processorDeliveryAudioSourceMatch[1]
    );
  }
  const processorDeliveryAudioPartMatch = url.pathname.match(
    PROCESSOR_DELIVERY_AUDIO_PART_PATH
  );
  if (processorDeliveryAudioPartMatch && method === "PUT") {
    return uploadDeliveryAudioProcessorPart(
      request,
      env,
      processorDeliveryAudioPartMatch[1],
      processorDeliveryAudioPartMatch[2]
    );
  }
  const processorDeliveryAudioUploadCompleteMatch = url.pathname.match(
    PROCESSOR_DELIVERY_AUDIO_UPLOAD_COMPLETE_PATH
  );
  if (
    processorDeliveryAudioUploadCompleteMatch
    && method === "POST"
  ) {
    return completeDeliveryAudioMultipartUpload(
      request,
      env,
      processorDeliveryAudioUploadCompleteMatch[1]
    );
  }
  const processorDeliveryAudioCompleteMatch = url.pathname.match(
    PROCESSOR_DELIVERY_AUDIO_COMPLETE_PATH
  );
  if (processorDeliveryAudioCompleteMatch && method === "POST") {
    return completeDeliveryAudioJob(
      request,
      env,
      processorDeliveryAudioCompleteMatch[1]
    );
  }
  const processorTranscriptionChunkCompleteMatch = url.pathname.match(
    PROCESSOR_TRANSCRIPTION_CHUNK_COMPLETE_PATH
  );
  if (processorTranscriptionChunkCompleteMatch && method === "POST") {
    return completeTranscriptionChunkRun(
      request,
      env,
      processorTranscriptionChunkCompleteMatch[1]
    );
  }
  const processorTranscriptionChunkManifestMatch = url.pathname.match(
    PROCESSOR_TRANSCRIPTION_CHUNK_MANIFEST_PATH
  );
  if (processorTranscriptionChunkManifestMatch && method === "POST") {
    return getTranscriptionChunkProcessorManifest(
      request,
      env,
      processorTranscriptionChunkManifestMatch[1]
    );
  }
  const processorTranscriptionChunkSourceMatch = url.pathname.match(
    PROCESSOR_TRANSCRIPTION_CHUNK_SOURCE_PATH
  );
  if (processorTranscriptionChunkSourceMatch && method === "POST") {
    return getTranscriptionChunkProcessorSource(
      request,
      env,
      processorTranscriptionChunkSourceMatch[1]
    );
  }
  const processorTranscriptionChunkOutputMatch = url.pathname.match(
    PROCESSOR_TRANSCRIPTION_CHUNK_OUTPUT_PATH
  );
  if (processorTranscriptionChunkOutputMatch && method === "PUT") {
    return uploadTranscriptionChunkProcessorOutput(
      request,
      env,
      processorTranscriptionChunkOutputMatch[1],
      processorTranscriptionChunkOutputMatch[2]
    );
  }
  const processorAlignmentCompleteMatch = url.pathname.match(
    PROCESSOR_ALIGNMENT_COMPLETE_PATH
  );
  if (processorAlignmentCompleteMatch && method === "POST") {
    return completeAlignmentProcessorJob(
      request,
      env,
      processorAlignmentCompleteMatch[1]
    );
  }
  const processorAlignmentManifestMatch = url.pathname.match(
    PROCESSOR_ALIGNMENT_MANIFEST_PATH
  );
  if (processorAlignmentManifestMatch && method === "POST") {
    return getAlignmentProcessorManifest(
      request,
      env,
      processorAlignmentManifestMatch[1]
    );
  }
  const processorAlignmentSourceMatch = url.pathname.match(
    PROCESSOR_ALIGNMENT_SOURCE_PATH
  );
  if (processorAlignmentSourceMatch && method === "POST") {
    return getAlignmentProcessorSource(
      request,
      env,
      processorAlignmentSourceMatch[1]
    );
  }

  const knownPath = url.pathname === "/health"
    || url.pathname.startsWith("/v1/shows")
    || url.pathname.startsWith("/v1/admin")
    || url.pathname.startsWith("/v1/ads")
    || url.pathname.startsWith("/v1/diagnostics")
    || url.pathname.startsWith("/v1/internal")
    || url.pathname.startsWith("/v1/member")
    || url.pathname.startsWith("/v1/notifications")
    || url.pathname.startsWith("/v1/private")
    || url.pathname.startsWith("/v1/processor")
    || url.pathname.startsWith("/v1/webhooks")
    || Boolean(feedMatch)
    || Boolean(mediaMatch)
    || Boolean(publicEpisodePeaksMatch)
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
