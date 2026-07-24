import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  normalizeAdTargetValue,
  selectAdForSlot,
  type AdCampaignCandidate,
  type AdCreativeCandidate,
  type AdDeviceType,
  type AdPosition,
  type AdRuleCandidate
} from "./ad-decision";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validDateTime,
  validIdentifier
} from "./validation";

const PREVIEW_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const DEVICE_TYPES: AdDeviceType[] = [
  "mobile",
  "tablet",
  "desktop",
  "smart_speaker",
  "unknown"
];
const POSITIONS: AdPosition[] = ["pre", "mid", "post"];

type EpisodeAdRow = {
  id: string;
  show_id: string;
  publication_revision: number;
  episode_dynamic_ads_enabled: number;
  show_dynamic_ads_enabled: number;
};

type CampaignRow = {
  id: string;
  campaign_type: string;
  sponsor_active: number | null;
  active: number;
  starts_at: string;
  ends_at: string | null;
  kill_switch_at: string | null;
  priority: number;
  impression_cap: number | null;
  qualified_impression_goal: number | null;
  qualified_impressions: number;
  pacing_strategy: string;
};

type RuleRow = {
  id: string;
  campaign_id: string;
  show_id: string | null;
  episode_id: string | null;
  position: string | null;
  device_type: string | null;
  app_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
};

type CreativeRow = {
  id: string;
  campaign_id: string;
  audio_key: string;
  audio_bytes: number | null;
  audio_mime_type: string | null;
  stream_profile: string | null;
  weight: number;
  active: number;
  validation_status: string;
};

type SegmentRow = {
  sequence: number;
  stream_profile: string;
  validation_status: string;
};

export async function previewAdminAdDecision(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: PREVIEW_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, 20_000);
  const episodeId = validIdentifier(body.episodeId, "episodeId");
  const position = requiredText(body.position, "position", 8) as AdPosition;
  if (!POSITIONS.includes(position)) {
    throw new RequestValidationError("position must be pre, mid, or post");
  }
  const deviceType = requiredText(
    body.deviceType,
    "deviceType",
    32
  ) as AdDeviceType;
  if (!DEVICE_TYPES.includes(deviceType)) {
    throw new RequestValidationError("deviceType is invalid");
  }
  const appName = normalizeAdTargetValue(
    requiredText(body.appName, "appName", 100)
  );
  if (!appName) throw new RequestValidationError("appName is invalid");
  const streamProfile = requiredText(
    body.streamProfile,
    "streamProfile",
    200
  );
  const at = validDateTime(body.at, "at") ?? new Date().toISOString();

  const episode = await env.DB
    .prepare(
      `SELECT
         e.id, e.show_id, e.publication_revision,
         e.dynamic_ads_enabled AS episode_dynamic_ads_enabled,
         s.dynamic_ads_enabled AS show_dynamic_ads_enabled
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.id = ?`
    )
    .bind(episodeId)
    .first<EpisodeAdRow>();
  if (!episode) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  if (
    !hasAdminRoleForShow(
      auth.authorization.identity,
      PREVIEW_ROLES,
      episode.show_id
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "forbidden" },
      { status: 403 }
    );
  }

  const [campaignResult, ruleResult, creativeResult, segmentResult, marker] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           c.id, c.campaign_type, s.active AS sponsor_active, c.active,
           c.starts_at, c.ends_at, c.kill_switch_at, c.priority,
           c.impression_cap, c.qualified_impression_goal,
           c.qualified_impressions, c.pacing_strategy
         FROM ad_campaigns c
         LEFT JOIN sponsors s ON s.id = c.sponsor_id
         WHERE c.active = 1
         ORDER BY c.id`
      ).all<CampaignRow>(),
      env.DB.prepare(
        `SELECT
           r.id, r.campaign_id, r.show_id, r.episode_id, r.position,
           r.device_type, r.app_name, r.starts_at, r.ends_at
         FROM ad_rules r
         JOIN ad_campaigns c ON c.id = r.campaign_id
         WHERE c.active = 1
         ORDER BY r.campaign_id, r.id`
      ).all<RuleRow>(),
      env.DB.prepare(
        `SELECT
           a.id, a.campaign_id, a.audio_key, a.audio_bytes,
           a.audio_mime_type, a.stream_profile, a.weight, a.active,
           a.validation_status
         FROM ad_creatives a
         JOIN ad_campaigns c ON c.id = a.campaign_id
         WHERE c.active = 1
         ORDER BY a.campaign_id, a.id`
      ).all<CreativeRow>(),
      env.DB.prepare(
        `SELECT sequence, stream_profile, validation_status
         FROM episode_audio_segments
         WHERE episode_id = ?
         ORDER BY sequence`
      ).bind(episodeId).all<SegmentRow>(),
      env.DB.prepare(
        `SELECT id
         FROM episode_ad_markers
         WHERE episode_id = ?
           AND position = ?
           AND enabled = 1
           AND approved_at IS NOT NULL`
      ).bind(episodeId, position).first<{ id: string }>()
    ]);

  const campaigns = assembleCampaigns(
    campaignResult.results,
    ruleResult.results,
    creativeResult.results
  );
  const inventoryFingerprint = await sha256Hex(JSON.stringify(campaigns));
  const selection = selectAdForSlot(
    campaigns,
    {
      showId: episode.show_id,
      episodeId,
      position,
      deviceType,
      appName,
      streamProfile,
      now: at
    },
    `admin-preview|${episodeId}|${episode.publication_revision}|${inventoryFingerprint}|${at}`
  );
  const programSegmentsReady = segmentsAreReady(
    segmentResult.results,
    streamProfile
  );
  const blockers = [
    "runtime_not_connected",
    episode.show_dynamic_ads_enabled !== 1
      ? "show_dynamic_ads_disabled"
      : null,
    episode.episode_dynamic_ads_enabled !== 1
      ? "episode_dynamic_ads_disabled"
      : null,
    !marker ? "marker_not_approved" : null,
    !programSegmentsReady ? "program_segments_not_ready" : null,
    !selection ? "no_eligible_inventory" : null
  ].filter((value): value is string => Boolean(value));

  return privateJson(request, env.ALLOWED_ORIGINS, {
    previewOnly: true,
    persisted: false,
    publicDeliveryMode: "full_file_only",
    context: {
      showId: episode.show_id,
      episodeId,
      publicationRevision: episode.publication_revision,
      position,
      deviceType,
      appName,
      streamProfile,
      at
    },
    readiness: {
      showEnabled: episode.show_dynamic_ads_enabled === 1,
      episodeEnabled: episode.episode_dynamic_ads_enabled === 1,
      markerApproved: Boolean(marker),
      programSegmentsReady,
      activationReadyExceptRuntime: blockers.length === 1
        && blockers[0] === "runtime_not_connected",
      blockers
    },
    inventory: {
      campaignCount: campaigns.length,
      fingerprint: inventoryFingerprint
    },
    decision: selection
      ? { status: "selected", selection }
      : { status: "fallback", reason: "no_eligible_inventory" }
  });
}

function assembleCampaigns(
  campaignRows: CampaignRow[],
  ruleRows: RuleRow[],
  creativeRows: CreativeRow[]
): AdCampaignCandidate[] {
  const rules = new Map<string, AdRuleCandidate[]>();
  for (const row of ruleRows) {
    const target = rules.get(row.campaign_id) ?? [];
    target.push({
      id: row.id,
      showId: row.show_id,
      episodeId: row.episode_id,
      position: row.position as AdPosition | null,
      deviceType: row.device_type,
      appName: row.app_name,
      startsAt: row.starts_at,
      endsAt: row.ends_at
    });
    rules.set(row.campaign_id, target);
  }
  const creatives = new Map<string, AdCreativeCandidate[]>();
  for (const row of creativeRows) {
    const target = creatives.get(row.campaign_id) ?? [];
    target.push({
      id: row.id,
      campaignId: row.campaign_id,
      objectKey: row.audio_key,
      audioBytes: row.audio_bytes,
      audioMimeType: row.audio_mime_type,
      streamProfile: row.stream_profile,
      weight: row.weight,
      active: row.active === 1,
      validationStatus: row.validation_status as AdCreativeCandidate["validationStatus"]
    });
    creatives.set(row.campaign_id, target);
  }
  return campaignRows.map((row) => ({
    id: row.id,
    campaignType: row.campaign_type as AdCampaignCandidate["campaignType"],
    sponsorActive: row.sponsor_active === 1,
    active: row.active === 1,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    killSwitchAt: row.kill_switch_at,
    priority: row.priority,
    impressionCap: row.impression_cap,
    qualifiedImpressionGoal: row.qualified_impression_goal,
    qualifiedImpressions: row.qualified_impressions,
    pacingStrategy: row.pacing_strategy as AdCampaignCandidate["pacingStrategy"],
    rules: rules.get(row.id) ?? [],
    creatives: creatives.get(row.id) ?? []
  }));
}

function segmentsAreReady(
  rows: SegmentRow[],
  streamProfile: string
): boolean {
  return rows.length > 0 && rows.every((row, index) =>
    row.sequence === index
    && row.validation_status === "ready"
    && row.stream_profile === streamProfile
  );
}
