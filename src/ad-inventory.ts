import {
  type AdCampaignCandidate,
  type AdCreativeCandidate,
  type AdPosition,
  type AdRuleCandidate
} from "./ad-decision";

type CampaignRow = {
  id: string;
  campaign_type: string;
  sponsor_active: number | null;
  approval_status: string;
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

export async function loadActiveAdInventory(
  db: D1Database
): Promise<AdCampaignCandidate[]> {
  const [campaignResult, ruleResult, creativeResult] = await Promise.all([
    db.prepare(
      `SELECT
         c.id, c.campaign_type, s.active AS sponsor_active,
         c.approval_status, c.active, c.starts_at, c.ends_at,
         c.kill_switch_at, c.priority, c.impression_cap,
         c.qualified_impression_goal, c.qualified_impressions,
         c.pacing_strategy
       FROM ad_campaigns c
       LEFT JOIN sponsors s ON s.id = c.sponsor_id
       WHERE c.active = 1
       ORDER BY c.id`
    ).all<CampaignRow>(),
    db.prepare(
      `SELECT
         r.id, r.campaign_id, r.show_id, r.episode_id, r.position,
         r.device_type, r.app_name, r.starts_at, r.ends_at
       FROM ad_rules r
       JOIN ad_campaigns c ON c.id = r.campaign_id
       WHERE c.active = 1 AND r.active = 1
       ORDER BY r.campaign_id, r.id`
    ).all<RuleRow>(),
    db.prepare(
      `SELECT
         a.id, a.campaign_id, a.audio_key, a.audio_bytes,
         a.audio_mime_type, a.stream_profile, a.weight, a.active,
         a.validation_status
       FROM ad_creatives a
       JOIN ad_campaigns c ON c.id = a.campaign_id
       WHERE c.active = 1
       ORDER BY a.campaign_id, a.id`
    ).all<CreativeRow>()
  ]);
  return assembleCampaigns(
    campaignResult.results,
    ruleResult.results,
    creativeResult.results
  );
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
    approvalStatus: row.approval_status as AdCampaignCandidate["approvalStatus"],
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
