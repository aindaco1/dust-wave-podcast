import {
  hmacSha256,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import {
  buildAdRequestKey,
  normalizeAdTargetValue,
  normalizePodcastClient,
  selectAdSlots,
  selectHouseFallbackSlots,
  type AdDeviceType,
  type AdPosition,
  type AdSlotDecision,
  type NormalizedPodcastClient
} from "./ad-decision";
import {
  parseStoredAdDecisionManifest,
  type StoredAdDecisionManifest
} from "./ad-decision-manifest";
import { loadActiveAdInventory } from "./ad-inventory";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import { prepareAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { safeDownloadFilename } from "./media-range";
import { DYNAMIC_AD_MP3_PROFILE } from "./mp3-profile";
import { recordPodcastMediaDelivery } from "./podcast-analytics";
import { readSignedJsonBody } from "./signed-callback";
import {
  buildVirtualMediaLengthContract,
  compileVirtualMediaManifest,
  serveVirtualMedia,
  virtualMediaLengthContractMatches,
  type CompletedVirtualMediaDelivery,
  type VirtualMediaManifest,
  type VirtualMediaSegment
} from "./virtual-media";
import {
  readJsonObject,
  positiveInteger,
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
const QUALIFICATION_CALLBACK_MAXIMUM_BODY_BYTES = 20_000;
const SIGNATURE_VERSION = "hmac-sha256-v1";

type RuntimeEpisodeRow = {
  id: string;
  show_id: string;
  publication_revision: number;
  status: string;
  access: string;
  public_at: string | null;
  media_status: string;
  audio_key: string | null;
  audio_bytes: number | null;
  audio_mime_type: string | null;
  audio_etag: string | null;
  episode_dynamic_ads_enabled: number;
  show_dynamic_ads_enabled: number;
  test_fixture: number;
};

type ReadyRuntimeEpisodeRow = RuntimeEpisodeRow & {
  audio_key: string;
  audio_bytes: number;
  audio_mime_type: "audio/mpeg";
  audio_etag: string;
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
  show_id: string;
  episode_id: string;
  duration_seconds: number | null;
  publication_revision: number;
  request_key_hash: string;
  status: string;
  manifest_json: string | null;
  manifest_etag: string | null;
  manifest_sha256: string | null;
  total_bytes: number | null;
  expires_at: string;
  qualification_expires_at: string | null;
  delivery_variant: "primary" | "fallback" | null;
  delivery_committed_at: string | null;
};

type IssuedAdDecision = {
  decision: StoredDecisionRow;
  idempotent: boolean;
  manifest: StoredAdDecisionManifest;
  flags: {
    showEnabled: boolean;
    episodeEnabled: boolean;
  };
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
  );
  if (!isAdDeviceType(deviceType)) {
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
  if (!runtimeEpisodeReady(episode)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_ready_for_ad_decision" },
      { status: 409 }
    );
  }

  const issued = await issueAdDecision(
    request,
    env,
    episode,
    { deviceType, appName },
    {
      issuedBy: "staging_admin",
      adminUserId: auth.authorization.identity.id
    }
  );
  return presentIssuedDecision(
    request,
    env,
    issued.decision,
    issued.idempotent,
    issued.flags
  );
}

async function issueAdDecision(
  request: Request,
  env: PodcastEnv,
  episode: ReadyRuntimeEpisodeRow,
  client: NormalizedPodcastClient,
  issuance: {
    issuedBy: "runtime" | "staging_admin";
    adminUserId?: string;
  }
): Promise<IssuedAdDecision> {
  const signingSecret = env.AD_DECISION_SIGNING_SECRET;
  if (!signingSecret) {
    throw new RequestValidationError(
      "Ad decision signing is unavailable",
      "ad_decision_unavailable",
      409
    );
  }
  const streamProfile = DYNAMIC_AD_MP3_PROFILE;
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
  const requestKey = await buildAdRequestKey({
    secret: signingSecret,
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
    const existingManifest = await verifiedStoredManifest(existing);
    if (!existingManifest) {
      throw new RequestValidationError(
        "The stored ad decision manifest is invalid",
        "ad_decision_manifest_mismatch",
        409
      );
    }
    return {
      decision: existing,
      idempotent: true,
      manifest: existingManifest,
      flags: runtimeFlags(episode)
    };
  }

  const positions = markers.map((marker) => marker.position);
  const selectionContext = {
    showId: episode.show_id,
    episodeId: episode.id,
    deviceType: client.deviceType,
    appName: client.appName,
    streamProfile,
    now: now.toISOString()
  };
  const slotDecisions = selectAdSlots(
    campaigns,
    selectionContext,
    positions,
    requestKey.selectionSeed
  );
  const missingPositions = slotDecisions
    .filter((slot) => !slot.selection)
    .map((slot) => slot.position);
  if (missingPositions.length > 0) {
    throw new RequestValidationError(
      `No complete ad rendition is available for: ${missingPositions.join(", ")}`,
      "complete_ad_rendition_unavailable",
      409
    );
  }
  validateSelectedCreativeSnapshots(slotDecisions, streamProfile);
  const fallbackSlotDecisions = selectHouseFallbackSlots(
    campaigns,
    selectionContext,
    slotDecisions,
    requestKey.selectionSeed
  );
  validateSelectedCreativeSnapshots(
    fallbackSlotDecisions.filter(({ selection }) => Boolean(selection)),
    streamProfile
  );
  const objectEtags = await verifyRuntimeObjects(
    env.MEDIA_BUCKET,
    episode,
    programSegments,
    slotDecisions,
    fallbackSlotDecisions
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
    fallbackSlotDecisions,
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
         ?
       )`
    ).bind(
      decisionId,
      episode.show_id,
      episode.id,
      episode.publication_revision,
      requestKey.requestKeyHash,
      requestKey.privacyEpoch,
      requestKey.decisionEpoch,
      client.deviceType,
      client.appName,
      JSON.stringify({
        showId: episode.show_id,
        episodeId: episode.id,
        publicationRevision: episode.publication_revision,
        deviceType: client.deviceType,
        appName: client.appName,
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
      qualificationExpiresAt,
      issuance.issuedBy
    )
  ];
  for (const slot of slotDecisions) {
    const selection = slot.selection;
    if (!selection) continue;
    const fallbackSelection = fallbackSlotDecisions.find(
      ({ position }) => position === slot.position
    )?.selection ?? null;
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ad_decision_slots (
         id, decision_id, marker_id, position, campaign_id, creative_id,
         selection_reason_json, campaign_revision, creative_object_key,
         creative_object_bytes, creative_object_etag, creative_sha256,
         creative_duration_ms, stream_profile, fallback_campaign_id,
         fallback_creative_id, fallback_object_key, fallback_object_bytes,
         fallback_object_etag, fallback_sha256, fallback_duration_ms,
         fallback_stream_profile
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`
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
      selection.streamProfile,
      fallbackSelection?.campaignId ?? null,
      fallbackSelection?.creativeId ?? null,
      fallbackSelection?.objectKey ?? null,
      fallbackSelection?.audioBytes ?? null,
      fallbackSelection?.creativeEtag ?? null,
      fallbackSelection?.creativeSha256 ?? null,
      fallbackSelection?.creativeDurationMs ?? null,
      fallbackSelection?.streamProfile ?? null
    ));
  }
  if (issuance.adminUserId) {
    statements.push(prepareAdminAudit(env.DB, {
      adminUserId: issuance.adminUserId,
      action: "ad_decision.staging_issued",
      targetType: "ad_decision",
      targetId: decisionId,
      metadata: {
        episodeId: episode.id,
        showId: episode.show_id,
        publicationRevision: episode.publication_revision,
        slotCount: slotDecisions.length,
        totalBytes: compiled.totalBytes,
        fallbackType: manifest.fallbackType,
        deliveryLengthContract: manifest.deliveryLengthContract,
        deliveryLengthReady: manifest.deliveryLengthContract.equalByteLength,
        manifestSha256,
        runtimeEnabled: automaticDecisionRuntimeEnabled(env)
      }
    }));
  }
  await env.DB.batch(statements);

  const stored = await loadDecision(env.DB, decisionId);
  if (
    !stored
    || stored.manifest_sha256 !== manifestSha256
    || stored.manifest_json !== manifestJson
  ) {
    throw new Error("The immutable decision did not persist as issued.");
  }
  return {
    decision: stored,
    idempotent: false,
    manifest,
    flags: runtimeFlags(episode)
  };
}

export async function redirectPublicEpisodeToAdDecision(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string
): Promise<Response | null> {
  if (!automaticDecisionRuntimeEnabled(env)) return null;
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  try {
    const episode = await loadRuntimeEpisode(env.DB, episodeId);
    if (
      !episode
      || !runtimeEpisodeReady(episode)
      || !publicRuntimeEpisodeReady(episode)
      || !runtimeFlagsReady(episode)
    ) {
      return null;
    }
    const issued = await issueAdDecision(
      request,
      env,
      episode,
      normalizePodcastClient(request.headers.get("user-agent")),
      { issuedBy: "runtime" }
    );
    if (
      issued.manifest.fallbackType !== "house_fill"
      || !issued.manifest.deliveryLengthContract.equalByteLength
      || !storedDeliveryContractValid(issued.manifest)
    ) {
      return null;
    }
    const signedUrl = await buildSignedDecisionUrl(
      request,
      env,
      issued.decision
    );
    if (!signedUrl) return null;
    if (new URL(request.url).searchParams.get("download") === "1") {
      signedUrl.searchParams.set("download", "1");
    }
    return new Response(null, {
      status: 307,
      headers: {
        location: signedUrl.href,
        "cache-control": "private, no-store, max-age=0",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow, noarchive",
        vary: "user-agent"
      }
    });
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "dynamic_ad_full_file_fallback",
      episodeId,
      errorCode: error instanceof RequestValidationError
        ? error.code
        : "runtime_error",
      errorName: error instanceof Error ? error.name : "UnknownError"
    }));
    return null;
  }
}

export async function serveAdDecisionAudio(
  request: Request,
  env: PodcastEnv,
  decisionIdValue: string,
  ctx?: ExecutionContext
): Promise<Response> {
  if (!signedDecisionRuntimeEnabled(env)) {
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
  const candidateSecrets = [
    env.AD_DECISION_SIGNING_SECRET,
    env.AD_DECISION_SIGNING_SECRET_PREVIOUS
  ].filter((value): value is string => Boolean(value));
  const expectedSignatures = await Promise.all(
    candidateSecrets.map((secret) =>
      signDecision(decisionId, expires, manifestSha256, secret)
    )
  );
  if (!expectedSignatures.some((expected) =>
    timingSafeEqual(signature, expected)
  )) {
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
  const manifest = await verifiedStoredManifest(decision);
  if (
    !manifest
    || manifest.decisionId !== decision.id
    || manifest.episodeId !== decision.episode_id
    || manifest.etag !== decision.manifest_etag
  ) {
    return decisionError("ad_decision_manifest_mismatch", 409);
  }
  const deliveryManifest = await resolveDecisionDeliveryManifest(
    env.DB,
    env.MEDIA_BUCKET,
    decision,
    manifest
  );
  if (!deliveryManifest) {
    return decisionError("ad_decision_object_mismatch", 409);
  }
  const primaryDelivery = deliveryManifest.id === manifest.id;
  const response = await serveVirtualMedia(
    request,
    env.MEDIA_BUCKET,
    deliveryManifest,
    {
      ...(primaryDelivery && automaticDecisionRuntimeEnabled(env)
        ? {
          async onComplete(delivery: CompletedVirtualMediaDelivery) {
            const qualification = qualifyCompletedDirectSlots(
              env,
              decision,
              delivery
            );
            if (ctx) {
              ctx.waitUntil(qualification);
              return;
            }
            await qualification;
          }
        }
        : {})
    }
  );
  if (
    new URL(request.url).searchParams.get("download") === "1"
    && (response.status === 200 || response.status === 206)
  ) {
    response.headers.set(
      "content-disposition",
      `attachment; filename="${
        safeDownloadFilename(`${decision.episode_id}.mp3`)
      }"`
    );
  }
  if (
    ctx
    && automaticDecisionRuntimeEnabled(env)
    && (response.status === 200 || response.status === 206)
  ) {
    const bytesServed = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(bytesServed) && bytesServed > 0) {
      ctx.waitUntil(
        recordPodcastMediaDelivery(
          request,
          env,
          {
            id: decision.episode_id,
            showId: decision.show_id,
            durationSeconds: decision.duration_seconds,
            audioBytes: decision.total_bytes ?? bytesServed
          },
          {
            bytesServed,
            status: response.status
          }
        ).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: "error",
            event: "podcast_analytics_record_failed",
            episodeId: decision.episode_id,
            deliveryType: "dynamic_ad",
            errorName: error instanceof Error
              ? error.name
              : "UnknownError"
          }));
        })
      );
    }
  }
  return response;
}

async function qualifyCompletedDirectSlots(
  env: PodcastEnv,
  decision: StoredDecisionRow,
  delivery: CompletedVirtualMediaDelivery
): Promise<void> {
  const secret = env.AD_QUALIFICATION_CALLBACK_SECRET;
  if (!secret) return;
  const positions: AdPosition[] = ["pre", "mid", "post"];
  const completed = positions.flatMap((position) => {
    const segment = delivery.manifest.segments.find((candidate) =>
      candidate.id === `${decision.id}_primary_${position}_creative`
      && candidate.kind === "direct_ad"
    );
    if (
      !segment
      || delivery.range.startsAt > segment.virtualStartsAt
      || delivery.range.endsAt < segment.virtualEndsAt
    ) {
      return [];
    }
    return [{ position, bytes: segment.byteLength }];
  });
  if (completed.length === 0) return;
  try {
    await Promise.all(completed.map(({ position, bytes }) =>
      recordTrustedDownloadQualification(env.DB, {
        decisionId: decision.id,
        decisionSlotId: `${decision.id}_${position}`,
        bytesServed: bytes,
        secret
      })
    ));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "dynamic_ad_qualification_failed",
      decisionId: decision.id,
      completedSlotCount: completed.length,
      errorName: error instanceof Error ? error.name : "UnknownError"
    }));
  }
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
     WHERE decision_slot_id = ?`
  ).bind(decisionSlotId).first<{ id: string }>();
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

export async function recordTrustedAdQualificationCallback(
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
  const qualificationSecret = env.AD_QUALIFICATION_CALLBACK_SECRET;
  const signed = await readSignedJsonBody(request, {
    secret: qualificationSecret,
    timestampHeader: "x-podcast-qualification-timestamp",
    signatureHeader: "x-podcast-qualification-signature",
    maximumBytes: QUALIFICATION_CALLBACK_MAXIMUM_BODY_BYTES,
    bodyName: "Qualification evidence",
    invalidBodyCode: "invalid_qualification_body"
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: signed.reason === "secret_missing"
          ? "not_found"
          : "invalid_qualification_signature"
      },
      { status: signed.reason === "secret_missing" ? 404 : 401 }
    );
  }
  if (!qualificationSecret) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }

  const decisionId = validIdentifier(
    signed.body.decisionId,
    "decisionId"
  );
  const decisionSlotId = validIdentifier(
    signed.body.decisionSlotId,
    "decisionSlotId"
  );
  const creativeBytesServed = positiveInteger(
    signed.body.creativeBytesServed,
    "creativeBytesServed",
    1_000_000_000_000
  );
  const result = await recordTrustedDownloadQualification(env.DB, {
    decisionId,
    decisionSlotId,
    bytesServed: creativeBytesServed,
    secret: qualificationSecret
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    accepted: true,
    decisionId,
    decisionSlotId,
    ...result
  });
}

async function loadRuntimeEpisode(
  db: D1Database,
  episodeId: string
): Promise<RuntimeEpisodeRow | null> {
  return db.prepare(
    `SELECT
       e.id, e.show_id, e.publication_revision, e.status, e.access,
       e.public_at, e.media_status, e.audio_key, e.audio_bytes,
       e.audio_mime_type, e.audio_etag,
       e.dynamic_ads_enabled AS episode_dynamic_ads_enabled,
       s.dynamic_ads_enabled AS show_dynamic_ads_enabled,
       s.test_fixture
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
       d.id, d.show_id, d.episode_id, e.duration_seconds,
       d.publication_revision, d.request_key_hash, d.status,
       d.manifest_json, d.manifest_etag, d.manifest_sha256, d.total_bytes,
       d.expires_at, d.qualification_expires_at, d.delivery_variant,
       d.delivery_committed_at
     FROM ad_decisions d
     JOIN episodes e ON e.id = d.episode_id
     WHERE
       d.episode_id = ?
       AND d.publication_revision = ?
       AND d.request_key_hash = ?`
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
       d.id, d.show_id, d.episode_id, e.duration_seconds,
       d.publication_revision, d.request_key_hash, d.status,
       d.manifest_json, d.manifest_etag, d.manifest_sha256, d.total_bytes,
       d.expires_at, d.qualification_expires_at, d.delivery_variant,
       d.delivery_committed_at
     FROM ad_decisions d
     JOIN episodes e ON e.id = d.episode_id
     WHERE d.id = ?`
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
  episode: ReadyRuntimeEpisodeRow,
  programSegments: RuntimeProgramSegmentRow[],
  ...slotGroups: AdSlotDecision[][]
): Promise<Map<string, string>> {
  const candidates = [
    {
      objectKey: episode.audio_key,
      objectBytes: episode.audio_bytes,
      etag: episode.audio_etag
    },
    ...programSegments.map((segment) => ({
      objectKey: segment.object_key,
      objectBytes: segment.object_bytes,
      etag: null
    })),
    ...slotGroups.flatMap((slots) => slots.flatMap((slot) => slot.selection
      ? [{
          objectKey: slot.selection.objectKey,
          objectBytes: slot.selection.audioBytes,
          etag: slot.selection.creativeEtag
        }]
      : []))
  ];
  const expectedByKey = new Map<string, {
    objectKey: string;
    objectBytes: number;
    etag: string | null;
  }>();
  for (const candidate of candidates) {
    const existing = expectedByKey.get(candidate.objectKey);
    if (
      existing
      && (
        existing.objectBytes !== candidate.objectBytes
        || (
          existing.etag
          && candidate.etag
          && existing.etag !== candidate.etag
        )
      )
    ) {
      throw new RequestValidationError(
        "A decision object has conflicting immutable evidence",
        "ad_decision_object_mismatch",
        409
      );
    }
    expectedByKey.set(candidate.objectKey, {
      ...candidate,
      etag: existing?.etag ?? candidate.etag
    });
  }
  const expected = [...expectedByKey.values()];
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
  episode: ReadyRuntimeEpisodeRow,
  decisionId: string,
  streamProfile: string,
  validatedAt: string,
  markers: RuntimeMarkerRow[],
  programSegments: RuntimeProgramSegmentRow[],
  slots: AdSlotDecision[],
  fallbackSlots: AdSlotDecision[],
  objectEtags: ReadonlyMap<string, string>
): Promise<StoredAdDecisionManifest> {
  const segments = buildRuntimeVirtualSegments(
    decisionId,
    streamProfile,
    markers,
    programSegments,
    slots,
    objectEtags,
    "primary"
  );

  const materialSha256 = await sha256Hex(JSON.stringify({
    schemaVersion: "1",
    decisionId,
    episodeId: episode.id,
    publicationRevision: episode.publication_revision,
    streamProfile,
    segments
  }));
  const fullFileFallbackMaterialSha256 = await sha256Hex(JSON.stringify({
    schemaVersion: "1",
    decisionId,
    episodeId: episode.id,
    publicationRevision: episode.publication_revision,
    streamProfile,
    objectKey: episode.audio_key,
    objectBytes: episode.audio_bytes,
    objectEtag: episode.audio_etag
  }));
  const fullFileFallback: VirtualMediaManifest = {
    schemaVersion: "1",
    id: `fallback_${fullFileFallbackMaterialSha256.slice(0, 48)}`,
    episodeId: episode.id,
    decisionId,
    etag: `"fallback-${fullFileFallbackMaterialSha256}"`,
    contentType: "audio/mpeg",
    streamProfile,
    validatedAt,
    segments: [{
      id: `${decisionId}_fallback_program`,
      kind: "program",
      objectKey: episode.audio_key,
      objectEtag: objectEtags.get(episode.audio_key),
      objectBytes: episode.audio_bytes,
      sourceOffset: 0,
      byteLength: episode.audio_bytes,
      contentType: "audio/mpeg",
      streamProfile
    }]
  };
  const primary: VirtualMediaManifest = {
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
  const completeHouseFallback = fallbackSlots.length === markers.length
    && fallbackSlots.every(({ selection }) => Boolean(selection));
  let fallback = fullFileFallback;
  let fallbackType: StoredAdDecisionManifest["fallbackType"] = "full_file";
  if (completeHouseFallback) {
    const houseSegments = buildRuntimeVirtualSegments(
      decisionId,
      streamProfile,
      markers,
      programSegments,
      fallbackSlots,
      objectEtags,
      "house_fallback"
    );
    const houseMaterialSha256 = await sha256Hex(JSON.stringify({
      schemaVersion: "1",
      decisionId,
      episodeId: episode.id,
      publicationRevision: episode.publication_revision,
      streamProfile,
      segments: houseSegments
    }));
    const houseFallback: VirtualMediaManifest = {
      schemaVersion: "1",
      id: `house_fallback_${houseMaterialSha256.slice(0, 48)}`,
      episodeId: episode.id,
      decisionId,
      etag: `"house-${houseMaterialSha256}"`,
      contentType: "audio/mpeg",
      streamProfile,
      validatedAt,
      segments: houseSegments
    };
    if (
      buildVirtualMediaLengthContract(primary, houseFallback).equalByteLength
    ) {
      fallback = houseFallback;
      fallbackType = "house_fill";
    }
  }
  return {
    ...primary,
    fallbackType,
    deliveryLengthContract: buildVirtualMediaLengthContract(primary, fallback),
    fallback
  };
}

function buildRuntimeVirtualSegments(
  decisionId: string,
  streamProfile: string,
  markers: RuntimeMarkerRow[],
  programSegments: RuntimeProgramSegmentRow[],
  slots: AdSlotDecision[],
  objectEtags: ReadonlyMap<string, string>,
  idKind: "primary" | "house_fallback"
): VirtualMediaSegment[] {
  const byPosition = new Map(
    slots.map((slot) => [slot.position, slot.selection])
  );
  const segments: VirtualMediaSegment[] = [];
  const appendAd = (position: AdPosition) => {
    const selection = byPosition.get(position);
    if (!selection) return;
    segments.push({
      id: `${decisionId}_${idKind}_${position}_creative`,
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
  return segments;
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
  const manifest = await verifiedStoredManifest(decision);
  if (!manifest) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_decision_manifest_mismatch" },
      { status: 409 }
    );
  }
  if (!storedDeliveryContractValid(manifest)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_decision_delivery_contract_mismatch" },
      { status: 409 }
    );
  }
  const signedUrl = await buildSignedDecisionUrl(request, env, decision);
  if (!signedUrl) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "ad_decision_unavailable" },
      { status: 409 }
    );
  }
  const runtimeEnabled = automaticDecisionRuntimeEnabled(env)
    && flags.showEnabled
    && flags.episodeEnabled
    && manifest.fallbackType === "house_fill"
    && manifest.deliveryLengthContract.equalByteLength;
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
      fallbackType: manifest.fallbackType,
      deliveryLengthContract: manifest.deliveryLengthContract,
      deliveryLengthReady: manifest.deliveryLengthContract.equalByteLength,
      runtimeEnabled,
      publicEnclosureConnected: runtimeEnabled,
      flags
    },
    { status: idempotent ? 200 : 201 }
  );
}

async function buildSignedDecisionUrl(
  request: Request,
  env: PodcastEnv,
  decision: StoredDecisionRow
): Promise<URL | null> {
  if (
    !decision.manifest_sha256
    || !Number.isFinite(Date.parse(decision.expires_at))
    || !env.AD_DECISION_SIGNING_SECRET
  ) {
    return null;
  }
  const expires = Math.floor(Date.parse(decision.expires_at) / 1_000);
  if (expires <= Math.floor(Date.now() / 1_000)) return null;
  const signature = await signDecision(
    decision.id,
    expires,
    decision.manifest_sha256,
    env.AD_DECISION_SIGNING_SECRET
  );
  const origin = env.MEDIA_ORIGIN?.replace(/\/+$/, "")
    || new URL(request.url).origin;
  const signedUrl = new URL(
    `/v1/ads/decisions/${decision.id}/audio`,
    origin
  );
  signedUrl.searchParams.set("expires", String(expires));
  signedUrl.searchParams.set("manifest", decision.manifest_sha256);
  signedUrl.searchParams.set("signature", signature);
  return signedUrl;
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
  return String(env.ENVIRONMENT) === "staging"
    && ["staging_validate", "staging_public"].includes(
      String(env.AD_DECISION_MODE ?? "")
    )
    && Boolean(env.AD_DECISION_SIGNING_SECRET);
}

function signedDecisionRuntimeEnabled(env: PodcastEnv): boolean {
  return stagingDecisionRuntimeEnabled(env)
    || (
      String(env.ENVIRONMENT) === "production"
      && String(env.AD_DECISION_MODE) === "live"
      && Boolean(env.AD_DECISION_SIGNING_SECRET)
    );
}

function automaticDecisionRuntimeEnabled(env: PodcastEnv): boolean {
  return signedDecisionRuntimeEnabled(env)
    && (
      String(env.AD_DECISION_MODE) === "staging_public"
      || String(env.AD_DECISION_MODE) === "live"
    )
    && Boolean(env.AD_QUALIFICATION_CALLBACK_SECRET);
}

function runtimeEpisodeReady(
  episode: RuntimeEpisodeRow
): episode is ReadyRuntimeEpisodeRow {
  return episode.status === "published"
    && episode.media_status === "ready"
    && Boolean(episode.audio_key)
    && Boolean(episode.audio_bytes)
    && episode.audio_mime_type === "audio/mpeg"
    && Boolean(episode.audio_etag)
    && episode.publication_revision >= 1;
}

function isAdDeviceType(value: string): value is AdDeviceType {
  return DEVICE_TYPES.some((candidate) => candidate === value);
}

function publicRuntimeEpisodeReady(episode: RuntimeEpisodeRow): boolean {
  const publicAt = episode.public_at;
  return episode.test_fixture === 0
    && ["public", "early_access", "free_mini"].includes(episode.access)
    && publicAt !== null
    && Number.isFinite(Date.parse(publicAt))
    && Date.parse(publicAt) <= Date.now();
}

function runtimeFlags(episode: RuntimeEpisodeRow): {
  showEnabled: boolean;
  episodeEnabled: boolean;
} {
  return {
    showEnabled: episode.show_dynamic_ads_enabled === 1,
    episodeEnabled: episode.episode_dynamic_ads_enabled === 1
  };
}

function runtimeFlagsReady(episode: RuntimeEpisodeRow): boolean {
  const flags = runtimeFlags(episode);
  return flags.showEnabled && flags.episodeEnabled;
}

async function verifiedStoredManifest(
  decision: StoredDecisionRow
): Promise<StoredAdDecisionManifest | null> {
  if (!decision.manifest_json || !decision.manifest_sha256) return null;
  if (await sha256Hex(decision.manifest_json) !== decision.manifest_sha256) {
    return null;
  }
  try {
    return parseStoredAdDecisionManifest(decision.manifest_json);
  } catch {
    return null;
  }
}

async function resolveDecisionDeliveryManifest(
  db: D1Database,
  bucket: R2Bucket,
  decision: StoredDecisionRow,
  manifest: StoredAdDecisionManifest
): Promise<VirtualMediaManifest | null> {
  if (!storedDeliveryContractValid(manifest)) return null;
  if (decision.delivery_variant) {
    const committed = decision.delivery_variant === "primary"
      ? manifest
      : manifest.fallback;
    return await preflightStoredManifest(bucket, committed)
      ? committed
      : null;
  }

  const primaryReady = await preflightStoredManifest(bucket, manifest);
  const proposedVariant = primaryReady
    ? "primary"
    : await preflightStoredManifest(bucket, manifest.fallback)
      ? "fallback"
      : null;
  if (!proposedVariant) return null;

  const committed = await db.prepare(
    `UPDATE ad_decisions
     SET
       delivery_variant = ?,
       delivery_committed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND delivery_variant IS NULL
     RETURNING delivery_variant`
  ).bind(
    proposedVariant,
    decision.id
  ).first<{ delivery_variant: "primary" | "fallback" }>();
  const committedVariant = committed?.delivery_variant
    ?? (
      await db.prepare(
        `SELECT delivery_variant
         FROM ad_decisions
         WHERE id = ?`
      ).bind(decision.id).first<{
        delivery_variant: "primary" | "fallback" | null;
      }>()
    )?.delivery_variant;
  if (!committedVariant) return null;
  const selected = committedVariant === "primary"
    ? manifest
    : manifest.fallback;
  if (committedVariant === proposedVariant) return selected;
  return await preflightStoredManifest(bucket, selected)
    ? selected
    : null;
}

function storedDeliveryContractValid(
  manifest: StoredAdDecisionManifest
): boolean {
  return Boolean(
    manifest.fallback
    && ["house_fill", "full_file"].includes(manifest.fallbackType)
    && manifest.fallback.decisionId === manifest.decisionId
    && manifest.fallback.episodeId === manifest.episodeId
    && virtualMediaLengthContractMatches(
      manifest,
      manifest.fallback,
      manifest.deliveryLengthContract
    )
    && (
      manifest.fallbackType !== "house_fill"
      || manifest.deliveryLengthContract.equalByteLength
    )
  );
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
