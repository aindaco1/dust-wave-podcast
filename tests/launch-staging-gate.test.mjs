import { describe, expect, it } from "vitest";

import {
  evaluateVirtualAudioEvidence,
  evaluateLaunchStagingReadiness,
  presentStoredVirtualAudioEvidence,
  publicFeedValidatorVersion
} from "../scripts/check-launch-staging-readiness.mjs";

const stagingVars = {
  AD_DECISION_MODE: "staging_validate",
  ANNOUNCEMENT_DELIVERY_MODE: "dry_run",
  CLIP_PUBLICATION_MODE: "staging_preview",
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

function readySnapshot() {
  return {
    remoteReadOnly: true,
    stagingVars,
    productionVars,
    requiredSecrets: ["ONE", "TWO"],
    installedSecrets: ["ONE", "TWO"],
    show: {
      id: "show_fixture",
      premium_enabled: 1,
      rss_slug: "fixture",
      youtube_channel_url: "https://youtube.com/@fixture"
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
    distribution: {
      feedCurrent: true,
      certified: 10
    },
    youtube: {
      uploadedUnlisted: 1,
      unresolved: 0
    },
    resend: {
      delivered: 1,
      suppressed: 1,
      failed: 0
    },
    dynamicAds: {
      approvedPlans: 1,
      selectedDecisions: 1,
      directQualifications: 1
    },
    virtualAudioEvidence: {
      passed: true
    },
    foreignKeyViolations: 0
  };
}

describe("launch staging gate", () => {
  it("passes only when automated launch evidence and kill switches are ready", () => {
    const report = evaluateLaunchStagingReadiness(readySnapshot());

    expect(report.summary).toEqual({
      passCount: 12,
      failCount: 0,
      blockCount: 0,
      waitCount: 0,
      safe: true,
      launchReady: true
    });
    expect(report.nextAction).toBeNull();
  });

  it("fails closed for unsafe modes, missing secret names, or writes", () => {
    const snapshot = readySnapshot();
    snapshot.remoteReadOnly = false;
    snapshot.stagingVars = {
      ...stagingVars,
      YOUTUBE_PUBLISH_MODE: "controlled_test"
    };
    snapshot.productionVars = {
      ...productionVars,
      AD_DECISION_MODE: "live"
    };
    snapshot.installedSecrets = ["ONE"];

    const report = evaluateLaunchStagingReadiness(snapshot);

    expect(report.summary.safe).toBe(false);
    expect(report.summary.failCount).toBe(4);
    expect(report.nextAction?.id).toBe("read_only");
    expect(report.nodes.find(({ id }) => id === "staging_secrets")?.detail)
      .toBe("missing required name(s): TWO");
  });

  it("keeps external promotion evidence as explicit blocks", () => {
    const snapshot = readySnapshot();
    snapshot.episodeReport.summary.blockCount = 2;
    snapshot.episodeReport.summary.waitCount = 1;
    snapshot.episodeReport.nextAction = {
      label: "Enhancement decision",
      detail: "listen and promote or reject"
    };
    snapshot.stripeReport.summary.blockerCount = 1;
    snapshot.stripeReport.results = [{
      status: "BLOCK",
      label: "Accountant-approved tax",
      detail: "approval remains required"
    }];
    snapshot.distribution = { feedCurrent: false, certified: 9 };
    snapshot.youtube = { uploadedUnlisted: 0, unresolved: 1 };
    snapshot.resend = { delivered: 0, suppressed: 0, failed: 0 };
    snapshot.dynamicAds = {
      approvedPlans: 1,
      selectedDecisions: 0,
      directQualifications: 0
    };

    const report = evaluateLaunchStagingReadiness(snapshot);

    expect(report.summary.safe).toBe(true);
    expect(report.summary.launchReady).toBe(false);
    expect(report.summary.blockCount).toBe(6);
    expect(report.nextAction?.id).toBe("episode");
    expect(report.nextAction?.detail).toContain(
      "Enhancement decision - listen and promote or reject"
    );
    expect(report.nodes.find(({ id }) => id === "dynamic_ads")?.detail)
      .toBe(
        "missing durable evidence: selected ad decision, "
        + "qualified direct-sponsor download"
      );
  });

  it("names both synthetic and durable dynamic-ad evidence when absent", () => {
    const snapshot = readySnapshot();
    snapshot.virtualAudioEvidence = null;
    snapshot.dynamicAds = {
      approvedPlans: 0,
      selectedDecisions: 0,
      directQualifications: 0
    };

    const report = evaluateLaunchStagingReadiness(snapshot);

    expect(report.nodes.find(({ id }) => id === "dynamic_ads")?.detail)
      .toBe(
        "run the current signed synthetic protocol/load gate; "
        + "missing durable evidence: approved episode ad plan, "
        + "selected ad decision, qualified direct-sponsor download"
      );
  });

  it("prioritizes safety failures ahead of earlier promotion blocks", () => {
    const snapshot = readySnapshot();
    snapshot.episodeReport.summary.blockCount = 1;
    snapshot.foreignKeyViolations = 1;

    const report = evaluateLaunchStagingReadiness(snapshot);

    expect(report.nextAction?.id).toBe("foreign_keys");
  });

  it("resolves the validator version from the Worker source of truth", () => {
    expect(publicFeedValidatorVersion(
      'export const PUBLIC_FEED_VALIDATOR_VERSION =\n  "dustwave-rss-v4";'
    )).toBe("dustwave-rss-v4");
    expect(() => publicFeedValidatorVersion("const version = 'unknown';"))
      .toThrow("could not be resolved");
  });

  it("requires fresh, current, cleaned synthetic load evidence", () => {
    const evidence = {
      schemaVersion: "dust-wave-virtual-audio-staging-gate-v1",
      generatedAt: new Date().toISOString(),
      scope: {
        syntheticProtocolEmulation: true,
        signedCapability: true,
        pairs: 5_000,
        totalMeasuredRequests: 10_000
      },
      result: {
        passed: true,
        cleanupComplete: true,
        diagnosticLeaseRemoved: true,
        uploadedObjectsRemoved: true,
        failureCode: null
      }
    };

    expect(evaluateVirtualAudioEvidence(evidence, true)).toEqual({
      passed: true
    });
    expect(evaluateVirtualAudioEvidence(evidence, false)).toEqual({
      passed: false
    });
    evidence.result.cleanupComplete = false;
    expect(evaluateVirtualAudioEvidence(evidence, true)).toEqual({
      passed: false
    });
  });

  it("maps the durable aggregate row into the same current-source gate", () => {
    const row = {
      source_commit: "a".repeat(40),
      generated_at: new Date().toISOString(),
      paired_requests: 5_000,
      total_measured_requests: 10_000,
      protocol_passed: 1,
      load_passed: 1,
      cleanup_complete: 1,
      diagnostic_lease_removed: 1,
      uploaded_objects_removed: 1,
      failure_code: null
    };

    expect(presentStoredVirtualAudioEvidence(row, true)).toEqual({
      passed: true
    });
    expect(presentStoredVirtualAudioEvidence(row, false)).toEqual({
      passed: false
    });
    expect(presentStoredVirtualAudioEvidence(null, true)).toBeNull();
  });
});
