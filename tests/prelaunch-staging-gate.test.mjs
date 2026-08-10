import { describe, expect, it } from "vitest";

import {
  goldenCanaryRequirements,
  presentGoldenCanaryEvidence
} from "../scripts/check-launch-staging-readiness.mjs";
import {
  evaluatePrelaunchStagingReadiness
} from "../scripts/check-prelaunch-staging-readiness.mjs";

const stagingVars = {
  AD_DECISION_MODE: "staging_validate",
  ANNOUNCEMENT_DELIVERY_MODE: "dry_run",
  CLIP_PUBLICATION_MODE: "staging_preview",
  DISTRIBUTION_OBSERVATION_MODE: "staging_probe",
  GITHUB_PUBLISH_MODE: "dry_run",
  PUBLICATION_GATE_MODE: "shadow",
  RSS_IMPORT_EXECUTION_MODE: "staging_copy",
  STRIPE_MODE: "test",
  SUBSCRIPTION_CHECKOUT_ENABLED: "false",
  POOL_REDEMPTION_ENABLED: "false",
  CHECKOUT_TURNSTILE_REQUIRED: "true",
  ADMIN_TURNSTILE_REQUIRED: "false",
  LISTENER_TURNSTILE_REQUIRED: "true",
  YOUTUBE_PUBLISH_MODE: "dry_run"
};

const productionVars = {
  AD_DECISION_MODE: "disabled",
  ANNOUNCEMENT_DELIVERY_MODE: "disabled",
  CLIP_PUBLICATION_MODE: "disabled",
  DISTRIBUTION_OBSERVATION_MODE: "disabled",
  GITHUB_PUBLISH_MODE: "dry_run",
  PUBLICATION_GATE_MODE: "legacy",
  RSS_IMPORT_EXECUTION_MODE: "disabled",
  STRIPE_MODE: "test",
  SUBSCRIPTION_CHECKOUT_ENABLED: "false",
  POOL_REDEMPTION_ENABLED: "false",
  CHECKOUT_TURNSTILE_REQUIRED: "true",
  ADMIN_TURNSTILE_REQUIRED: "true",
  LISTENER_TURNSTILE_REQUIRED: "true",
  SHOW_NOTES_AI_ENABLED: "false",
  CHAPTER_DRAFT_AI_ENABLED: "false",
  CLIP_DRAFT_AI_ENABLED: "false",
  YOUTUBE_PUBLISH_MODE: "dry_run"
};

function platformReadySnapshot() {
  return {
    remoteReadOnly: true,
    stagingVars,
    productionVars,
    requiredSecrets: ["ONE", "TWO"],
    installedSecrets: ["ONE", "TWO"],
    show: {
      id: "show_launch",
      premium_enabled: 1,
      rss_slug: "launch",
      youtube_channel_url: "https://youtube.com/@launch",
      test_fixture: 0
    },
    episodeReport: {
      nextAction: null,
      summary: {
        passCount: 10,
        blockCount: 0,
        waitCount: 0,
        failCount: 0
      }
    },
    stripeReport: {
      results: [],
      summary: {
        passCount: 15,
        blockerCount: 0,
        failCount: 0
      }
    },
    distribution: { feedCurrent: false, certified: 0 },
    youtube: {
      channelAccessReady: true,
      uploadedUnlisted: 0,
      unresolved: 0
    },
    resend: {
      consentedDelivered: 1,
      postDeliveryWithdrawals: 1,
      listenerSuppressed: 0,
      providerSuppression: 1,
      failed: 0
    },
    dynamicAds: {
      approvedPlans: 0,
      selectedDecisions: 0,
      directQualifications: 0
    },
    virtualAudioEvidence: { passed: true },
    goldenCanaryEvidence: {
      passed: true,
      requirementCount: goldenCanaryRequirements.length,
      observedRequirementCount: goldenCanaryRequirements.length,
      passedCount: goldenCanaryRequirements.length,
      failureCount: 0,
      fresh: true,
      sourceCurrent: true
    },
    foreignKeyViolations: 0
  };
}

describe("prelaunch staging gate", () => {
  it("separates platform readiness from truthful content deferrals", () => {
    const report = evaluatePrelaunchStagingReadiness(
      platformReadySnapshot()
    );

    expect(report.summary).toEqual({
      passCount: 12,
      failCount: 0,
      blockCount: 0,
      waitCount: 0,
      deferredCount: 3,
      safe: true,
      platformReady: true,
      launchReady: false
    });
    expect(report.nextAction).toBeNull();
    expect(report.contentNextAction?.id).toBe("distribution");
    expect(report.nodes.find(({ id }) => id === "golden_canary"))
      .toMatchObject({ status: "PASS" });
    expect(report.nodes.filter(({ status }) => status === "DEFER")
      .map(({ id }) => id)).toEqual([
        "distribution",
        "youtube",
        "dynamic_ads"
      ]);
  });

  it("fails the platform boundary on an explicit canary failure", () => {
    const snapshot = platformReadySnapshot();
    snapshot.goldenCanaryEvidence = {
      ...snapshot.goldenCanaryEvidence,
      passed: false,
      passedCount: goldenCanaryRequirements.length - 1,
      failureCount: 1
    };

    const report = evaluatePrelaunchStagingReadiness(snapshot);

    expect(report.summary.platformReady).toBe(false);
    expect(report.summary.launchReady).toBe(false);
    expect(report.summary.failCount).toBe(1);
    expect(report.nextAction?.id).toBe("golden_canary");
    expect(report.nodes.find(({ id }) => id === "golden_canary"))
      .toMatchObject({ status: "FAIL" });
  });

  it("blocks when the isolated or signed synthetic rehearsal is stale", () => {
    const staleLaunchLab = platformReadySnapshot();
    staleLaunchLab.goldenCanaryEvidence = {
      ...staleLaunchLab.goldenCanaryEvidence,
      passed: false,
      fresh: false
    };
    const missingAudio = platformReadySnapshot();
    missingAudio.virtualAudioEvidence = { passed: false };

    expect(evaluatePrelaunchStagingReadiness(staleLaunchLab).nodes
      .find(({ id }) => id === "golden_canary"))
      .toMatchObject({ status: "BLOCK" });
    expect(evaluatePrelaunchStagingReadiness(missingAudio).nodes
      .find(({ id }) => id === "golden_canary")?.detail)
      .toContain("signed synthetic media/load gate");
  });

  it("never converts a safety failure into a content deferral", () => {
    const snapshot = platformReadySnapshot();
    snapshot.remoteReadOnly = false;

    const report = evaluatePrelaunchStagingReadiness(snapshot);

    expect(report.summary.safe).toBe(false);
    expect(report.summary.platformReady).toBe(false);
    expect(report.nextAction?.id).toBe("read_only");
    expect(report.nodes.find(({ id }) => id === "read_only"))
      .toMatchObject({ status: "FAIL" });
  });

  it("is also launch ready after real content evidence passes", () => {
    const snapshot = platformReadySnapshot();
    snapshot.distribution = { feedCurrent: true, certified: 10 };
    snapshot.youtube.uploadedUnlisted = 1;
    snapshot.dynamicAds = {
      approvedPlans: 1,
      selectedDecisions: 1,
      directQualifications: 1
    };

    const report = evaluatePrelaunchStagingReadiness(snapshot);

    expect(report.summary.platformReady).toBe(true);
    expect(report.summary.launchReady).toBe(true);
    expect(report.summary.deferredCount).toBe(0);
  });
});

describe("golden canary evidence presentation", () => {
  it("accepts one complete, fresh, source-current isolated run", () => {
    const report = presentGoldenCanaryEvidence([{
      source_commit: "a".repeat(40),
      required_count: goldenCanaryRequirements.length,
      passed_count: goldenCanaryRequirements.length,
      failure_count: 0,
      oldest_completed_at: sqliteTimestamp(new Date())
    }], true);

    expect(report).toMatchObject({
      passed: true,
      observedRequirementCount: goldenCanaryRequirements.length,
      passedCount: goldenCanaryRequirements.length,
      failureCount: 0,
      fresh: true,
      sourceCurrent: true
    });
  });

  it("uses the newest run and fails closed on missing, failed, or stale work", () => {
    const now = new Date();
    const completeRow = {
      source_commit: "a".repeat(40),
      required_count: goldenCanaryRequirements.length,
      passed_count: goldenCanaryRequirements.length,
      failure_count: 0,
      oldest_completed_at: sqliteTimestamp(now)
    };
    const incomplete = {
      ...completeRow,
      required_count: goldenCanaryRequirements.length - 1,
      passed_count: goldenCanaryRequirements.length - 1
    };
    const failed = {
      ...completeRow,
      passed_count: goldenCanaryRequirements.length - 1,
      failure_count: 1
    };
    const stale = {
      ...completeRow,
      oldest_completed_at: sqliteTimestamp(
        new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
      )
    };

    expect(presentGoldenCanaryEvidence([incomplete, completeRow], true).passed)
      .toBe(false);
    expect(presentGoldenCanaryEvidence([failed], true).passed).toBe(false);
    expect(presentGoldenCanaryEvidence([stale], true).passed).toBe(false);
    expect(presentGoldenCanaryEvidence([completeRow], false).passed)
      .toBe(false);
  });

  it("keeps the required scenario list duplicate-free", () => {
    const keys = goldenCanaryRequirements.map(
      ({ provider, scenario }) => `${provider}:${scenario}`
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("directory:ingestion_observed");
    expect(keys).not.toContain("youtube:channel_identity");
    expect(keys).not.toContain("youtube:unlisted_audio_only");
    expect(keys).not.toContain("ads:native_client_qualified");
  });
});

function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
