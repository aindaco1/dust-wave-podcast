import { describe, expect, it } from "vitest";

import {
  recordDistributionObservation,
  type DistributionObservationPublication
} from "../src/distribution-observation-store";

const publication: DistributionObservationPublication = {
  id: "publication_fixture",
  showId: "show_fixture",
  episodeId: "episode_fixture",
  destinationId: "spotify",
  publicationRevision: 3,
  priorStatus: "waiting_for_feed",
  priorEvidenceUrl: null,
  priorError: null,
  priorEvidenceSource: null
};

describe("distribution observation store", () => {
  it("returns an identical observation without touching D1", async () => {
    const db = {
      prepare() {
        throw new Error("idempotent observation must not query D1");
      }
    } as unknown as D1Database;

    await expect(recordDistributionObservation(db, {
      publication: {
        ...publication,
        priorStatus: "failed",
        priorError: "listing_probe_http_404",
        priorEvidenceSource: "automated_probe"
      },
      status: "failed",
      evidenceUrl: null,
      error: "listing_probe_http_404",
      evidenceSource: "automated_probe",
      adminUserId: null
    })).resolves.toEqual({ status: "idempotent", eventId: null });
  });

  it("verifies committed rows instead of relying on batch change metadata", async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const db = verificationDatabase(queries, true);

    const result = await recordDistributionObservation(db, {
      publication,
      status: "observed",
      evidenceUrl: "https://open.spotify.com/show/fixture",
      error: null,
      evidenceSource: "automated_probe",
      adminUserId: null
    });

    expect(result).toMatchObject({ status: "recorded" });
    expect(queries.some(({ query, values }) =>
      query.includes("INSERT INTO distribution_observation_events")
      && values.includes("automated_probe")
      && values.includes("spotify")
    )).toBe(true);
    expect(queries.some(({ query }) =>
      query.includes("LEFT JOIN distribution_observation_events event")
    )).toBe(true);
  });

  it("fails closed when exact post-commit evidence cannot be read", async () => {
    const result = await recordDistributionObservation(
      verificationDatabase([], false),
      {
        publication,
        status: "failed",
        evidenceUrl: null,
        error: "listing_probe_network_failed",
        evidenceSource: "automated_probe",
        adminUserId: null
      }
    );
    expect(result).toMatchObject({ status: "conflict" });
  });
});

function verificationDatabase(
  queries: Array<{ query: string; values: unknown[] }>,
  verify: boolean
): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          queries.push({ query, values });
          return statement;
        },
        async first() {
          if (!verify) return null;
          const evidenceUrl = queries
            .find(({ query: candidate }) =>
              candidate.includes("UPDATE episode_publications")
            )?.values[1] ?? null;
          const evidenceSource = queries
            .find(({ query: candidate }) =>
              candidate.includes("UPDATE episode_publications")
            )?.values[2] ?? null;
          const lastError = queries
            .find(({ query: candidate }) =>
              candidate.includes("UPDATE episode_publications")
            )?.values[5] ?? null;
          return {
            status: queries
              .find(({ query: candidate }) =>
                candidate.includes("UPDATE episode_publications")
              )?.values[0],
            evidence_url: evidenceUrl,
            evidence_source: evidenceSource,
            last_error: lastError,
            event_id: values[0],
            audit_id: values[1]
          };
        }
      };
      return statement;
    },
    async batch() {
      return [{ success: true }, { success: true }, { success: true }];
    }
  } as unknown as D1Database;
}
