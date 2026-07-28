import { describe, expect, it } from "vitest";

import {
  loadDistributionLaunchCertification
} from "../src/distribution-certification";

describe("shared distribution launch certification", () => {
  it("uses one enabled-destination rule for API and publication readiness", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              status: "valid",
              feed_url: "https://feeds.dustwave.xyz/opera/rss.xml",
              validator_version: "dustwave-rss-launch-v2",
              feed_sha256: "a".repeat(64),
              item_count: 1,
              failure_code: null,
              checked_at: "2026-07-27T12:00:00.000Z",
              validated_at: "2026-07-27T12:00:00.000Z"
            };
          },
          async all() {
            return {
              results: [
                destination({
                  destination_id: "spotify",
                  owner_setup_status: "verified"
                }),
                destination({
                  destination_id: "disabled_history",
                  enabled: 0,
                  owner_setup_status: "verified"
                }),
                destination({
                  destination_id: "setup_pending",
                  owner_setup_status: "pending",
                  ingestion_observed: 0,
                  failure_recovery_verified: 0
                })
              ]
            };
          }
        };
      }
    } as unknown as D1Database;

    const result = await loadDistributionLaunchCertification(db, "show_opera");

    expect(result.summary).toEqual({
      total: 3,
      enabled: 2,
      setupComplete: 1,
      setupRequired: 1,
      feedValidated: true,
      ingestionObserved: 1,
      failureRecoveryVerified: 1,
      certified: 1
    });
    expect(result.launchClaim).toEqual({
      ready: false,
      requiredDestinations: 10,
      certifiedDestinations: 1,
      remainingDestinations: 9
    });
    expect(result.byDestinationId.get("disabled_history")).toEqual({
      ownerVerified: true,
      feedValidated: true,
      ingestionObserved: true,
      failureRecoveryVerified: true,
      certified: false
    });
    expect(
      queries.some((query) =>
        query.includes("recovered.sequence > failed.sequence")
      )
    ).toBe(true);
  });

  it("does not certify a feed validated under an older contract", async () => {
    const db = {
      prepare(query: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              status: "valid",
              feed_url: "https://feeds.dustwave.xyz/opera/rss.xml",
              validator_version: "dustwave-rss-launch-v1",
              feed_sha256: "a".repeat(64),
              item_count: 1,
              failure_code: null,
              checked_at: "2026-07-27T12:00:00.000Z",
              validated_at: "2026-07-27T12:00:00.000Z"
            };
          },
          async all() {
            if (!query.includes("scoped_destinations")) {
              throw new Error("Unexpected certification query");
            }
            return { results: [destination()] };
          }
        };
      }
    } as unknown as D1Database;

    const result = await loadDistributionLaunchCertification(
      db,
      "show_opera"
    );

    expect(result.feedValidation.status).toBe("valid");
    expect(result.summary.feedValidated).toBe(false);
    expect(result.summary.certified).toBe(0);
    expect(result.launchClaim.ready).toBe(false);
  });
});

function destination(overrides: Partial<{
  destination_id: string;
  enabled: number;
  owner_setup_status: string;
  ingestion_observed: number;
  failure_recovery_verified: number;
}> = {}) {
  return {
    destination_id: "destination",
    enabled: 1,
    owner_setup_status: "verified",
    ingestion_observed: 1,
    failure_recovery_verified: 1,
    ...overrides
  };
}
