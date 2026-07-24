import { describe, expect, it } from "vitest";

import {
  buildAdRequestKey,
  normalizePodcastClient,
  selectAdForSlot,
  selectAdSlots,
  type AdCampaignCandidate,
  type AdSelectionContext
} from "../src/ad-decision";

const context: AdSelectionContext = {
  showId: "show-1",
  episodeId: "episode-1",
  position: "mid",
  deviceType: "mobile",
  appName: "apple_podcasts",
  streamProfile: "mp3-44100-stereo-cbr128-frame-v1",
  now: "2026-07-24T12:00:00.000Z"
};
const { position: _position, ...baseContext } = context;

describe("dynamic ad decisions", () => {
  it("prefers priority, direct inventory, and the most specific rule", () => {
    const house = campaign("house", "house");
    const genericDirect = campaign("direct-generic", "direct");
    const episodeDirect = campaign("direct-episode", "direct", {
      rules: [{
        id: "episode-rule",
        showId: "show-1",
        episodeId: "episode-1",
        position: "mid",
        deviceType: "mobile",
        appName: "Apple Podcasts"
      }]
    });

    expect(
      selectAdForSlot(
        [house, genericDirect, episodeDirect],
        context,
        "stable-seed"
      )
    ).toMatchObject({
      campaignId: "direct-episode",
      ruleId: "episode-rule",
      reason: { priority: 10, specificity: 31 }
    });

    house.priority = 20;
    expect(
      selectAdForSlot(
        [house, genericDirect, episodeDirect],
        context,
        "stable-seed"
      )?.campaignId
    ).toBe("house");
  });

  it("rejects dates, caps, kill switches, invalid media, and profile mismatches", () => {
    const future = campaign("future", "direct", {
      startsAt: "2026-07-24T12:00:01.000Z"
    });
    const ended = campaign("ended", "direct", {
      endsAt: "2026-07-24T11:59:59.000Z"
    });
    const capped = campaign("capped", "direct", {
      impressionCap: 10,
      qualifiedImpressions: 10
    });
    const killed = campaign("killed", "direct", {
      killSwitchAt: "2026-07-24T11:00:00.000Z"
    });
    const invalidMedia = campaign("invalid", "direct");
    invalidMedia.creatives[0].validationStatus = "failed";
    const mismatched = campaign("mismatch", "direct");
    mismatched.creatives[0].streamProfile = "different-profile";

    expect(
      selectAdForSlot(
        [future, ended, capped, killed, invalidMedia, mismatched],
        context,
        "stable-seed"
      )
    ).toBeNull();
  });

  it("fails closed on invalid campaign and rule inputs", () => {
    const invalidStart = campaign("invalid-start", "direct", {
      startsAt: "not-a-date"
    });
    const invalidKillSwitch = campaign("invalid-kill", "direct", {
      killSwitchAt: "not-a-date"
    });
    const invalidCounters = campaign("invalid-counters", "direct", {
      qualifiedImpressions: -1
    });
    const mismatchedRule = campaign("mismatched-rule", "direct", {
      rules: [{
        id: "mismatched-rule-target",
        showId: "show-1",
        position: "mid",
        deviceType: "desktop",
        appName: "Spotify",
        startsAt: "2026-07-01T00:00:00.000Z",
        endsAt: "2026-08-01T00:00:00.000Z"
      }]
    });
    const invalidRuleDate = campaign("invalid-rule-date", "direct", {
      rules: [{
        id: "invalid-rule-date-target",
        showId: "show-1",
        startsAt: "not-a-date"
      }]
    });

    expect(
      selectAdForSlot(
        [
          invalidStart,
          invalidKillSwitch,
          invalidCounters,
          mismatchedRule,
          invalidRuleDate
        ],
        context,
        "stable-seed"
      )
    ).toBeNull();
  });

  it("returns stable weighted choices and avoids campaign repeats when possible", () => {
    const first = campaign("first", "direct");
    const second = campaign("second", "direct");
    const slotsA = selectAdSlots(
      [first, second],
      baseContext,
      ["pre", "mid", "post"],
      "repeatable"
    );
    const slotsB = selectAdSlots(
      [second, first],
      baseContext,
      ["pre", "mid", "post"],
      "repeatable"
    );

    expect(slotsA).toEqual(slotsB);
    expect(slotsA[0].selection?.campaignId).not.toBe(
      slotsA[1].selection?.campaignId
    );
    expect(slotsA).toHaveLength(3);
    expect(() =>
      selectAdSlots(
        [first],
        baseContext,
        ["pre", "pre"],
        "invalid"
      )
    ).toThrow("at most one pre, mid, and post");
  });

  it("normalizes supported podcast apps without retaining the raw user agent", () => {
    expect(
      normalizePodcastClient(
        "Podcasts/1700.1 CFNetwork iPhone OS/19.0"
      )
    ).toEqual({ appName: "apple_podcasts", deviceType: "mobile" });
    expect(
      normalizePodcastClient(
        "Pocket Casts/7.80 (Linux; Android 16; Pixel 10 Mobile)"
      )
    ).toEqual({ appName: "pocket_casts", deviceType: "mobile" });
    expect(
      normalizePodcastClient(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)"
      )
    ).toEqual({ appName: "browser", deviceType: "desktop" });
    expect(
      normalizePodcastClient(
        "Spotify/9.0 (Linux; Android 16; Pixel Tablet)"
      )
    ).toEqual({ appName: "spotify", deviceType: "tablet" });
  });

  it("builds an hourly pseudonymous request key without returning the address", async () => {
    const input = {
      secret: "test-decision-secret",
      episodeId: "episode-1",
      publicationRevision: 2,
      inventoryFingerprint: "inventory-v4",
      clientAddress: "192.0.2.10",
      client: { deviceType: "mobile", appName: "apple_podcasts" } as const,
      now: "2026-07-24T12:34:56.000Z"
    };
    const first = await buildAdRequestKey(input);
    const second = await buildAdRequestKey(input);
    const nextHour = await buildAdRequestKey({
      ...input,
      now: "2026-07-24T13:00:00.000Z"
    });

    expect(first).toEqual(second);
    expect(first.privacyEpoch).toBe("2026-07-24");
    expect(first.decisionEpoch).toBe("2026-07-24T12");
    expect(first.requestKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(input.clientAddress);
    expect(nextHour.requestKeyHash).not.toBe(first.requestKeyHash);
  });
});

function campaign(
  id: string,
  campaignType: "house" | "direct",
  overrides: Partial<AdCampaignCandidate> = {}
): AdCampaignCandidate {
  return {
    id,
    campaignType,
    active: true,
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
    killSwitchAt: null,
    priority: 10,
    impressionCap: null,
    qualifiedImpressionGoal: 1_000,
    qualifiedImpressions: 100,
    pacingStrategy: "even",
    rules: [],
    creatives: [{
      id: `${id}-creative`,
      campaignId: id,
      objectKey: `ads/${id}.mp3`,
      audioBytes: 32_000,
      audioMimeType: "audio/mpeg",
      streamProfile: "mp3-44100-stereo-cbr128-frame-v1",
      weight: 1,
      active: true,
      validationStatus: "ready"
    }],
    ...overrides
  };
}
