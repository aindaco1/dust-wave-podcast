export const SHOW_PATH = /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
export const SHOW_TAX_QUOTE_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/tax\/quote$/;
export const SHOW_CHECKOUT_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/checkout$/;
export const SHOW_EPISODE_TRANSCRIPTS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts$/;
export const SHOW_EPISODE_TRANSCRIPT_VTT_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts\/(en|es)\.vtt$/;
export const SHOW_EPISODE_CHAPTERS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
export const SHOW_EPISODE_CLIPS_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/clips$/;
export const SHOW_EPISODE_CLIP_MEDIA_PATH =
  /^\/v1\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/clips\/([a-z0-9]+(?:-[a-z0-9]+)*)\.mp4$/;
export const FEED_PATH = /^\/(?:v1\/feeds\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
export const MEDIA_PATH = /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)(?:\/audio)?$/;
export const PUBLIC_EPISODE_PEAKS_PATH =
  /^\/(?:v1\/media\/|episodes\/)([A-Za-z0-9_-]+)\/peaks$/;
export const PRIVATE_FEED_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/rss\.xml$/;
export const PRIVATE_MEDIA_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/episodes\/([A-Za-z0-9_-]+)\/audio$/;
export const PRIVATE_CHAPTERS_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapters\.json$/;
export const PRIVATE_TRANSCRIPT_VTT_PATH =
  /^\/v1\/private\/([A-Za-z0-9_-]{43})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/transcripts\/(en|es)\.vtt$/;
export const MEMBER_SHOW_FEED_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/feed$/;
export const MEMBER_SHOW_FEED_ROTATE_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/feed\/rotate$/;
export const MEMBER_SHOW_PORTAL_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/billing\/portal$/;
export const MEMBER_SHOW_NOTIFICATIONS_PATH =
  /^\/v1\/member\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/notifications$/;
export const MEMBER_POOL_REDEMPTION_PATH = "/v1/member/redemptions/pool";
export const INTERNAL_POOL_GRANTS_PATH = "/v1/internal/pool/grants";
export const ADMIN_SHOW_PATH = /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)$/;
export const ADMIN_SHOW_SITE_PROJECTION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/site-projection$/;
export const ADMIN_SHOW_PREMIUM_PRICES_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/premium-prices$/;
export const ADMIN_SHOW_TAX_POLICY_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/tax-policy$/;
export const ADMIN_SHOW_AUDIO_QC_POLICY_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/audio-qc-policy$/;
export const ADMIN_SHOW_CLIPS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/clips$/;
export const ADMIN_SHOW_EPISODES_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/episodes$/;
export const ADMIN_SHOW_RSS_IMPORT_PREVIEW_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/preview$/;
export const ADMIN_SHOW_RSS_IMPORT_PODCAST_GUID_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/podcast-guid$/;
export const ADMIN_SHOW_RSS_IMPORT_PLANS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/rss-import\/plans$/;
export const ADMIN_RSS_IMPORT_PLAN_REVIEW_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/review$/;
export const ADMIN_RSS_IMPORT_PLAN_CANCEL_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/cancel$/;
export const ADMIN_RSS_IMPORT_PLAN_EXECUTION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/execution$/;
export const ADMIN_RSS_IMPORT_PLAN_RECONCILIATION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/reconciliation$/;
export const ADMIN_RSS_IMPORT_REDIRECT_ATTESTATION_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/redirect-attestation$/;
export const ADMIN_RSS_IMPORT_CUTOVER_PACKET_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/cutover-packet$/;
export const ADMIN_RSS_IMPORT_REDIRECT_ACTIVATION_APPROVAL_PATH =
  /^\/v1\/admin\/rss-import\/plans\/([A-Za-z0-9_-]+)\/redirect-activation-approval$/;
export const ADMIN_SHOW_MARKETING_DRY_RUN_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements\/dry-run$/;
export const ADMIN_SHOW_MARKETING_ANNOUNCEMENTS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements$/;
export const ADMIN_SHOW_MARKETING_APPROVE_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/announcements\/approve$/;
export const ADMIN_SHOW_MARKETING_LINKS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/links$/;
export const ADMIN_SHOW_MARKETING_LINK_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/marketing\/links\/([A-Za-z0-9_-]+)$/;
export const ADMIN_SHOW_ANALYTICS_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/analytics\/overview$/;
export const ADMIN_SHOW_ANALYTICS_CSV_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/analytics\/overview\.csv$/;
export const ANNOUNCEMENT_UNSUBSCRIBE_PATH =
  /^\/v1\/notifications\/unsubscribe\/([A-Za-z0-9_-]{43})$/;
export const ADMIN_SHOW_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
export const ADMIN_SHOW_FEED_VALIDATION_PATH =
  /^\/v1\/admin\/shows\/([A-Za-z0-9_-]+)\/feed-validation$/;
export const ADMIN_EPISODE_PATH = /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)$/;
export const ADMIN_EPISODE_SHOW_NOTES_DRAFT_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/show-notes\/draft$/;
export const ADMIN_EPISODE_SHOW_NOTES_DRAFTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/show-notes\/drafts$/;
export const ADMIN_EPISODE_CHAPTER_DRAFT_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters\/draft$/;
export const ADMIN_EPISODE_CHAPTER_DRAFTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters\/drafts$/;
export const ADMIN_EPISODE_CLIP_DRAFT_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips\/draft$/;
export const ADMIN_EPISODE_CLIP_DRAFTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips\/drafts$/;
export const ADMIN_EPISODE_PUBLISH_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/publish$/;
export const ADMIN_EPISODE_READINESS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/readiness$/;
export const ADMIN_EPISODE_YOUTUBE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/youtube$/;
export const ADMIN_EPISODE_YOUTUBE_AUDIO_RENDITIONS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/youtube-audio-renditions$/;
export const ADMIN_EPISODE_AUDIO_QC_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-qc$/;
export const ADMIN_EPISODE_AUDIO_MASTER_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-master$/;
export const ADMIN_EPISODE_AUDIO_MASTER_APPROVE_SOURCE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-master\/approve-source$/;
export const ADMIN_EPISODE_AUDIO_ENHANCEMENT_PREVIEWS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-enhancement-previews$/;
export const ADMIN_EPISODE_AUDIO_ENHANCEMENT_DERIVATIVES_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/audio-enhancement-derivatives$/;
export const ADMIN_EPISODE_DELIVERY_AUDIO_JOBS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/delivery-audio-jobs$/;
export const ADMIN_AUDIO_ENHANCEMENT_MEDIA_PATH =
  /^\/v1\/admin\/audio-enhancements\/([A-Za-z0-9_-]+)\/media\/(original|enhanced)$/;
export const ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_APPROVE_PATH =
  /^\/v1\/admin\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_REJECT_PATH =
  /^\/v1\/admin\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/reject$/;
export const ADMIN_AUDIO_ENHANCEMENT_DERIVATIVE_MEDIA_PATH =
  /^\/v1\/admin\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/media$/;
export const ADMIN_DELIVERY_AUDIO_APPROVE_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_DELIVERY_AUDIO_MEDIA_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/media$/;
export const ADMIN_DELIVERY_AUDIO_PEAKS_PATH =
  /^\/v1\/admin\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/peaks$/;
export const ADMIN_EPISODE_DISTRIBUTION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution$/;
export const ADMIN_EPISODE_DISTRIBUTION_RETRY_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)\/retry$/;
export const ADMIN_EPISODE_DISTRIBUTION_DESTINATION_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/distribution\/([A-Za-z0-9_-]+)$/;
export const ADMIN_EPISODE_TRANSCRIPTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts$/;
export const ADMIN_EPISODE_TRANSCRIPTION_JOBS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcription-jobs$/;
export const ADMIN_EPISODE_ALIGNMENTS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/alignments$/;
export const ADMIN_EPISODE_ALIGNMENT_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/alignments\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_EPISODE_TRANSCRIPT_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)$/;
export const ADMIN_EPISODE_TRANSCRIPT_CAPTIONS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)\/captions\.(vtt|srt)$/;
export const ADMIN_EPISODE_TRANSCRIPT_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/transcripts\/(en|es)\/approve$/;
export const ADMIN_EPISODE_CHAPTERS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters$/;
export const ADMIN_EPISODE_CHAPTERS_APPROVE_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/chapters\/approve$/;
export const ADMIN_EPISODE_REVIEWS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/reviews$/;
export const ADMIN_REVIEW_PATH =
  /^\/v1\/admin\/reviews\/([A-Za-z0-9_-]+)$/;
export const ADMIN_REVIEW_COMMENT_PATH =
  /^\/v1\/admin\/review-comments\/([A-Za-z0-9_-]+)$/;
export const ADMIN_EPISODE_CLIPS_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips$/;
export const ADMIN_EPISODE_CLIP_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/clips\/([A-Za-z0-9_-]+)$/;
export const ADMIN_CLIP_RENDER_PATH =
  /^\/v1\/admin\/clips\/([A-Za-z0-9_-]+)\/render$/;
export const ADMIN_CLIP_RENDER_MEDIA_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/media$/;
export const ADMIN_CLIP_RENDER_CAPTIONS_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/captions\.(vtt|srt)$/;
export const ADMIN_CLIP_RENDER_YOUTUBE_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/youtube$/;
export const ADMIN_CLIP_RENDER_PUBLICATION_PATH =
  /^\/v1\/admin\/clip-renders\/([A-Za-z0-9_-]+)\/publication$/;
export const ADMIN_CLIP_PUBLICATION_APPROVE_PATH =
  /^\/v1\/admin\/clip-publications\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_CLIP_PUBLICATION_WITHDRAW_PATH =
  /^\/v1\/admin\/clip-publications\/([A-Za-z0-9_-]+)\/withdraw$/;
export const ADMIN_CLIP_YOUTUBE_APPROVE_PATH =
  /^\/v1\/admin\/clip-youtube-publications\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_EPISODE_YOUTUBE_APPROVE_PATH =
  /^\/v1\/admin\/episode-youtube-publications\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_EPISODE_YOUTUBE_RECONCILE_PATH =
  /^\/v1\/admin\/episode-youtube-publications\/([A-Za-z0-9_-]+)\/reconcile$/;
export const ADMIN_EPISODE_AD_PLAN_PATH =
  /^\/v1\/admin\/episodes\/([A-Za-z0-9_-]+)\/ad-plan$/;
export const ADMIN_UPLOAD_PART_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/parts\/(\d+)$/;
export const ADMIN_UPLOAD_COMPLETE_PATH =
  /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)\/complete$/;
export const ADMIN_UPLOAD_PATH = /^\/v1\/admin\/uploads\/([A-Za-z0-9_-]+)$/;
export const ADMIN_AD_CAMPAIGN_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)$/;
export const ADMIN_AD_CAMPAIGN_APPROVE_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_AD_CAMPAIGN_KILL_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/kill$/;
export const ADMIN_AD_CAMPAIGN_CREATIVES_PATH =
  /^\/v1\/admin\/ads\/campaigns\/([A-Za-z0-9_-]+)\/creatives$/;
export const ADMIN_AD_CREATIVE_AUDIO_PATH =
  /^\/v1\/admin\/ads\/creatives\/([A-Za-z0-9_-]+)\/audio$/;
export const ADMIN_AD_CREATIVE_VALIDATE_PATH =
  /^\/v1\/admin\/ads\/creatives\/([A-Za-z0-9_-]+)\/validate$/;
export const ADMIN_AD_PLAN_APPROVE_PATH =
  /^\/v1\/admin\/ads\/plans\/([A-Za-z0-9_-]+)\/approve$/;
export const ADMIN_AD_PLAN_REJECT_PATH =
  /^\/v1\/admin\/ads\/plans\/([A-Za-z0-9_-]+)\/reject$/;
export const PROCESSOR_DISPATCH_CLAIM_PATH =
  "/v1/processor/dispatches/claim";
export const PROCESSOR_DISPATCH_RESULT_PATH =
  /^\/v1\/processor\/dispatches\/([A-Za-z0-9_-]+)\/(dispatched|failed)$/;
export const PROCESSOR_AD_PLAN_COMPLETE_PATH =
  /^\/v1\/processor\/ad-plans\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_CLIP_RENDER_COMPLETE_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_CLIP_RENDER_MANIFEST_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_CLIP_RENDER_SOURCE_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_CLIP_RENDER_OUTPUT_PATH =
  /^\/v1\/processor\/clip-renders\/([A-Za-z0-9_-]+)\/output$/;
export const PROCESSOR_YOUTUBE_AUDIO_RENDITION_MANIFEST_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_YOUTUBE_AUDIO_RENDITION_SOURCE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/sources\/(audio|artwork)$/;
export const PROCESSOR_YOUTUBE_AUDIO_RENDITION_PART_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
export const PROCESSOR_YOUTUBE_AUDIO_RENDITION_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/upload-complete$/;
export const PROCESSOR_YOUTUBE_AUDIO_RENDITION_COMPLETE_PATH =
  /^\/v1\/processor\/youtube-audio-renditions\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_AUDIO_QC_COMPLETE_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_AUDIO_QC_MANIFEST_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_AUDIO_QC_SOURCE_PATH =
  /^\/v1\/processor\/audio-qc\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_MANIFEST_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_SOURCE_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_OUTPUT_PATH =
  /^\/v1\/processor\/audio-enhancements\/([A-Za-z0-9_-]+)\/outputs\/(original|enhanced)$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_MANIFEST_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_SOURCE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_PART_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
export const PROCESSOR_AUDIO_ENHANCEMENT_DERIVATIVE_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/audio-enhancement-derivatives\/([A-Za-z0-9_-]+)\/upload-complete$/;
export const PROCESSOR_DELIVERY_AUDIO_COMPLETE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_DELIVERY_AUDIO_MANIFEST_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_DELIVERY_AUDIO_SOURCE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_DELIVERY_AUDIO_PART_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/parts\/([0-9]{1,5})$/;
export const PROCESSOR_DELIVERY_AUDIO_UPLOAD_COMPLETE_PATH =
  /^\/v1\/processor\/delivery-audio-jobs\/([A-Za-z0-9_-]+)\/upload-complete$/;
export const PROCESSOR_TRANSCRIPTION_CHUNK_COMPLETE_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_TRANSCRIPTION_CHUNK_MANIFEST_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_TRANSCRIPTION_CHUNK_SOURCE_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/source$/;
export const PROCESSOR_TRANSCRIPTION_CHUNK_OUTPUT_PATH =
  /^\/v1\/processor\/transcription-chunks\/([A-Za-z0-9_-]+)\/chunks\/([0-9]{1,3})$/;
export const PROCESSOR_ALIGNMENT_COMPLETE_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/complete$/;
export const PROCESSOR_ALIGNMENT_MANIFEST_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/manifest$/;
export const PROCESSOR_ALIGNMENT_SOURCE_PATH =
  /^\/v1\/processor\/alignments\/([A-Za-z0-9_-]+)\/source$/;
export const AD_DECISION_AUDIO_PATH =
  /^\/v1\/ads\/decisions\/([A-Za-z0-9_-]+)\/audio$/;
export const VIRTUAL_AUDIO_DIAGNOSTIC_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_.-]{80,180})(?:\/(virtual|baseline))?$/;
export const VIRTUAL_AUDIO_FIXTURE_OBJECT_PATH =
  /^\/v1\/diagnostics\/virtual-audio\/([A-Za-z0-9_.-]{80,180})\/objects\/([A-Za-z0-9.-]{1,100})$/;
export const ADMIN_USER_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)$/;
export const ADMIN_USER_ROLES_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles$/;
export const ADMIN_USER_ROLE_PATH =
  /^\/v1\/admin\/users\/([A-Za-z0-9_-]+)\/roles\/(super_admin|admin|producer|analyst)$/;
export const ADMIN_ALIGNMENT_BENCHMARKS_PATH =
  "/v1/admin/alignment-benchmarks";
