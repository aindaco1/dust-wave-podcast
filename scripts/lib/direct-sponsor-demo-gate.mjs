import { createHash } from "node:crypto";

import fixture from "../../config/virtual-audio-synthetic-fixture.json"
  with { type: "json" };
import {
  selectAdForSlot,
  selectAdSlots,
  selectHouseFallbackSlots
} from "../../src/ad-decision.ts";
import { validateDynamicAdInsertionMp3 } from "../../src/mp3-profile.ts";
import {
  buildVirtualMediaLengthContract,
  compileVirtualMediaManifest
} from "../../src/virtual-media.ts";

const FIXED_NOW = "2026-08-02T12:00:00.000Z";
const SHOW_ID = "show_opera_en_la_selva";
const EPISODE_ID = "episode_sponsor_demo_fixture";
const DECISION_ID = "decision_dust_wave_sponsor_demo";
const SPONSOR_CAMPAIGN_ID = "campaign_dust_wave_demo_direct";
const HOUSE_CAMPAIGN_ID = "campaign_dust_wave_demo_house";
const SPONSOR_CREATIVE_ID = "creative_dust_wave_demo_direct";
const HOUSE_CREATIVE_ID = "creative_dust_wave_demo_house";
const TARGETING_DIMENSIONS = Object.freeze([
  "show",
  "episode",
  "position",
  "date",
  "device",
  "app"
]);

export function runDirectSponsorDemoGate() {
  const source = fixture.sources.find(({ id }) => id === "direct-ad");
  if (!source) throw new Error("The virtual-audio fixture lacks direct-ad audio.");
  const audio = exactFixtureBytes(source);
  const audioSha256 = sha256(audio);
  if (audio.byteLength !== source.bytes || audioSha256 !== source.sha256) {
    throw new Error("The checked-in direct-ad fixture no longer matches its digest.");
  }
  const media = validateDynamicAdInsertionMp3(audio);
  const campaigns = demoCampaigns({
    audioBytes: media.audioBytes,
    durationMs: media.durationMs,
    sha256: audioSha256,
    streamProfile: media.profile
  });
  const context = {
    showId: SHOW_ID,
    episodeId: EPISODE_ID,
    deviceType: "mobile",
    appName: "apple_podcasts",
    streamProfile: media.profile,
    now: FIXED_NOW
  };
  const primarySlots = selectAdSlots(
    campaigns,
    context,
    ["mid"],
    "dust-wave-demo-primary-v1"
  );
  const fallbackSlots = selectHouseFallbackSlots(
    campaigns,
    context,
    primarySlots,
    "dust-wave-demo-fallback-v1"
  );
  const primary = primarySlots[0]?.selection;
  const fallback = fallbackSlots[0]?.selection;
  if (
    primary?.campaignId !== SPONSOR_CAMPAIGN_ID
    || primary.campaignType !== "direct"
  ) {
    throw new Error("The demo did not select the Dust Wave direct campaign.");
  }
  if (
    fallback?.campaignId !== HOUSE_CAMPAIGN_ID
    || fallback.campaignType !== "house"
  ) {
    throw new Error("The demo did not select the Dust Wave house fallback.");
  }
  for (const field of [
    "audioBytes",
    "audioMimeType",
    "creativeDurationMs",
    "streamProfile"
  ]) {
    if (primary[field] !== fallback[field]) {
      throw new Error(`The house fallback differs at ${field}.`);
    }
  }
  if (primary.creativeSha256 !== fallback.creativeSha256) {
    throw new Error("The house fallback is not byte-identical to the demo spot.");
  }

  const targeting = verifyTargetingMatrix(campaigns[0], context);
  const manifests = demoManifests({
    direct: primary,
    house: fallback,
    streamProfile: media.profile
  });
  const primaryManifest = compileVirtualMediaManifest(manifests.primary);
  const fallbackManifest = compileVirtualMediaManifest(manifests.fallback);
  const lengthContract = buildVirtualMediaLengthContract(
    manifests.primary,
    manifests.fallback
  );
  if (!lengthContract.equalByteLength) {
    throw new Error("The Dust Wave demo lacks equal-byte house coverage.");
  }

  return {
    schemaVersion: "dust-wave-direct-sponsor-demo-gate-v1",
    fixtureSchemaVersion: fixture.schemaVersion,
    sponsor: "Dust Wave",
    campaignCount: campaigns.length,
    targeting,
    media: {
      profile: media.profile,
      audioBytes: media.audioBytes,
      durationMs: media.durationMs,
      frameCount: media.frameCount,
      sha256: audioSha256
    },
    decision: {
      position: "mid",
      primaryCampaignType: primary.campaignType,
      primaryCampaignId: primary.campaignId,
      primaryCreativeId: primary.creativeId,
      fallbackType: "house_fill",
      fallbackCampaignType: fallback.campaignType,
      fallbackCampaignId: fallback.campaignId,
      fallbackCreativeId: fallback.creativeId,
      primaryBytes: primaryManifest.totalBytes,
      fallbackBytes: fallbackManifest.totalBytes,
      lengthContract
    },
    boundaries: {
      syntheticAudioOnly: true,
      stagingMutationPerformed: false,
      billingEligible: false,
      qualifiedImpressions: 0,
      nativeClientValidated: false,
      launchGateEligible: false
    },
    passed: true
  };
}

function demoCampaigns({ audioBytes, durationMs, sha256, streamProfile }) {
  const shared = {
    revision: 1,
    approvalStatus: "approved",
    active: true,
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-09-01T00:00:00.000Z",
    killSwitchAt: null,
    impressionCap: 1_000,
    qualifiedImpressionGoal: 100,
    qualifiedImpressions: 0,
    pacingStrategy: "even",
    rules: [{
      id: "rule_dust_wave_demo_mid_mobile_apple",
      showId: SHOW_ID,
      episodeId: EPISODE_ID,
      position: "mid",
      deviceType: "mobile",
      appName: "apple_podcasts",
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-09-01T00:00:00.000Z"
    }]
  };
  const creative = {
    audioBytes,
    audioMimeType: "audio/mpeg",
    audioEtag: `"demo-${sha256}"`,
    streamProfile,
    sha256,
    durationMs,
    weight: 1,
    active: true,
    validationStatus: "ready"
  };
  return [
    {
      ...shared,
      id: SPONSOR_CAMPAIGN_ID,
      campaignType: "direct",
      sponsorActive: true,
      priority: 20,
      creatives: [{
        ...creative,
        id: SPONSOR_CREATIVE_ID,
        campaignId: SPONSOR_CAMPAIGN_ID,
        objectKey: "fixtures/direct-sponsor-demo/direct.mp3"
      }]
    },
    {
      ...shared,
      id: HOUSE_CAMPAIGN_ID,
      campaignType: "house",
      sponsorActive: false,
      priority: 10,
      creatives: [{
        ...creative,
        id: HOUSE_CREATIVE_ID,
        campaignId: HOUSE_CAMPAIGN_ID,
        objectKey: "fixtures/direct-sponsor-demo/house.mp3"
      }]
    }
  ];
}

function verifyTargetingMatrix(directCampaign, context) {
  const positive = selectAdForSlot(
    [directCampaign],
    { ...context, position: "mid" },
    "dust-wave-demo-targeting-v1"
  );
  if (positive?.campaignId !== SPONSOR_CAMPAIGN_ID) {
    throw new Error("The exact demo targeting context was not selected.");
  }
  const negativeContexts = [
    { ...context, showId: "show_other", position: "mid" },
    { ...context, episodeId: "episode_other", position: "mid" },
    { ...context, position: "pre" },
    { ...context, now: "2026-07-31T23:59:59.999Z", position: "mid" },
    { ...context, now: "2026-09-01T00:00:00.001Z", position: "mid" },
    { ...context, deviceType: "desktop", position: "mid" },
    { ...context, appName: "spotify", position: "mid" }
  ];
  if (negativeContexts.some((candidate, index) =>
    selectAdForSlot(
      [directCampaign],
      candidate,
      `dust-wave-demo-negative-${index}`
    ) !== null
  )) {
    throw new Error("A mismatched demo targeting dimension selected inventory.");
  }
  return {
    dimensions: TARGETING_DIMENSIONS,
    positiveChecks: 1,
    negativeChecks: negativeContexts.length,
    allPassed: true
  };
}

function demoManifests({ direct, house, streamProfile }) {
  const programSources = fixture.sources.filter(
    ({ id }) => id === "program-pre" || id === "program-post"
  );
  if (programSources.length !== 2) {
    throw new Error("The demo requires exact pre/post program fixture sources.");
  }
  const programSegments = programSources.map((source, index) => ({
    id: `program_${index + 1}`,
    kind: "program",
    objectKey: source.objectKey,
    objectBytes: source.bytes,
    sourceOffset: 0,
    byteLength: source.bytes,
    contentType: "audio/mpeg",
    streamProfile
  }));
  const adSegment = (selection, kind, objectKey) => ({
    id: `${kind}_midroll`,
    kind,
    objectKey,
    objectBytes: selection.audioBytes,
    sourceOffset: 0,
    byteLength: selection.audioBytes,
    contentType: "audio/mpeg",
    streamProfile
  });
  const base = {
    schemaVersion: "1",
    episodeId: EPISODE_ID,
    decisionId: DECISION_ID,
    contentType: "audio/mpeg",
    streamProfile,
    validatedAt: FIXED_NOW
  };
  return {
    primary: {
      ...base,
      id: "manifest_dust_wave_demo_primary",
      etag: "\"dust-wave-demo-primary-v1\"",
      segments: [
        programSegments[0],
        adSegment(direct, "direct_ad", direct.objectKey),
        programSegments[1]
      ]
    },
    fallback: {
      ...base,
      id: "manifest_dust_wave_demo_house",
      etag: "\"dust-wave-demo-house-v1\"",
      segments: [
        programSegments[0],
        adSegment(house, "house_ad", house.objectKey),
        programSegments[1]
      ]
    }
  };
}

function exactFixtureBytes(source) {
  const frame = Buffer.from(source.frameBase64, "base64");
  if (frame.byteLength !== source.frameBytes) {
    throw new Error("The direct-ad frame declaration is invalid.");
  }
  return Buffer.concat(Array.from({ length: source.frameCount }, () => frame));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
