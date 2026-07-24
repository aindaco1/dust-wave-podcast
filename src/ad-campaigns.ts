import { normalizeAdTargetValue } from "./ad-decision";
import { requireAdmin, type AdminRole } from "./admin-auth";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validDateTime,
  validIdentifier
} from "./validation";

const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const WRITE_ROLES: AdminRole[] = ["super_admin", "admin"];
const CAMPAIGN_TYPES = ["house", "direct"] as const;
const PACING_STRATEGIES = ["even", "asap", "manual"] as const;
const BILLING_MODELS = ["flat_fee", "cpm"] as const;
const POSITIONS = ["pre", "mid", "post"] as const;
const DEVICE_TYPES = [
  "mobile",
  "tablet",
  "desktop",
  "smart_speaker",
  "unknown"
] as const;

type CampaignScopeRow = {
  id: string;
  show_id: string;
  campaign_type: "house" | "direct";
  sponsor_active: number | null;
  name: string;
  starts_at: string;
  ends_at: string | null;
  kill_switch_at: string | null;
  priority: number;
  impression_cap: number | null;
  qualified_impression_goal: number | null;
  pacing_strategy: "even" | "asap" | "manual";
  billing_model: "flat_fee" | "cpm";
  contract_amount_cents: number | null;
  cpm_cents: number | null;
  active: number;
  approval_status: "draft" | "approved" | "rejected" | "revoked";
  revision: number;
};

export async function listAdminAdCampaigns(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const showId = validIdentifier(
    new URL(request.url).searchParams.get("showId"),
    "showId"
  );
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;
  const result = await env.DB.prepare(
    `SELECT
       c.id, c.name, c.campaign_type, c.starts_at, c.ends_at,
       c.priority, c.impression_cap, c.qualified_impression_goal,
       c.qualified_impressions, c.pacing_strategy, c.billing_model,
       c.contract_amount_cents, c.cpm_cents, c.active, c.kill_switch_at,
       c.approval_status, c.approved_at, c.revision,
       s.id AS sponsor_id, s.name AS sponsor_name,
       s.website_url AS sponsor_website_url, s.active AS sponsor_active,
       (
         SELECT COUNT(*) FROM ad_rules r
         WHERE r.campaign_id = c.id AND r.active = 1
       ) AS rule_count,
       (
         SELECT COUNT(*) FROM ad_creatives a
         WHERE a.campaign_id = c.id AND a.active = 1
       ) AS creative_count,
       (
         SELECT COUNT(*) FROM ad_creatives a
         WHERE a.campaign_id = c.id
           AND a.active = 1
           AND a.validation_status = 'ready'
           AND a.audio_bytes > 0
           AND a.audio_mime_type IN ('audio/mpeg', 'audio/mp4')
           AND length(COALESCE(a.stream_profile, '')) > 0
       ) AS ready_creative_count
     FROM ad_campaigns c
     LEFT JOIN sponsors s ON s.id = c.sponsor_id
     WHERE EXISTS (
       SELECT 1
       FROM ad_rules target
       WHERE target.campaign_id = c.id
         AND target.active = 1
         AND target.show_id = ?
     )
     ORDER BY c.active DESC, c.starts_at DESC, c.name`
  ).bind(showId).all<Record<string, unknown>>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    campaigns: result.results.map(presentCampaign)
  });
}

export async function createAdminAdCampaign(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const body = await readJsonObject(request, 50_000);
  const showId = validIdentifier(body.showId, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const show = await env.DB.prepare(
    `SELECT id FROM shows WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<{ id: string }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }

  const campaignType = enumValue(
    body.campaignType,
    "campaignType",
    CAMPAIGN_TYPES
  );
  const name = requiredText(body.name, "name", 200);
  const startsAt = requiredDateTime(body.startsAt, "startsAt");
  const endsAt = validDateTime(body.endsAt, "endsAt");
  assertDateOrder(startsAt, endsAt);
  const priority = integerValue(body.priority ?? 0, "priority", -1_000, 1_000);
  const impressionCap = optionalInteger(
    body.impressionCap,
    "impressionCap",
    1,
    1_000_000_000
  );
  const qualifiedImpressionGoal = optionalInteger(
    body.qualifiedImpressionGoal,
    "qualifiedImpressionGoal",
    1,
    1_000_000_000
  );
  const pacingStrategy = enumValue(
    body.pacingStrategy ?? "even",
    "pacingStrategy",
    PACING_STRATEGIES
  );
  const billingModel = enumValue(
    body.billingModel ?? "flat_fee",
    "billingModel",
    BILLING_MODELS
  );
  const contractAmountCents = optionalInteger(
    body.contractAmountCents,
    "contractAmountCents",
    0,
    100_000_000_00
  );
  const cpmCents = optionalInteger(
    body.cpmCents,
    "cpmCents",
    0,
    10_000_00
  );
  if (
    campaignType === "house"
    && (
      billingModel !== "flat_fee"
      || contractAmountCents !== null
      || cpmCents !== null
    )
  ) {
    throw new RequestValidationError(
      "House campaigns cannot carry sponsor billing metadata"
    );
  }

  const episodeId = body.episodeId
    ? validIdentifier(body.episodeId, "episodeId")
    : null;
  if (episodeId) {
    const episode = await env.DB.prepare(
      `SELECT id FROM episodes WHERE id = ? AND show_id = ?`
    ).bind(episodeId, showId).first<{ id: string }>();
    if (!episode) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "episode_not_found" },
        { status: 404 }
      );
    }
  }
  const position = body.position
    ? enumValue(body.position, "position", POSITIONS)
    : null;
  const deviceType = body.deviceType
    ? enumValue(body.deviceType, "deviceType", DEVICE_TYPES)
    : null;
  const appNameInput = optionalText(body.appName, "appName", 100);
  const appName = appNameInput ? normalizeAdTargetValue(appNameInput) : null;
  if (appNameInput && !appName) {
    throw new RequestValidationError("appName is invalid");
  }

  let sponsorId: string | null = null;
  if (campaignType === "direct") {
    const sponsorName = requiredText(body.sponsorName, "sponsorName", 200);
    const sponsorWebsiteUrl = optionalHttpsUrl(
      body.sponsorWebsiteUrl,
      "sponsorWebsiteUrl"
    );
    const existingSponsor = await env.DB.prepare(
      `SELECT id, active
       FROM sponsors
       WHERE name = ? COLLATE NOCASE
       ORDER BY created_at
       LIMIT 1`
    ).bind(sponsorName).first<{ id: string; active: number }>();
    if (existingSponsor?.active === 0) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "sponsor_inactive" },
        { status: 409 }
      );
    }
    sponsorId = existingSponsor?.id
      ?? `sponsor_${crypto.randomUUID().replace(/-/g, "")}`;
    if (!existingSponsor) {
      await env.DB.prepare(
        `INSERT INTO sponsors (id, name, website_url)
         VALUES (?, ?, ?)`
      ).bind(sponsorId, sponsorName, sponsorWebsiteUrl).run();
    }
  }

  const campaignId = `campaign_${crypto.randomUUID().replace(/-/g, "")}`;
  const ruleId = `rule_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    `INSERT INTO ad_campaigns (
       id, sponsor_id, name, campaign_type, starts_at, ends_at, priority,
       impression_cap, billing_model, contract_amount_cents, cpm_cents,
       qualified_impression_goal, pacing_strategy, active, approval_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft')`
  ).bind(
    campaignId,
    sponsorId,
    name,
    campaignType,
    startsAt,
    endsAt,
    priority,
    impressionCap,
    billingModel,
    contractAmountCents,
    cpmCents,
    qualifiedImpressionGoal,
    pacingStrategy
  ).run();
  await env.DB.prepare(
    `INSERT INTO ad_rules (
       id, campaign_id, show_id, episode_id, position, device_type, app_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ruleId,
    campaignId,
    showId,
    episodeId,
    position,
    deviceType,
    appName
  ).run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "ad_campaign.created",
    targetType: "ad_campaign",
    targetId: campaignId,
    metadata: {
      showId,
      campaignType,
      ruleId,
      targetedEpisode: Boolean(episodeId),
      position,
      deviceType,
      appName,
      billingModel
    }
  });
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      campaignId,
      ruleId,
      approvalStatus: "draft",
      active: true,
      blockers: ["creative_audio_not_ready", "campaign_approval_required"]
    },
    { status: 201 }
  );
}

export async function updateAdminAdCampaign(
  request: Request,
  env: PodcastEnv,
  campaignIdValue: string
): Promise<Response> {
  const campaignId = validIdentifier(campaignIdValue, "campaignId");
  const campaign = await loadCampaignScope(env.DB, campaignId);
  if (!campaign) return campaignNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId: campaign.show_id
  });
  if (!auth.ok) return auth.response;
  if (campaign.active !== 1 || campaign.kill_switch_at) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "campaign_revoked" },
      { status: 409 }
    );
  }
  const body = await readJsonObject(request, 50_000);
  const updates: Array<{ column: string; value: unknown }> = [];
  if ("name" in body) {
    updates.push({ column: "name", value: requiredText(body.name, "name", 200) });
  }
  const startsAt = "startsAt" in body
    ? requiredDateTime(body.startsAt, "startsAt")
    : campaign.starts_at;
  const endsAt = "endsAt" in body
    ? validDateTime(body.endsAt, "endsAt")
    : campaign.ends_at;
  assertDateOrder(startsAt, endsAt);
  if ("startsAt" in body) updates.push({ column: "starts_at", value: startsAt });
  if ("endsAt" in body) updates.push({ column: "ends_at", value: endsAt });
  if ("priority" in body) {
    updates.push({
      column: "priority",
      value: integerValue(body.priority, "priority", -1_000, 1_000)
    });
  }
  for (const [input, column, maximum] of [
    ["impressionCap", "impression_cap", 1_000_000_000],
    [
      "qualifiedImpressionGoal",
      "qualified_impression_goal",
      1_000_000_000
    ],
    ["contractAmountCents", "contract_amount_cents", 100_000_000_00],
    ["cpmCents", "cpm_cents", 10_000_00]
  ] as const) {
    if (input in body) {
      updates.push({
        column,
        value: optionalInteger(
          body[input],
          input,
          input === "impressionCap" || input === "qualifiedImpressionGoal"
            ? 1
            : 0,
          maximum
        )
      });
    }
  }
  if ("pacingStrategy" in body) {
    updates.push({
      column: "pacing_strategy",
      value: enumValue(
        body.pacingStrategy,
        "pacingStrategy",
        PACING_STRATEGIES
      )
    });
  }
  if ("billingModel" in body) {
    updates.push({
      column: "billing_model",
      value: enumValue(body.billingModel, "billingModel", BILLING_MODELS)
    });
  }
  if (updates.length === 0) {
    throw new RequestValidationError(
      "No supported campaign fields were supplied"
    );
  }
  if (
    campaign.campaign_type === "house"
    && updates.some(({ column, value }) =>
      column === "billing_model"
        ? value !== "flat_fee"
        : ["contract_amount_cents", "cpm_cents"].includes(column)
          && value !== null
    )
  ) {
    throw new RequestValidationError(
      "House campaigns cannot carry sponsor billing metadata"
    );
  }

  await env.DB.prepare(
    `UPDATE ad_campaigns
     SET
       ${updates.map(({ column }) => `${column} = ?`).join(", ")},
       approval_status = 'draft',
       approved_by_admin_user_id = NULL,
       approved_at = NULL,
       revision = revision + 1,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(...updates.map(({ value }) => value), campaignId).run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "ad_campaign.updated",
    targetType: "ad_campaign",
    targetId: campaignId,
    metadata: {
      showId: campaign.show_id,
      fields: updates.map(({ column }) => column),
      approvalReset: true
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    campaignId,
    approvalStatus: "draft"
  });
}

export async function approveAdminAdCampaign(
  request: Request,
  env: PodcastEnv,
  campaignIdValue: string
): Promise<Response> {
  const campaignId = validIdentifier(campaignIdValue, "campaignId");
  const campaign = await loadCampaignScope(env.DB, campaignId);
  if (!campaign) return campaignNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId: campaign.show_id
  });
  if (!auth.ok) return auth.response;
  const readiness = await campaignReadiness(env.DB, campaign);
  if (readiness.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "campaign_not_ready", blockers: readiness },
      { status: 409 }
    );
  }
  if (campaign.approval_status === "approved") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      approved: true,
      idempotent: true,
      campaignId
    });
  }
  const approved = await env.DB.prepare(
    `UPDATE ad_campaigns
     SET
       approval_status = 'approved',
       approved_by_admin_user_id = ?,
       approved_at = datetime('now'),
       revision = revision + 1,
       updated_at = datetime('now')
     WHERE id = ? AND active = 1 AND kill_switch_at IS NULL`
  ).bind(auth.authorization.identity.id, campaignId).run();
  if ((approved.meta?.changes ?? 0) !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "campaign_state_changed" },
      { status: 409 }
    );
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "ad_campaign.approved",
    targetType: "ad_campaign",
    targetId: campaignId,
    metadata: { showId: campaign.show_id }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    approved: true,
    idempotent: false,
    campaignId
  });
}

export async function killAdminAdCampaign(
  request: Request,
  env: PodcastEnv,
  campaignIdValue: string
): Promise<Response> {
  const campaignId = validIdentifier(campaignIdValue, "campaignId");
  const campaign = await loadCampaignScope(env.DB, campaignId);
  if (!campaign) return campaignNotFound(request, env);
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId: campaign.show_id
  });
  if (!auth.ok) return auth.response;
  if (campaign.active !== 1 || campaign.kill_switch_at) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      killed: true,
      idempotent: true,
      campaignId
    });
  }
  await env.DB.prepare(
    `UPDATE ad_campaigns
     SET
       active = 0,
       kill_switch_at = datetime('now'),
       approval_status = 'revoked',
       revision = revision + 1,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(campaignId).run();
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "ad_campaign.killed",
    targetType: "ad_campaign",
    targetId: campaignId,
    metadata: { showId: campaign.show_id }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    killed: true,
    idempotent: false,
    campaignId
  });
}

async function loadCampaignScope(
  db: D1Database,
  campaignId: string
): Promise<CampaignScopeRow | null> {
  return db.prepare(
    `SELECT
       c.id, r.show_id, c.campaign_type, s.active AS sponsor_active,
       c.name, c.starts_at, c.ends_at, c.kill_switch_at, c.priority,
       c.impression_cap, c.qualified_impression_goal, c.pacing_strategy,
       c.billing_model, c.contract_amount_cents, c.cpm_cents, c.active,
       c.approval_status, c.revision
     FROM ad_campaigns c
     JOIN ad_rules r ON r.campaign_id = c.id
     LEFT JOIN sponsors s ON s.id = c.sponsor_id
     WHERE c.id = ? AND r.active = 1 AND r.show_id IS NOT NULL
     ORDER BY r.created_at
     LIMIT 1`
  ).bind(campaignId).first<CampaignScopeRow>();
}

async function campaignReadiness(
  db: D1Database,
  campaign: CampaignScopeRow
): Promise<string[]> {
  if (campaign.active !== 1 || campaign.kill_switch_at) {
    return ["campaign_revoked"];
  }
  const [rules, creatives] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM ad_rules
       WHERE campaign_id = ? AND active = 1 AND show_id = ?`
    ).bind(campaign.id, campaign.show_id).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM ad_creatives
       WHERE campaign_id = ?
         AND active = 1
         AND validation_status = 'ready'
         AND audio_bytes > 0
         AND audio_mime_type IN ('audio/mpeg', 'audio/mp4')
         AND length(COALESCE(stream_profile, '')) > 0`
    ).bind(campaign.id).first<{ count: number }>()
  ]);
  return [
    campaign.campaign_type === "direct" && campaign.sponsor_active !== 1
      ? "sponsor_inactive"
      : null,
    (rules?.count ?? 0) < 1 ? "targeting_rule_required" : null,
    (creatives?.count ?? 0) < 1 ? "creative_audio_not_ready" : null
  ].filter((value): value is string => Boolean(value));
}

function presentCampaign(row: Record<string, unknown>): Record<string, unknown> {
  const readyCreativeCount = Number(row.ready_creative_count ?? 0);
  const blockers = [
    row.active !== 1 ? "campaign_inactive" : null,
    row.approval_status !== "approved"
      ? "campaign_approval_required"
      : null,
    row.campaign_type === "direct" && row.sponsor_active !== 1
      ? "sponsor_inactive"
      : null,
    Number(row.rule_count ?? 0) < 1 ? "targeting_rule_required" : null,
    readyCreativeCount < 1 ? "creative_audio_not_ready" : null
  ].filter((value): value is string => Boolean(value));
  return {
    id: row.id,
    name: row.name,
    campaignType: row.campaign_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    priority: row.priority,
    impressionCap: row.impression_cap,
    qualifiedImpressionGoal: row.qualified_impression_goal,
    qualifiedImpressions: row.qualified_impressions,
    pacingStrategy: row.pacing_strategy,
    billingModel: row.billing_model,
    contractAmountCents: row.contract_amount_cents,
    cpmCents: row.cpm_cents,
    active: row.active === 1,
    killSwitchAt: row.kill_switch_at,
    approvalStatus: row.approval_status,
    approvedAt: row.approved_at,
    revision: row.revision,
    sponsor: row.sponsor_id
      ? {
          id: row.sponsor_id,
          name: row.sponsor_name,
          websiteUrl: row.sponsor_website_url,
          active: row.sponsor_active === 1
        }
      : null,
    ruleCount: Number(row.rule_count ?? 0),
    creativeCount: Number(row.creative_count ?? 0),
    readyCreativeCount,
    blockers
  };
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T
): T[number] {
  const result = requiredText(value, field, 64);
  if (!values.includes(result)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return result as T[number];
}

function integerValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  const result = Number(value);
  if (
    !Number.isSafeInteger(result)
    || result < minimum
    || result > maximum
  ) {
    throw new RequestValidationError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return result;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null || value === undefined || value === "") return null;
  return integerValue(value, field, minimum, maximum);
}

function requiredDateTime(value: unknown, field: string): string {
  const result = validDateTime(value, field);
  if (!result) throw new RequestValidationError(`${field} is required`);
  return result;
}

function assertDateOrder(startsAt: string, endsAt: string | null): void {
  if (endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw new RequestValidationError("endsAt must be after startsAt");
  }
}

function optionalHttpsUrl(value: unknown, field: string): string | null {
  const text = optionalText(value, field, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error("not_https");
    return url.toString();
  } catch {
    throw new RequestValidationError(`${field} must be an HTTPS URL`);
  }
}

function campaignNotFound(request: Request, env: PodcastEnv): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "campaign_not_found" },
    { status: 404 }
  );
}
