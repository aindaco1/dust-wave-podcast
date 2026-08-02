import { hmacSha256 } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

const secret = "launch_lab_secret_fixture";
const sourceCommit = "a".repeat(40);

describe("Launch Lab staging boundary", () => {
  it("returns not found before D1 when the staging secret is unavailable", async () => {
    let prepared = false;
    const response = await handleRequest(
      new Request(
        "https://feeds.example/v1/diagnostics/launch-lab",
        { method: "POST" }
      ),
      {
        ENVIRONMENT: "production",
        DB: {
          prepare() {
            prepared = true;
            throw new Error("D1 must not be reached");
          }
        }
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(404);
    expect(prepared).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reconciles only the immutable fixture and returns content-free safeguards", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = launchLabEnv({ writes });
    const response = await handleRequest(
      await signedRequest({
        schemaVersion: "dust-wave-launch-lab-request-v1",
        action: "reconcile",
        runId: "launch_lab_run_0001",
        sourceCommit
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: "dust-wave-launch-lab-response-v1",
      runId: "launch_lab_run_0001",
      sourceCommit,
      showId: "show_dust_wave_launch_lab",
      testFixture: true,
      publiclyDiscoverable: false,
      launchEligible: false,
      billable: false,
      rssDirectoryBlocked: true
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].query).toContain("WHERE shows.test_fixture = 1");
    expect(writes[0].values).toEqual(expect.arrayContaining([
      "show_dust_wave_launch_lab",
      "dust-wave-launch-lab",
      "https://staging.example/podcasts/dust-wave-launch-lab/"
    ]));
  });

  it("conceals invalid signatures and rejects a real-show collision", async () => {
    const unsigned = new Request(
      "https://feeds.example/v1/diagnostics/launch-lab",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "dust-wave-launch-lab-request-v1",
          action: "reconcile",
          runId: "launch_lab_run_0002",
          sourceCommit
        })
      }
    );
    expect((await handleRequest(unsigned, launchLabEnv())).status).toBe(404);

    const collision = await handleRequest(
      await signedRequest({
        schemaVersion: "dust-wave-launch-lab-request-v1",
        action: "reconcile",
        runId: "launch_lab_run_0003",
        sourceCommit
      }),
      launchLabEnv({
        collision: {
          id: "show_dust_wave_launch_lab",
          slug: "dust-wave-launch-lab",
          rss_slug: "dust-wave-launch-lab",
          test_fixture: 0
        }
      })
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({
      error: "launch_lab_fixture_collision"
    });
  });

  it("rejects arbitrary identities before writing", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const response = await handleRequest(
      await signedRequest({
        schemaVersion: "dust-wave-launch-lab-request-v1",
        action: "reconcile",
        runId: "short",
        sourceCommit: "not-a-commit"
      }),
      launchLabEnv({ writes })
    );
    expect(response.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

function launchLabEnv({
  collision = null,
  writes = []
}: {
  collision?: Record<string, unknown> | null;
  writes?: Array<{ query: string; values: unknown[] }>;
} = {}): PodcastEnv {
  const scenarioRows: Array<{
    provider: string;
    scenario: string;
    expected_status: string;
  }> = [];
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://staging.example",
    LAUNCH_LAB_CALLBACK_SECRET: secret,
    DB: {
      async batch(statements: D1PreparedStatement[]) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async first() {
            if (query.includes("SELECT id, slug, rss_slug, test_fixture")) {
              return collision;
            }
            if (query.includes("INSERT INTO shows")) {
              writes.push({ query, values });
              return {
                id: "show_dust_wave_launch_lab",
                test_fixture: 1
              };
            }
            if (query.includes("FROM launch_lab_runs")) {
              return {
                id: String(values[0]),
                show_id: "show_dust_wave_launch_lab",
                source_commit: sourceCommit,
                status: "running",
                started_at: "2026-08-01T00:00:00.000Z",
                completed_at: null
              };
            }
            return null;
          },
          async all() {
            if (query.includes("FROM launch_lab_provider_scenarios")) {
              return { results: scenarioRows };
            }
            return { results: [] };
          },
          async run() {
            if (query.includes(
              "INSERT OR IGNORE INTO launch_lab_provider_scenarios"
            )) {
              const key = `${values[2]}:${values[3]}`;
              if (!scenarioRows.some((row) =>
                `${row.provider}:${row.scenario}` === key
              )) {
                scenarioRows.push({
                  provider: String(values[2]),
                  scenario: String(values[3]),
                  expected_status: String(values[4])
                });
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
        };
      }
    } as unknown as D1Database
  } as unknown as PodcastEnv;
}

async function signedRequest(
  body: Record<string, unknown>
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    String(timestamp) + "." + rawBody,
    secret,
    "hex"
  );
  return new Request(
    "https://feeds.example/v1/diagnostics/launch-lab",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podcast-launch-lab-timestamp": String(timestamp),
        "x-podcast-launch-lab-signature": signature
      },
      body: rawBody
    }
  );
}
