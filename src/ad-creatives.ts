import {
  loadAdCampaignScope,
  type CampaignScopeRow
} from "./ad-campaigns";
import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  DYNAMIC_AD_MP3_PROFILE,
  validateDynamicAdMp3
} from "./mp3-profile";
import {
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  requiredText,
  safeFilename,
  validIdentifier
} from "./validation";

const CREATIVE_ROLES: AdminRole[] = ["super_admin", "admin", "producer"];
const MAXIMUM_CREATIVE_BYTES = 25 * 1024 * 1024;
const UPLOAD_LENGTH_HEADER = "x-podcast-upload-bytes";

type CreativeScopeRow = {
  id: string;
  campaign_id: string;
  show_id: string;
  campaign_active: number;
  kill_switch_at: string | null;
  object_key: string;
  audio_bytes: number | null;
  audio_mime_type: string | null;
  stream_profile: string | null;
  validation_status: string;
  duration_seconds: number;
};

export async function createAdminAdCreative(
  request: Request,
  env: PodcastEnv,
  campaignIdValue: string
): Promise<Response> {
  const campaignId = validIdentifier(campaignIdValue, "campaignId");
  const access = await requireCampaignCreativeOperator(
    request,
    env,
    campaignId
  );
  if (!access.ok) return access.response;
  if (access.campaign.active !== 1 || access.campaign.kill_switch_at) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "campaign_revoked" },
      { status: 409 }
    );
  }
  const body = await readJsonObject(request, 20_000);
  const name = requiredText(body.name, "name", 200);
  const filename = safeFilename(body.filename);
  if (!filename.toLowerCase().endsWith(".mp3")) {
    throw new RequestValidationError("Creative filename must end in .mp3");
  }
  const durationSeconds = positiveInteger(
    body.durationSeconds,
    "durationSeconds",
    10 * 60
  );
  const weight = positiveInteger(body.weight ?? 1, "weight", 1_000_000);
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

  const creativeId = `creative_${crypto.randomUUID().replace(/-/g, "")}`;
  const objectKey = [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    access.campaign.show_id,
    "ads",
    campaignId,
    `${creativeId}-${filename}`
  ].join("/");
  await env.DB.prepare(
    `INSERT INTO ad_creatives (
       id, campaign_id, name, audio_key, duration_seconds, weight,
       stream_profile, validation_status, active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1)`
  ).bind(
    creativeId,
    campaignId,
    name,
    objectKey,
    durationSeconds,
    weight,
    streamProfile
  ).run();
  await resetCampaignApproval(env.DB, campaignId);
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "ad_creative.created",
    targetType: "ad_creative",
    targetId: creativeId,
    metadata: {
      campaignId,
      showId: access.campaign.show_id,
      durationSeconds,
      weight,
      streamProfile
    }
  });
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      creativeId,
      campaignId,
      validationStatus: "pending",
      upload: {
        method: "PUT",
        path: `/v1/admin/ads/creatives/${creativeId}/audio`,
        contentType: "audio/mpeg",
        maximumBytes: MAXIMUM_CREATIVE_BYTES,
        lengthHeader: UPLOAD_LENGTH_HEADER
      }
    },
    { status: 201 }
  );
}

export async function uploadAdminAdCreativeAudio(
  request: Request,
  env: PodcastEnv,
  creativeIdValue: string
): Promise<Response> {
  const creativeId = validIdentifier(creativeIdValue, "creativeId");
  const access = await requireCreativeOperator(request, env, creativeId);
  if (!access.ok) return access.response;
  if (access.creative.campaign_active !== 1 || access.creative.kill_switch_at) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "campaign_revoked" },
      { status: 409 }
    );
  }
  const contentType = String(
    request.headers.get("content-type") ?? ""
  ).split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "audio/mpeg") {
    throw new RequestValidationError(
      "Creative audio content-type must be audio/mpeg"
    );
  }
  const declaredLength = Number(
    request.headers.get(UPLOAD_LENGTH_HEADER)
      ?? request.headers.get("content-length")
  );
  if (
    !Number.isSafeInteger(declaredLength)
    || declaredLength <= 0
    || declaredLength > MAXIMUM_CREATIVE_BYTES
  ) {
    throw new RequestValidationError(
      `Creative audio ${UPLOAD_LENGTH_HEADER} must be between 1 and ${MAXIMUM_CREATIVE_BYTES} bytes`,
      "invalid_upload_length",
      411
    );
  }
  if (!request.body) {
    throw new RequestValidationError(
      "Creative audio body is required",
      "body_required"
    );
  }
  const immutableObjectKey = [
    env.MEDIA_KEY_PREFIX.replace(/^\/+|\/+$/g, ""),
    access.creative.show_id,
    "ads",
    access.creative.campaign_id,
    creativeId,
    `upload_${crypto.randomUUID().replace(/-/g, "")}.mp3`
  ].join("/");

  await env.DB.prepare(
    `UPDATE ad_creatives
     SET
       validation_status = 'validating',
       audio_bytes = NULL,
       audio_mime_type = NULL,
       audio_etag = NULL,
       sha256 = NULL,
       duration_ms = NULL,
       validation_report_json = NULL,
       validated_by_admin_user_id = NULL,
       validated_at = NULL
     WHERE id = ?`
  ).bind(creativeId).run();
  await resetCampaignApproval(env.DB, access.creative.campaign_id);
  let object: R2Object;
  try {
    object = await env.MEDIA_BUCKET.put(
      immutableObjectKey,
      request.body,
      {
        httpMetadata: { contentType },
        customMetadata: {
          creativeId,
          campaignId: access.creative.campaign_id,
          showId: access.creative.show_id,
          streamProfile: DYNAMIC_AD_MP3_PROFILE
        }
      }
    );
  } catch {
    await markCreativeUploadFailure(
      env,
      access,
      creativeId,
      "R2 creative upload failed."
    );
    throw new RequestValidationError(
      "Creative audio storage failed",
      "creative_storage_failed",
      502
    );
  }
  if (object.size !== declaredLength) {
    await env.MEDIA_BUCKET.delete(immutableObjectKey);
    await markCreativeUploadFailure(
      env,
      access,
      creativeId,
      "Uploaded byte count did not match declared upload length."
    );
    throw new RequestValidationError(
      "Uploaded creative byte count did not match the declared upload length",
      "creative_size_mismatch",
      409
    );
  }
  await env.DB.prepare(
    `UPDATE ad_creatives
     SET
       audio_key = ?,
       audio_bytes = ?,
       audio_mime_type = 'audio/mpeg',
       audio_etag = ?,
       stream_profile = ?,
       validation_status = 'pending',
       sha256 = NULL,
       duration_ms = NULL,
       validation_report_json = NULL,
       uploaded_by_admin_user_id = ?,
       validated_by_admin_user_id = NULL,
       validated_at = NULL,
       uploaded_at = datetime('now')
     WHERE id = ?`
  ).bind(
    immutableObjectKey,
    object.size,
    object.httpEtag,
    DYNAMIC_AD_MP3_PROFILE,
    access.authorization.identity.id,
    creativeId
  ).run();
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "ad_creative.uploaded",
    targetType: "ad_creative",
    targetId: creativeId,
    metadata: {
      campaignId: access.creative.campaign_id,
      showId: access.creative.show_id,
      bytes: object.size,
      contentType,
      replacesObjectKey: access.creative.object_key,
      immutableObjectKey
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    creativeId,
    uploaded: true,
    bytes: object.size,
    validationStatus: "pending",
    validatePath: `/v1/admin/ads/creatives/${creativeId}/validate`
  });
}

export async function validateAdminAdCreative(
  request: Request,
  env: PodcastEnv,
  creativeIdValue: string
): Promise<Response> {
  const creativeId = validIdentifier(creativeIdValue, "creativeId");
  const access = await requireCreativeOperator(request, env, creativeId);
  if (!access.ok) return access.response;
  if (
    !access.creative.audio_bytes
    || access.creative.audio_mime_type !== "audio/mpeg"
    || access.creative.stream_profile !== DYNAMIC_AD_MP3_PROFILE
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "creative_audio_not_uploaded" },
      { status: 409 }
    );
  }
  if (access.creative.audio_bytes > MAXIMUM_CREATIVE_BYTES) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "creative_audio_too_large" },
      { status: 413 }
    );
  }
  const object = await env.MEDIA_BUCKET.get(access.creative.object_key);
  if (!object || object.size !== access.creative.audio_bytes) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "creative_audio_missing" },
      { status: 409 }
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  await env.DB.prepare(
    `UPDATE ad_creatives
     SET validation_status = 'validating'
     WHERE id = ?`
  ).bind(creativeId).run();
  await resetCampaignApproval(env.DB, access.creative.campaign_id);
  try {
    const report = validateDynamicAdMp3(bytes);
    if (report.durationMs > 10 * 60 * 1_000) {
      throw new Error("Creative MP3 exceeds the ten-minute duration limit.");
    }
    if (
      Math.abs(
        report.durationMs - (access.creative.duration_seconds * 1_000)
      ) > 1_500
    ) {
      throw new Error(
        "Creative MP3 duration differs from its declared duration by more than 1.5 seconds."
      );
    }
    const sha256 = await bytesSha256(bytes);
    await env.DB.prepare(
      `UPDATE ad_creatives
       SET
         validation_status = 'ready',
         duration_ms = ?,
         sha256 = ?,
         validation_report_json = ?,
         validated_by_admin_user_id = ?,
         validated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      report.durationMs,
      sha256,
      JSON.stringify({ valid: true, ...report }),
      access.authorization.identity.id,
      creativeId
    ).run();
    await recordAdminAudit(env.DB, {
      adminUserId: access.authorization.identity.id,
      action: "ad_creative.validated",
      targetType: "ad_creative",
      targetId: creativeId,
      metadata: {
        campaignId: access.creative.campaign_id,
        showId: access.creative.show_id,
        profile: report.profile,
        audioBytes: report.audioBytes,
        frameCount: report.frameCount,
        durationMs: report.durationMs,
        sha256
      }
    });
    return privateJson(request, env.ALLOWED_ORIGINS, {
      creativeId,
      validationStatus: "ready",
      report,
      sha256
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message.slice(0, 500)
      : "Creative MP3 validation failed.";
    await env.DB.prepare(
      `UPDATE ad_creatives
       SET
         validation_status = 'failed',
         validation_report_json = ?,
         validated_by_admin_user_id = ?,
         validated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      JSON.stringify({ valid: false, error: message }),
      access.authorization.identity.id,
      creativeId
    ).run();
    await recordAdminAudit(env.DB, {
      adminUserId: access.authorization.identity.id,
      action: "ad_creative.validation_failed",
      targetType: "ad_creative",
      targetId: creativeId,
      metadata: {
        campaignId: access.creative.campaign_id,
        showId: access.creative.show_id,
        error: message
      }
    });
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "creative_profile_invalid", message },
      { status: 422 }
    );
  }
}

async function requireCampaignCreativeOperator(
  request: Request,
  env: PodcastEnv,
  campaignId: string
): Promise<
  | {
      ok: true;
      authorization: AdminAuthorization;
      campaign: CampaignScopeRow;
    }
  | { ok: false; response: Response }
> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: CREATIVE_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth;
  const campaign = await loadAdCampaignScope(env.DB, campaignId);
  if (!campaign) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "campaign_not_found" },
        { status: 404 }
      )
    };
  }
  if (
    !hasAdminRoleForShow(
      auth.authorization.identity,
      CREATIVE_ROLES,
      campaign.show_id
    )
  ) {
    return forbidden(request, env);
  }
  return {
    ok: true,
    authorization: auth.authorization,
    campaign
  };
}

async function requireCreativeOperator(
  request: Request,
  env: PodcastEnv,
  creativeId: string
): Promise<
  | {
      ok: true;
      authorization: AdminAuthorization;
      creative: CreativeScopeRow;
    }
  | { ok: false; response: Response }
> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: CREATIVE_ROLES,
    requireCsrf: true
  });
  if (!auth.ok) return auth;
  const creative = await env.DB.prepare(
    `SELECT
       a.id, a.campaign_id, r.show_id,
       c.active AS campaign_active, c.kill_switch_at,
       a.audio_key AS object_key, a.audio_bytes, a.audio_mime_type,
       a.stream_profile, a.validation_status, a.duration_seconds
     FROM ad_creatives a
     JOIN ad_campaigns c ON c.id = a.campaign_id
     JOIN ad_rules r ON r.campaign_id = c.id
     WHERE a.id = ? AND r.active = 1 AND r.show_id IS NOT NULL
     ORDER BY r.created_at
     LIMIT 1`
  ).bind(creativeId).first<CreativeScopeRow>();
  if (!creative) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "creative_not_found" },
        { status: 404 }
      )
    };
  }
  if (
    !hasAdminRoleForShow(
      auth.authorization.identity,
      CREATIVE_ROLES,
      creative.show_id
    )
  ) {
    return forbidden(request, env);
  }
  return {
    ok: true,
    authorization: auth.authorization,
    creative
  };
}

async function resetCampaignApproval(
  db: D1Database,
  campaignId: string
): Promise<void> {
  await db.prepare(
    `UPDATE ad_campaigns
     SET
       approval_status = 'draft',
       approved_by_admin_user_id = NULL,
       approved_at = NULL,
       revision = revision + 1,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(campaignId).run();
}

async function markCreativeUploadFailure(
  env: PodcastEnv,
  access: {
    authorization: AdminAuthorization;
    creative: CreativeScopeRow;
  },
  creativeId: string,
  message: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ad_creatives
     SET
       validation_status = 'failed',
       validation_report_json = ?
     WHERE id = ?`
  ).bind(
    JSON.stringify({ valid: false, error: message }),
    creativeId
  ).run();
  await recordAdminAudit(env.DB, {
    adminUserId: access.authorization.identity.id,
    action: "ad_creative.upload_failed",
    targetType: "ad_creative",
    targetId: creativeId,
    metadata: {
      campaignId: access.creative.campaign_id,
      showId: access.creative.show_id,
      error: message
    }
  });
}

function forbidden(
  request: Request,
  env: PodcastEnv
): { ok: false; response: Response } {
  return {
    ok: false,
    response: privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "forbidden" },
      { status: 403 }
    )
  };
}

async function bytesSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
