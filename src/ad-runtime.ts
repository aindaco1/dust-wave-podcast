import {
  hmacSha256,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import {
  buildAdRequestKey,
  normalizeAdTargetValue,
  selectAdSlots,
  type AdDeviceType,
  type AdPosition,
  type AdSlotDecision,
  type NormalizedPodcastClient
} from "./ad-decision";
import { loadActiveAdInventory } from "./ad-inventory";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { DYNAMIC_AD_MP3_PROFILE } from "./mp3-profile";
import {
  compileVirtualMediaManifest,
  serveVirtualMedia,
  type VirtualMediaManifest,
  type VirtualMediaSegment
} from "./virtual-media";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const ISSUE_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const DEVICE_TYPES: AdDeviceType[] = [
  "mobile",
  "tablet",
  "desktop",
  "smart_speaker",
  "unknown"
];
const POSITION_ORDER: Record<AdPosition, number> = {
  pre: 0,
  mid: 1,
  post: 2
};
const DECISION_LIFETIME_SECONDS = 2 * 60 * 60;
const QUALIFICATION_GRACE_SECONDS = 24 * 60 * 60;
const SIGNATURE_VERSION = "hmac-sha256-v1";

type RuntimeEpisodeRow = {
  id: string;
  show_id: string;
  publication_revision: number;
  status: string;
  media_status: string;
  audio_key: string | null;
  audio_bytes: number | null;
  audio_mime_type: string | null;
  audio_etag: string | null;
  episode_dynamic_ads_enabled: number;
  show_dynamic_ads_enabled: number;
};

type RuntimeMarkerRow = {
  id: string;
  plan_id: string | null;
  position: AdPosition;
  starts_at_ms: number | null;
  approved_at: string | null;
};

type RuntimeProgramSegmentRow = {
  id: string;
  plan_id: string | null;
  sequence: number;
  object_key: string;
  object_bytes: number;
  source_offset: number;
  byte_length: number;
  audio_mime_type: string;
  stream_profile: string;
  sha256: string;
  source_etag: string | null;
  validation_status: string;
  validated_at: string | null;
};

type StoredDecisionRow = {
  id: string;
  episode_id: string;
  publication_revision: number;
  request_key_hash: string;
  status: string;
  manifest_json: string | null;
  manifest_etag: string | null;
  manifest_sha256: string | null;
  total_bytes: number | null;
  expires_at: string;
  qualification_expires_at: string | null;
};

type QualificationSlotRow = {
  id: string;
  decision_id: string;
  campaign_id: string | null;
  creative_id: string | null;
  creative_object_bytes: number | null;
  status: string;
  qualification_expires_at: string | null;
  impression_cap: number | null;
  qualified_impressions: number | null;
};

export type TrustedQualificationResult =
  | {
      status: "qualified";
      qualificationId: string;
      idempotent: boolean;
    }
  | {
      status: "cap_reached";
      qualificationId: null;
      idempotent: false;
    };

export async function issueAdminStagingAdDecision(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!stagingDecisionRuntimeEnabled(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: ISSUE_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, 20_000);
  const episodeId = validIdentifier(body.episodeId, "episodeId");
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
    body.streamProfile ?? DYNAMIC_AD_MP3_PROFILE,
    "streamProfile",
    200
  );
  if (streamProfile !== DYNAMIC_AD_MP3_PROFILE) {
    throw new RequestValidationError(
      `streamProfile must be ${DYNAMIC_AD_MP3_PROFILE}`
    );
  }

  const episode = await loadRuntimeEpisode(env.DB, episodeId);
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
      ISSUE_ROLES,
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
  if (
    episode.status !== "published"
    || episode.media_status !== "ready"
    || !episode.audio_key
    || !episode.audio_bytes
    || episode.audio_mime_type !== "audio/mpeg"
    || !episode.audio_etag
    || episode.publication_revision < 1
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_ready_for_ad_decision" },
      { status: 409 }
    );
  }

  const [campaigns, markerResult, segmentResult] = await Promise.all([
    loadActiveAdInventory(env.DB),
    env.DB.prepare(
      `SELECT id, plan_id, position, starts_at_ms, approved_at
       FROM episode_ad_markers
       WHERE episode_id = ? AND enabled = 1
       ORDER BY
         CASE position WHEN 'pre' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END`
    ).bind(episode.id).all<RuntimeMarkerRow>(),
    env.DB.prepare(
      `SELECT
         id, plan_id, sequence, object_key, object_bytes, source_offset,
         byte_length, audio_mime_type, stream_profile, sha256, source_etag,
         validation_status, validated_at
       FROM episode_audio_segments
       WHERE episode_id = ?
       ORDER BY sequence`
    ).bind(episode.id).all<RuntimeProgramSegmentRow>()
  ]);
  const markers = validateRuntimeMarkers(markerResult.results);
  const programSegments = validateRuntimeProgramSegments(
    segmentResult.results,
    markers,
    streamProfile,
    episode.audio_etag
  );
  const inventoryFingerprint = await sha256Hex(JSON.stringify({
    campaigns,
    markers: markers.map((marker) => ({
      id: marker.id,
      planId: marker.plan_id,
      position: marker.position,
      startsAtMs: marker.starts_at_ms,
      approvedAt: marker.approved_at
    })),
    programSegments: programSegments.map((segment) => ({
      id: segment.id,
      planId: segment.plan_id,
      sequence: segment.sequence,
      objectKey: segment.object_key,
      objectBytes: segment.object_bytes,
      sha256: segment.sha256,
      validatedAt: segment.validated_at
    }))
  }));
  const now = new Date();
  const client: NormalizedPodcastClient = { deviceType, appName };
  const requestKey = await buildAdRequestKey({
    secret: env.AD_DECISION_SIGNING_SECRET as string,
    episodeId: episode.id,
    publicationRevision: episode.publication_revision,
    inventoryFingerprint,
    clientAddress: request.headers.get("cf-connecting-ip"),
    client,
    now: now.toISOString()
  });
  const existing = await loadDecisionByRequestKey(
    env.DB,
    episode.id,
    episode.publication_revision,
    requestKey.requestKeyHash
  );
  if (existing) {
    return presentIssuedDecision(request, env, existing, true, {
      showEnabled: episode.show_dynamic_ads_enabled === 1,
      episodeEnabled: episode.episode_dynamic_ads_enabled === 1
    });
  }

  const positions = markers.map((marker) => marker.position);
  const slotDecisions = selectAdSlots(
    campaigns,
    {
      showId: episode.show_id,
      episodeId: episode.id,
      deviceType,
      appName,
      streamProfile,
      now: now.toISOString()
    },
    positions,
    requestKey.selectionSeed
  );
  const missingPositions = slotDecisions
    .filter((slot) => !slot.selection)
    .map((slot) => slot.position);
  if (missingPositions.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "complete_ad_rendition_unavailable",
        missingPositions,
        persisted: false,
        runtimeEnabled: false
      },
      { status: 409 }
    );
  }
  validateSelectedCreativeSnapshots(slotDecisions, streamProfile);
  const objectEtags = await verifyRuntimeObjects(
    env.MEDIA_BUCKET,
    programSegments,
    slotDecisions
  );

  const decisionId = `decision_${requestKey.requestKeyHash.slice(0, 48)}`;
  const manifest = await buildDecisionManifest(
    episode,
    decisionId,
    streamProfile,
    now.toISOString(),
    markers,
    programSegments,
    slotDecisions,
    objectEtags
  );
  const compiled = compileVirtualMediaManifest(manifest);
  const manifestJson = JSON.stringify(manifest);
  const manifestSha256 = await sha256Hex(manifestJson);
  const expiresAt = new Date(
    now.getTime() + DECISION_LIFETIME_SECONDS * 1_000
  ).toISOString();
  const qualificationExpiresAt = new Date(
    now.getTime()
      + (DECISION_LIFETIME_SECONDS + QUALIFICATION_GRACE_SECONDS) * 1_000
  ).toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO ad_decisions (
         id, show_id, episode_id, publication_revision, request_key_hash,
         privacy_epoch, decision_epoch, device_type, app_name, status,
         selection_context_json, manifest_json, manifest_etag, total_bytes,
         expires_at, inventory_fingerprint, manifest_sha256,
         signature_version, qualification_expires_at, issued_by
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, 'selected', ?, ?, ?, ?, ?, ?, ?, ?, ?,
         'staging_admin'
       )`
    ).bind(
      decisionId,
      episode.show_id,
      episode.id,
      episode.publication_revision,
      requestKey.requestKeyHash,
      requestKey.privacyEpoch,
      requestKey.decisionEpoch,
      deviceType,
      appName,
      JSON.stringify({
        showId: episode.show_id,
        episodeId: episode.id,
        publicationRevision: episode.publication_revision,
        deviceType,
        appName,
        streamProfile,
        inventoryFingerprint
      }),
      manifestJson,
      manifest.etag,
      compiled.totalBytes,
      expiresAt,
      inventoryFingerprint,
      manifestSha256,
      SIGNATURE_VERSION,
      qualificationExpiresAt
    )
  ];
  for (const slot of slotDecisions) {
    const selection = slot.selection;
    if (!selection) continue;
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ad_decision_slots (
         id, decision_id, marker_id, position, campaign_id, creative_id,
         selection_reason_json, campaign_revision, creative_object_key,
         creative_object_bytes, creative_object_etag, creative_sha256,
         creative_duration_ms, stream_profile
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `${decisionId}_${slot.position}`,
      decisionId,
      markers.find(({ position }) => position === slot.position)?.id ?? null,
      slot.position,
      selection.campaignId,
      selection.creativeId,
      JSON.stringify(selection.reason),
      selection.campaignRevision,
      selection.objectKey,
      selection.audioBytes,
      selection.creativeEtag,
      selection.creativeSha256,
      selection.creativeDurationMs,
      selection.streamProfile
    ));
  }
  statements.push(prepareAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "ad_decision.staging_issued",
    targetType: "ad_decision",
    targetId: decisionId,
    metadata: {
      episodeId: episode.id,
      showId: episode.show_id,
      publicationRevision: episode.publication_revision,
      slotCount: slotDecisions.length,
      totalBytes: compiled.totalBytes,
      manifestSha256,
      runtimeEnabled: false
    }
  }));
  await env.DB.batch(statements);

  const stored = await loadDecision(env.DB, decisionId);
  if (
    !stored
    || stored.manifest_sha256 !== manifestSha256
    || stored.manifest_json !== manifestJson
  ) {
    throw new Error("The immutable decision did not persist as issued.");
  }
  return presentIssuedDecision(request, env, stored, false, {
    showEnabled: episode.show_dynamic_ads_enabled === 1,
    episodeEnabled: episode.episode_dynamic_ads_enabled === 1
  });
}

export async function serveStagingAdDecisionAudio(
  request: Request,
  env: PodcastEnv,
  decisionIdValue: string
): Promise<Response> {
  if (!stagingDecisionRuntimeEnabled(env)) {
    return decisionError("not_found", 404);
  }
  const decisionId = validIdentifier(decisionIdValue, "decisionId");
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const manifestSha256 = url.searchParams.get("manifest") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(expires)
    || expires < nowSeconds
    || expires > nowSeconds + DECISION_LIFETIME_SECONDS
    || !/^[a-f0-9]{64}$/.test(manifestSha256)
    || !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return decisionError("invalid_ad_decision_signature", 401);
  }
  const expected = await signDecision(
    decisionId,
    expires,
    manifestSha256,
    env.AD_DECISION_SIGNING_SECRET as string
  );
  if (!timingSafeEqual(signature, expected)) {
    return decisionError("invalid_ad_decision_signature", 401);
  }

  const decision = await loadDecision(env.DB, decisionId);
  if (
    !decision
    || decision.status !== "selected"
    || decision.manifest_sha256 !== manifestSha256
    || !decision.manifest_json
    || !decision.manifest_etag
    || Date.parse(decision.expires_at) < Date.now()
    || Math.floor(Date.parse(decision.expires_at) / 1_000) !== expires
  ) {
    return decisionError("ad_decision_unavailable", 404);
  }
  const manifest = parseStoredManifest(decision.manifest_json);
  if (
    manifest.decisionId !== decision.id
    || manifest.episodeId !== decision.episode_id
    || manifest.etag !== decision.manifest_etag
    || await sha256Hex(decision.manifest_json) !== decision.manifest_sha256
  ) {
    return decisionError("ad_decision_manifest_mismatch", 409);
  }
  if (!await preflightStoredManifest(env.MEDIA_BUCKET, manifest)) {
    return decisionError("ad_decision_object_mismatch", 409);
  }
  return serveVirtualMedia(request, env.MEDIA_BUCKET, manifest);
}

export async function recordTrustedDownloadQualification(
  db: D1Database,
  {
    decisionId: decisionIdValue,
    decisionSlotId: decisionSlotIdValue,
    bytesServed,
    secret,
    now = new Date()
  }: {
    decisionId: string;
    decisionSlotId: string;
    bytesServed: number;
    secret: string;
    now?: Date;
  }
): Promise<TrustedQualificationResult> {
  const decisionId = validIdentifier(decisionIdValue, "decisionId");
  const decisionSlotId = validIdentifier(
    decisionSlotIdValue,
    "decisionSlotId"
  );
  if (
    !secret
    || !Number.isSafeInteger(bytesServed)
    || bytesServed < 0
    || !Number.isFinite(now.getTime())
  ) {
    throw new RequestValidationError(
      "Trusted download qualification evidence is invalid"
    );
  }
  const slot = await db.prepare(
    `SELECT
       s.id, s.decision_id, s.campaign_id, s.creative_id,
       s.creative_object_bytes, d.status, d.qualification_expires_at,
       c.impression_cap, c.qualified_impressions
     FROM ad_decision_slots s
     JOIN ad_decisions d ON d.id = s.decision_id
     LEFT JOIN ad_campaigns c ON c.id = s.campaign_id
     WHERE s.id = ? AND s.decision_id = ?`
  ).bind(decisionSlotId, decisionId).first<QualificationSlotRow>();
  if (
    !slot
    || slot.status !== "selected"
    || !slot.campaign_id
    || !slot.creative_id
    || !slot.creative_object_bytes
    || !slot.qualification_expires_at
    || Date.parse(slot.qualification_expires_at) < now.getTime()
    || bytesServed < slot.creative_object_bytes
  ) {
    throw new RequestValidationError(
      "The decision slot does not have complete trusted delivery evidence",
      "ad_qualification_not_ready",
      409
    );
  }
  const qualificationKey = await hmacSha256(
    `ad-qualification-v1|${decisionId}|${decisionSlotId}|download_complete`,
    secret,
    "hex"
  );
  const qualificationId = `qualification_${qualificationKey.slice(0, 48)}`;
  const result = await db.prepare(
    `INSERT OR IGNORE INTO ad_impression_qualifications (
       id, decision_id, decision_slot_id, campaign_id, creative_id,
       qualification_key, qualification_reason, bytes_served, qualified_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'download_complete', ?, ?)`
  ).bind(
    qualificationId,
    decisionId,
    decisionSlotId,
    slot.campaign_id,
    slot.creative_id,
    qualificationKey,
    bytesServed,
    now.toISOString()
  ).run();
  const recorded = await db.prepare(
    `SELECT id
     FROM ad_impression_qualifications
     WHERE qualification_key = ?`
  ).bind(qualificationKey).first<{ id: string }>();
  if (recorded) {
    return {
      status: "qualified",
      qualificationId: recorded.id,
      idempotent: Number(result.meta.changes ?? 0) === 0
    };
  }
  const campaign = await db.prepare(
    `SELECT impression_cap, qualified_impressions
     FROM ad_campaigns
     WHERE id = ?`
  ).bind(slot.campaign_id).first<{
    impression_cap: number | null;
    qualified_impressions: number;
  }>();
  if (
    campaign?.impression_cap
    && campaign.qualified_impressions >= campaign.impression_cap
  ) {
    return {
      status: "cap_reached",
      qualificationId: null,
      idempotent: false
    };
  }
  throw new Error("Qualification was neither recorded nor blocked by its cap.");
}

async function loadRuntimeEpisode(
  db: D1Database,
  episodeId: string
): Promise<RuntimeEpisodeRow | null> {
  return db.prepare(
    `SELECT
       e.id, e.show_id, e.publication_revision, e.status, e.media_status,
       e.audio_key, e.audio_bytes, e.audio_mime_type, e.audio_etag,
       e.dynamic_ads_enabled AS episode_dynamic_ads_enabled,
       s.dynamic_ads_enabled AS show_dynamic_ads_enabled
     FROM episodes e
     JOIN shows s ON s.id = e.show_id
     WHERE e.id = ?`
  ).bind(episodeId).first<RuntimeEpisodeRow>();
}

async function loadDecisionByRequestKey(
  db: D1Database,
  episodeId: string,
  publicationRevision: number,
  requestKeyHash: string
): Promise<StoredDecisionRow | null> {
  return db.prepare(
    `SELECT
       id, episode_id, publication_revision, request_key_hash, status,
       manifest_json, manifest_etag, manifest_sha256, total_bytes, expires_at,
       qualification_expires_at
     FROM ad_decisions
     WHERE
       episode_id = ?
       AND publication_revision = ?
       AND request_key_hash = ?`
  ).bind(
    episodeId,
    publicationRevision,
    requestKeyHash
  ).first<StoredDecisionRow>();
}

async function loadDecision(
  db: D1Database,
  decisionId: string
): Promise<StoredDecisionRow | null> {
  return db.prepare(
    `SELECT
       id, episode_id, publication_revision, request_key_hash, status,
       manifest_json, manifest_etag, manifest_sha256, total_bytes, expires_at,
       qualification_expires_at
     FROM ad_decisions
     WHERE id = ?`
  ).bind(decisionId).first<StoredDecisionRow>();
}

function validateRuntimeMarkers(
  rows: RuntimeMarkerRow[]
): RuntimeMarkerRow[] {
  if (rows.length < 1 || rows.length > 3) {
    throw new RequestValidationError(
      "An approved decision requires 1-3 active markers",
      "approved_markers_not_ready",
      409
    );
  }
  const positions = new Set<AdPosition>();
  const planIds = new Set<string>();
  for (const marker of rows) {
    if (
      !["pre", "mid", "post"].includes(marker.position)
      || positions.has(marker.position)
      || !marker.plan_id
      || !marker.approved_at
      || !Number.isFinite(Date.parse(marker.approved_at))
      || (
        marker.position === "mid"
          ? !Number.isSafeInteger(marker.starts_at_ms)
            || Number(marker.starts_at_ms) <= 0
          : marker.starts_at_ms !== null
      )
    ) {
      throw new RequestValidationError(
        "Approved marker evidence is invalid",
        "approved_markers_not_ready",
        409
      );
    }
    positions.add(marker.position);
    planIds.add(marker.plan_id);
  }
  if (planIds.size !== 1) {
    throw new RequestValidationError(
      "Approved markers must share one ad plan",
      "approved_markers_not_ready",
      409
    );
  }
  return [...rows].sort(
    (left, right) =>
      POSITION_ORDER[left.position] - POSITION_ORDER[right.position]
  );
}

function validateRuntimeProgramSegments(
  rows: RuntimeProgramSegmentRow[],
  markers: RuntimeMarkerRow[],
  streamProfile: string,
  sourceEtag: string
): RuntimeProgramSegmentRow[] {
  const expectedCount =
    markers.filter(({ position }) => position === "mid").length + 1;
  const planId = markers[0].plan_id;
  if (rows.length !== expectedCount) {
    throw new RequestValidationError(
      `An approved decision requires ${expectedCount} program segment(s)`,
      "program_segments_not_ready",
      409
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const segment = rows[index];
    if (
      segment.sequence !== index
      || segment.plan_id !== planId
      || segment.validation_status !== "ready"
      || segment.audio_mime_type !== "audio/mpeg"
      || segment.stream_profile !== streamProfile
      || segment.source_etag !== sourceEtag
      || segment.source_offset !== 0
      || segment.byte_length !== segment.object_bytes
      || !Number.isSafeInteger(segment.object_bytes)
      || segment.object_bytes <= 0
      || !/^[a-f0-9]{64}$/.test(segment.sha256)
      || !segment.validated_at
      || !Number.isFinite(Date.parse(segment.validated_at))
    ) {
      throw new RequestValidationError(
        "Approved program-segment evidence is invalid",
        "program_segments_not_ready",
        409
      );
    }
  }
  return rows;
}

function validateSelectedCreativeSnapshots(
  slots: AdSlotDecision[],
  streamProfile: string
): void {
  for (const slot of slots) {
    const creative = slot.selection;
    if (
      !creative
      || !creative.campaignRevision
      || !creative.creativeDurationMs
      || !creative.creativeSha256
      || !creative.creativeEtag
      || !/^[a-f0-9]{64}$/.test(creative.creativeSha256)
      || creative.audioMimeType !== "audio/mpeg"
      || creative.streamProfile !== streamProfile
    ) {
      throw new RequestValidationError(
        `Selected ${slot.position}-roll creative lacks immutable validation evidence`,
        "selected_creative_evidence_incomplete",
        409
      );
    }
  }
}

async function verifyRuntimeObjects(
  bucket: R2Bucket,
  programSegments: RuntimeProgramSegmentRow[],
  slots: AdSlotDecision[]
): Promise<Map<string, string>> {
  const expected = [
    ...programSegments.map((segment) => ({
      objectKey: segment.object_key,
      objectBytes: segment.object_bytes,
      etag: null
    })),
    ...slots.flatMap((slot) => slot.selection
      ? [{
          objectKey: slot.selection.objectKey,
          objectBytes: slot.selection.audioBytes,
          etag: slot.selection.creativeEtag
        }]
      : [])
  ];
  const objects = await Promise.all(
    expected.map(({ objectKey }) => bucket.head(objectKey))
  );
  const objectEtags = new Map<string, string>();
  for (let index = 0; index < expected.length; index += 1) {
    const object = objects[index];
    if (
      !object
      || object.size !== expected[index].objectBytes
      || (
        expected[index].etag
        && object.httpEtag !== expected[index].etag
      )
      || !object.httpEtag
    ) {
      throw new RequestValidationError(
        "A selected decision object is unavailable or has changed size",
        "ad_decision_object_mismatch",
        409
      );
    }
    objectEtags.set(expected[index].objectKey, object.httpEtag);
  }
  return objectEtags;
}

async function buildDecisionManifest(
  episode: RuntimeEpisodeRow,
  decisionId: string,
  streamProfile: string,
  validatedAt: string,
  markers: RuntimeMarkerRow[],
  programSegments: RuntimeProgramSegmentRow[],
  slots: AdSlotDecision[],
  objectEtags: ReadonlyMap<string, string>
): Promise<VirtualMediaManifest> {
  const byPosition = new Map(
    slots.map((slot) => [slot.position, slot.selection])
  );
  const segments: VirtualMediaSegment[] = [];
  const appendAd = (position: AdPosition) => {
    const selection = byPosition.get(position);
    if (!selection) return;
    segments.push({
      id: `${decisionId}_${position}_creative`,
      kind: selection.campaignType === "direct" ? "direct_ad" : "house_ad",
      objectKey: selection.objectKey,
      objectEtag: objectEtags.get(selection.objectKey),
      objectBytes: selection.audioBytes,
      sourceOffset: 0,
      byteLength: selection.audioBytes,
      contentType: "audio/mpeg",
      streamProfile
    });
  };
  if (markers.some(({ position }) => position === "pre")) appendAd("pre");
  segments.push(programVirtualSegment(
    programSegments[0],
    streamProfile,
    objectEtags
  ));
  if (markers.some(({ position }) => position === "mid")) {
    appendAd("mid");
    segments.push(programVirtualSegment(
      programSegments[1],
      streamProfile,
      objectEtags
    ));
  }
  if (markers.some(({ position }) => position === "post")) appendAd("post");

  const materialSha256 = await sha256Hex(JSON.stringify({
    schemaVersion: "1",
    decisionId,
    episodeId: episode.id,
    publicationRevision: episode.publication_revision,
    streamProfile,
    segments
  }));
  return {
    schemaVersion: "1",
    id: `manifest_${materialSha256.slice(0, 48)}`,
    episodeId: episode.id,
    decisionId,
    etag: `"ad-${materialSha256}"`,
    contentType: "audio/mpeg",
    streamProfile,
    validatedAt,
    segments
  };
}

function programVirtualSegment(
  segment: RuntimeProgramSegmentRow,
  streamProfile: string,
  objectEtags: ReadonlyMap<string, string>
): VirtualMediaSegment {
  return {
    id: segment.id,
    kind: "program",
    objectKey: segment.object_key,
    objectEtag: objectEtags.get(segment.object_key),
    objectBytes: segment.object_bytes,
    sourceOffset: segment.source_offset,
    byteLength: segment.byte_length,
    contentType: "audio/mpeg",
    streamProfile
  };
}

async function presentIssuedDecision(
  request: Request,
  env: PodcastEnv,
  decision: StoredDecisionRow,
  idempotent: boolean,
  flags: {
    showEnabled: boolean;
    episodeEnabled: boolean;
  }
): Promise<Response> {
  if (
    decision.status !== "selected"
    || !decision.manifest_sha256
    || !decision.manifest_json
    || !decision.total_bytes
    || !Number.isFinite(Date.parse(decision.expires_at))
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_decision_unavailable" },
      { status: 409 }
    );
  }
  const expires = Math.floor(Date.parse(decision.expires_at) / 1_000);
  if (expires <= Math.floor(Date.now() / 1_000)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_decision_expired" },
      { status: 409 }
    );
  }
  const signature = await signDecision(
    decision.id,
    expires,
    decision.manifest_sha256,
    env.AD_DECISION_SIGNING_SECRET as string
  );
  const signedUrl = new URL(
    `/v1/ads/decisions/${decision.id}/audio`,
    new URL(request.url).origin
  );
  signedUrl.searchParams.set("expires", String(expires));
  signedUrl.searchParams.set("manifest", decision.manifest_sha256);
  signedUrl.searchParams.set("signature", signature);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      decisionId: decision.id,
      status: decision.status,
      idempotent,
      signedUrl: signedUrl.href,
      expiresAt: decision.expires_at,
      manifestSha256: decision.manifest_sha256,
      totalBytes: decision.total_bytes,
      runtimeEnabled: false,
      publicEnclosureConnected: false,
      flags
    },
    { status: idempotent ? 200 : 201 }
  );
}

async function signDecision(
  decisionId: string,
  expires: number,
  manifestSha256: string,
  secret: string
): Promise<string> {
  return hmacSha256(
    [
      "dust-wave-ad-decision-v1",
      decisionId,
      String(expires),
      manifestSha256
    ].join("\n"),
    secret,
    "hex"
  );
}

function stagingDecisionRuntimeEnabled(env: PodcastEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && env.AD_DECISION_MODE === "staging_validate"
    && Boolean(env.AD_DECISION_SIGNING_SECRET);
}

function parseStoredManifest(value: string): VirtualMediaManifest {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored ad decision manifest is invalid.");
  }
  return parsed as VirtualMediaManifest;
}

async function preflightStoredManifest(
  bucket: R2Bucket,
  manifest: VirtualMediaManifest
): Promise<boolean> {
  let compiled;
  try {
    compiled = compileVirtualMediaManifest(manifest);
  } catch {
    return false;
  }
  const expected = new Map<string, {
    objectBytes: number;
    objectEtag?: string;
  }>();
  for (const segment of compiled.segments) {
    const existing = expected.get(segment.objectKey);
    if (
      existing
      && (
        existing.objectBytes !== segment.objectBytes
        || existing.objectEtag !== segment.objectEtag
      )
    ) {
      return false;
    }
    expected.set(segment.objectKey, {
      objectBytes: segment.objectBytes,
      ...(segment.objectEtag
        ? { objectEtag: segment.objectEtag }
        : {})
    });
  }
  const entries = [...expected.entries()];
  const objects = await Promise.all(
    entries.map(([objectKey]) => bucket.head(objectKey))
  );
  return entries.every(([_, evidence], index) => {
    const object = objects[index];
    return Boolean(
      object
      && object.size === evidence.objectBytes
      && (
        !evidence.objectEtag
        || object.httpEtag === evidence.objectEtag
      )
    );
  });
}

function decisionError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
