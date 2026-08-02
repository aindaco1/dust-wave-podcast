import { describe, expect, it } from "vitest";

import { runDirectSponsorDemoGate } from
  "../scripts/lib/direct-sponsor-demo-gate.mjs";

describe("Dust Wave direct-sponsor demo gate", () => {
  it("rehearses a non-billable direct campaign with house fill", () => {
    const evidence = runDirectSponsorDemoGate();
    expect(evidence.passed).toBe(true);
    expect(evidence.sponsor).toBe("Dust Wave");
    expect(evidence.campaignCount).toBe(2);
    expect(evidence.targeting.dimensions).toEqual([
      "show",
      "episode",
      "position",
      "date",
      "device",
      "app"
    ]);
    expect(evidence.targeting).toMatchObject({
      positiveChecks: 1,
      negativeChecks: 7,
      allPassed: true
    });
    expect(evidence.decision).toMatchObject({
      primaryCampaignType: "direct",
      fallbackType: "house_fill",
      fallbackCampaignType: "house",
      lengthContract: { equalByteLength: true }
    });
    expect(evidence.decision.primaryBytes).toBe(
      evidence.decision.fallbackBytes
    );
  });

  it("never promotes synthetic rehearsal evidence into billing or launch", () => {
    expect(runDirectSponsorDemoGate().boundaries).toEqual({
      syntheticAudioOnly: true,
      stagingMutationPerformed: false,
      billingEligible: false,
      qualifiedImpressions: 0,
      nativeClientValidated: false,
      launchGateEligible: false
    });
  });
});
