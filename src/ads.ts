import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  normalizeAdTargetValue,
  selectAdForSlot,
  type AdDeviceType,
  type AdPosition
} from "./ad-decision";
import { loadActiveAdInventory } from "./ad-inventory";
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

  const [campaigns, segmentResult, marker] =
    await Promise.all([
      loadActiveAdInventory(env.DB),
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
  const approvedCampaignCount = campaigns.filter(
    ({ approvalStatus }) => approvalStatus === "approved"
  ).length;
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
    campaigns.length > 0 && approvedCampaignCount === 0
      ? "campaign_approval_required"
      : null,
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
      approvedCampaignCount,
      fingerprint: inventoryFingerprint
    },
    decision: selection
      ? { status: "selected", selection }
      : { status: "fallback", reason: "no_eligible_inventory" }
  });
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
