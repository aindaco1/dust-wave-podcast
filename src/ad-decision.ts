import { hmacSha256 } from "@dustwave/worker-core/crypto";

export type AdPosition = "pre" | "mid" | "post";
export type AdCampaignType = "house" | "direct";
export type AdDeviceType =
  | "mobile"
  | "tablet"
  | "desktop"
  | "smart_speaker"
  | "unknown";

export interface AdRuleCandidate {
  id: string;
  showId?: string | null;
  episodeId?: string | null;
  position?: AdPosition | null;
  deviceType?: string | null;
  appName?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface AdCreativeCandidate {
  id: string;
  campaignId: string;
  objectKey: string;
  audioBytes: number | null;
  audioMimeType: string | null;
  audioEtag?: string | null;
  streamProfile: string | null;
  sha256?: string | null;
  durationMs?: number | null;
  weight: number;
  active: boolean;
  validationStatus: "pending" | "validating" | "ready" | "failed" | "revoked";
}

export interface AdCampaignCandidate {
  id: string;
  revision?: number;
  campaignType: AdCampaignType;
  sponsorActive?: boolean | null;
  approvalStatus: "draft" | "approved" | "rejected" | "revoked";
  active: boolean;
  startsAt: string;
  endsAt?: string | null;
  killSwitchAt?: string | null;
  priority: number;
  impressionCap?: number | null;
  qualifiedImpressionGoal?: number | null;
  qualifiedImpressions: number;
  pacingStrategy: "even" | "asap" | "manual";
  rules: AdRuleCandidate[];
  creatives: AdCreativeCandidate[];
}

export interface AdSelectionContext {
  showId: string;
  episodeId: string;
  position: AdPosition;
  deviceType: AdDeviceType;
  appName: string;
  streamProfile: string;
  now: string;
}

export interface SelectedAd {
  campaignId: string;
  campaignRevision: number | null;
  campaignType: AdCampaignType;
  creativeId: string;
  creativeEtag: string | null;
  creativeSha256: string | null;
  creativeDurationMs: number | null;
  ruleId: string | null;
  objectKey: string;
  audioBytes: number;
  audioMimeType: "audio/mpeg" | "audio/mp4";
  streamProfile: string;
  reason: {
    priority: number;
    specificity: number;
    pacingWeight: number;
    deterministic: true;
  };
}

export interface AdSlotDecision {
  position: AdPosition;
  selection: SelectedAd | null;
  fallbackReason: "no_eligible_inventory" | null;
}

export interface NormalizedPodcastClient {
  deviceType: AdDeviceType;
  appName: string;
}

export interface AdRequestKeyInput {
  secret: string;
  episodeId: string;
  publicationRevision: number;
  inventoryFingerprint: string;
  clientAddress?: string | null;
  client: NormalizedPodcastClient;
  now: string;
}

export interface AdRequestKey {
  privacyEpoch: string;
  decisionEpoch: string;
  requestKeyHash: string;
  selectionSeed: string;
}

type EligibleCampaign = {
  campaign: AdCampaignCandidate;
  ruleId: string | null;
  specificity: number;
  creatives: AdCreativeCandidate[];
  pacingWeight: number;
};

export function selectAdForSlot(
  campaigns: AdCampaignCandidate[],
  context: AdSelectionContext,
  seed: string,
  excludedCampaignIds: ReadonlySet<string> = new Set()
): SelectedAd | null {
  const eligible = campaigns
    .map((campaign) => eligibleCampaign(campaign, context))
    .filter((candidate): candidate is EligibleCampaign => candidate !== null)
    .sort((left, right) => compareIds(left.campaign.id, right.campaign.id));
  if (eligible.length === 0) return null;

  const withoutRepeats = eligible.filter(
    ({ campaign }) => !excludedCampaignIds.has(campaign.id)
  );
  const campaignPool = withoutRepeats.length > 0 ? withoutRepeats : eligible;
  const highestPriority = Math.max(
    ...campaignPool.map(({ campaign }) => campaign.priority)
  );
  const priorityPool = campaignPool.filter(
    ({ campaign }) => campaign.priority === highestPriority
  );
  const highestTypeRank = Math.max(
    ...priorityPool.map(({ campaign }) =>
      campaign.campaignType === "direct" ? 1 : 0
    )
  );
  const typePool = priorityPool.filter(({ campaign }) =>
    (campaign.campaignType === "direct" ? 1 : 0) === highestTypeRank
  );
  const highestSpecificity = Math.max(
    ...typePool.map(({ specificity }) => specificity)
  );
  const specificityPool = typePool.filter(
    ({ specificity }) => specificity === highestSpecificity
  );
  const selectedCampaign = weightedPick(
    specificityPool,
    specificityPool.map(({ pacingWeight }) => pacingWeight),
    `${seed}|campaign|${context.position}`
  );
  const creative = weightedPick(
    selectedCampaign.creatives,
    selectedCampaign.creatives.map(({ weight }) => weight),
    `${seed}|creative|${context.position}|${selectedCampaign.campaign.id}`
  );

  return {
    campaignId: selectedCampaign.campaign.id,
    campaignRevision:
      Number.isSafeInteger(selectedCampaign.campaign.revision)
      && Number(selectedCampaign.campaign.revision) > 0
        ? Number(selectedCampaign.campaign.revision)
        : null,
    campaignType: selectedCampaign.campaign.campaignType,
    creativeId: creative.id,
    creativeEtag: creative.audioEtag ?? null,
    creativeSha256: creative.sha256 ?? null,
    creativeDurationMs: creative.durationMs ?? null,
    ruleId: selectedCampaign.ruleId,
    objectKey: creative.objectKey,
    audioBytes: creative.audioBytes as number,
    audioMimeType: creative.audioMimeType as "audio/mpeg" | "audio/mp4",
    streamProfile: creative.streamProfile as string,
    reason: {
      priority: selectedCampaign.campaign.priority,
      specificity: selectedCampaign.specificity,
      pacingWeight: selectedCampaign.pacingWeight,
      deterministic: true
    }
  };
}

export function selectAdSlots(
  campaigns: AdCampaignCandidate[],
  baseContext: Omit<AdSelectionContext, "position">,
  positions: AdPosition[],
  seed: string
): AdSlotDecision[] {
  if (positions.length > 3 || new Set(positions).size !== positions.length) {
    throw new Error("A launch decision supports at most one pre, mid, and post slot.");
  }
  const usedCampaignIds = new Set<string>();
  return positions.map((position) => {
    const selection = selectAdForSlot(
      campaigns,
      { ...baseContext, position },
      seed,
      usedCampaignIds
    );
    if (selection) usedCampaignIds.add(selection.campaignId);
    return {
      position,
      selection,
      fallbackReason: selection ? null : "no_eligible_inventory"
    };
  });
}

export function normalizePodcastClient(
  userAgentValue: string | null
): NormalizedPodcastClient {
  const userAgent = String(userAgentValue ?? "");
  const normalized = userAgent.toLocaleLowerCase("en-US");
  const appName =
    normalized.includes("overcast")
      ? "overcast"
      : normalized.includes("pocket casts")
        || normalized.includes("pocketcasts")
        ? "pocket_casts"
        : normalized.includes("podcastaddict")
          || normalized.includes("podcast addict")
          ? "podcast_addict"
          : normalized.includes("spotify")
            ? "spotify"
            : normalized.includes("applecoremedia")
              || normalized.includes("podcasts/")
              ? "apple_podcasts"
              : normalized.includes("castbox")
                ? "castbox"
                : normalized.includes("iheartradio")
                  ? "iheartradio"
                  : normalized.includes("amazon music")
                    ? "amazon_music"
                    : normalized.includes("deezer")
                      ? "deezer"
                      : normalized.includes("mozilla/")
                        ? "browser"
                        : "unknown";
  let deviceType: AdDeviceType = "unknown";
  if (
    normalized.includes("alexa")
    || normalized.includes("amazon echo")
    || normalized.includes("sonos")
  ) {
    deviceType = "smart_speaker";
  } else if (normalized.includes("ipad")) {
    deviceType = "tablet";
  } else if (
    normalized.includes("iphone")
    || normalized.includes("ipod")
    || (normalized.includes("android") && normalized.includes("mobile"))
  ) {
    deviceType = "mobile";
  } else if (normalized.includes("android")) {
    deviceType = "tablet";
  } else if (
    normalized.includes("windows")
    || normalized.includes("macintosh")
    || normalized.includes("x11")
    || normalized.includes("linux")
  ) {
    deviceType = "desktop";
  }
  return { deviceType, appName };
}

export async function buildAdRequestKey(
  input: AdRequestKeyInput
): Promise<AdRequestKey> {
  if (!input.secret) throw new Error("An ad-decision secret is required.");
  const now = parseDate(input.now);
  if (!now) throw new Error("A valid decision time is required.");
  if (
    !input.episodeId.trim()
    || !Number.isSafeInteger(input.publicationRevision)
    || input.publicationRevision < 0
    || !input.inventoryFingerprint.trim()
  ) {
    throw new Error("Episode revision and inventory fingerprint are required.");
  }
  const privacyEpoch = now.toISOString().slice(0, 10);
  const decisionEpoch = now.toISOString().slice(0, 13);
  const ephemeralClientHash = await hmacSha256(
    `${privacyEpoch}|${String(input.clientAddress ?? "anonymous")}`,
    input.secret,
    "hex"
  );
  const requestKeyHash = await hmacSha256(
    [
      input.episodeId,
      input.publicationRevision,
      input.inventoryFingerprint,
      decisionEpoch,
      input.client.deviceType,
      normalizeAdTargetValue(input.client.appName),
      ephemeralClientHash
    ].join("|"),
    input.secret,
    "hex"
  );
  const selectionSeed = await hmacSha256(
    `selection|${requestKeyHash}`,
    input.secret,
    "hex"
  );
  return {
    privacyEpoch,
    decisionEpoch,
    requestKeyHash,
    selectionSeed
  };
}

function eligibleCampaign(
  campaign: AdCampaignCandidate,
  context: AdSelectionContext
): EligibleCampaign | null {
  const now = parseDate(context.now);
  const killSwitchAt = campaign.killSwitchAt
    ? parseDate(campaign.killSwitchAt)
    : null;
  if (
    !now
    || !campaign.id.trim()
    || !["house", "direct"].includes(campaign.campaignType)
    || (campaign.campaignType === "direct" && campaign.sponsorActive !== true)
    || campaign.approvalStatus !== "approved"
    || !["even", "asap", "manual"].includes(campaign.pacingStrategy)
    || !campaign.active
    || !dateWindowIncludes(now, campaign.startsAt, campaign.endsAt)
    || (campaign.killSwitchAt && !killSwitchAt)
    || (killSwitchAt && killSwitchAt <= now)
    || !Number.isSafeInteger(campaign.priority)
    || !Number.isSafeInteger(campaign.qualifiedImpressions)
    || campaign.qualifiedImpressions < 0
    || (
      campaign.impressionCap !== null
      && campaign.impressionCap !== undefined
      && (
        !Number.isSafeInteger(campaign.impressionCap)
        || campaign.impressionCap <= 0
      )
    )
    || (
      campaign.qualifiedImpressionGoal !== null
      && campaign.qualifiedImpressionGoal !== undefined
      && (
        !Number.isSafeInteger(campaign.qualifiedImpressionGoal)
        || campaign.qualifiedImpressionGoal <= 0
      )
    )
    || (
      campaign.impressionCap !== null
      && campaign.impressionCap !== undefined
      && campaign.qualifiedImpressions >= campaign.impressionCap
    )
  ) {
    return null;
  }
  const matchingRules = campaign.rules.length === 0
    ? [{ id: null, specificity: 0 }]
    : campaign.rules
      .map((rule) => ({
        id: rule.id,
        specificity: ruleMatches(rule, context, now)
      }))
      .filter(
        (result): result is { id: string; specificity: number } =>
          result.specificity !== null
      );
  if (matchingRules.length === 0) return null;
  matchingRules.sort(
    (left, right) =>
      right.specificity - left.specificity
      || compareIds(left.id ?? "", right.id ?? "")
  );

  const creatives = campaign.creatives
    .filter((creative) =>
      creative.active
      && creative.validationStatus === "ready"
      && creative.campaignId === campaign.id
      && creative.streamProfile === context.streamProfile
      && (creative.audioMimeType === "audio/mpeg"
        || creative.audioMimeType === "audio/mp4")
      && Number.isSafeInteger(creative.audioBytes)
      && Number(creative.audioBytes) > 0
      && Number.isSafeInteger(creative.weight)
      && creative.weight > 0
      && Boolean(creative.objectKey.trim())
    )
    .sort((left, right) => compareIds(left.id, right.id));
  if (creatives.length === 0) return null;
  return {
    campaign,
    ruleId: matchingRules[0].id,
    specificity: matchingRules[0].specificity,
    creatives,
    pacingWeight: calculatePacingWeight(campaign, now)
  };
}

function ruleMatches(
  rule: AdRuleCandidate,
  context: AdSelectionContext,
  now: Date
): number | null {
  if (!dateWindowIncludes(now, rule.startsAt, rule.endsAt)) return null;
  if (rule.showId && rule.showId !== context.showId) return null;
  if (rule.episodeId && rule.episodeId !== context.episodeId) return null;
  if (rule.position && rule.position !== context.position) return null;
  if (
    rule.deviceType
    && normalizeAdTargetValue(rule.deviceType) !== context.deviceType
  ) {
    return null;
  }
  if (
    rule.appName
    && normalizeAdTargetValue(rule.appName) !== normalizeAdTargetValue(context.appName)
  ) {
    return null;
  }
  return (
    (rule.episodeId ? 16 : 0)
    + (rule.showId ? 8 : 0)
    + (rule.position ? 4 : 0)
    + (rule.appName ? 2 : 0)
    + (rule.deviceType ? 1 : 0)
  );
}

function calculatePacingWeight(
  campaign: AdCampaignCandidate,
  now: Date
): number {
  if (campaign.campaignType === "house") return 1;
  if (campaign.pacingStrategy === "asap") return 101;
  if (
    campaign.pacingStrategy === "manual"
    || !campaign.qualifiedImpressionGoal
    || !campaign.endsAt
  ) {
    return 1;
  }
  const startsAt = parseDate(campaign.startsAt);
  const endsAt = parseDate(campaign.endsAt);
  if (!startsAt || !endsAt || endsAt <= startsAt) return 1;
  const elapsed = Math.max(
    0,
    Math.min(1, (now.getTime() - startsAt.getTime()) / (endsAt.getTime() - startsAt.getTime()))
  );
  const delivered = Math.max(
    0,
    Math.min(1, campaign.qualifiedImpressions / campaign.qualifiedImpressionGoal)
  );
  return 1 + Math.round(Math.max(0, elapsed - delivered) * 100);
}

function dateWindowIncludes(
  now: Date,
  startsAt?: string | null,
  endsAt?: string | null
): boolean {
  if (startsAt) {
    const start = parseDate(startsAt);
    if (!start || now < start) return false;
  }
  if (endsAt) {
    const end = parseDate(endsAt);
    if (!end || now >= end) return false;
  }
  return true;
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function normalizeAdTargetValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function weightedPick<T>(
  values: T[],
  weights: number[],
  seed: string
): T {
  if (values.length === 0 || values.length !== weights.length) {
    throw new Error("Weighted selection requires aligned values and weights.");
  }
  const safeWeights = weights.map((weight) =>
    Number.isSafeInteger(weight) && weight > 0
      ? Math.min(weight, 1_000_000)
      : 1
  );
  const total = safeWeights.reduce((sum, weight) => sum + weight, 0);
  let cursor = stableHash32(seed) % total;
  for (let index = 0; index < values.length; index += 1) {
    if (cursor < safeWeights[index]) return values[index];
    cursor -= safeWeights[index];
  }
  return values[values.length - 1];
}

function stableHash32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
