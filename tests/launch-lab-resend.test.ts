import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  recordLaunchLabResendWebhook,
  runLaunchLabResendMatrix
} from "../src/launch-lab-resend";

describe("Launch Lab Resend matrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses official provider scenarios, stable idempotency, and no recipient evidence", async () => {
    const database = scenarioDatabase();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        body,
        idempotencyKey: new Headers(init?.headers).get("idempotency-key")
      });
      return new Response(JSON.stringify({
        id: "email_" + String(requests.length).padStart(2, "0")
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const env = {
      DB: database.db,
      RESEND_API_KEY: "re_test_fixture",
      PODCAST_EMAIL_FROM: "Dust Wave Podcasts <podcasts@dustwave.xyz>"
    } as unknown as PodcastEnv;

    const accepted = await runLaunchLabResendMatrix(
      env,
      "launch_lab_run_0001"
    );

    expect(requests).toHaveLength(4);
    expect(requests.map(({ body }) =>
      ((body as Record<string, unknown>).to as string[])[0]
    ).sort()).toEqual([
      "bounced+lab_launch_lab_run_0001_resend_bounced@resend.dev",
      "complained+lab_launch_lab_run_0001_resend_complained@resend.dev",
      "delivered+lab_launch_lab_run_0001_resend_delivered@resend.dev",
      "suppressed@resend.dev"
    ]);
    expect(new Set(requests.map(({ idempotencyKey }) => idempotencyKey)).size)
      .toBe(4);
    expect(accepted).toMatchObject({
      passed: false,
      launchGateEligible: false,
      recipientIdentityRetained: false
    });

    for (const [scenario, status] of [
      ["delivered", "delivered"],
      ["bounced", "suppressed"],
      ["complained", "suppressed"],
      ["suppressed", "suppressed"]
    ] as const) {
      const row = database.rows.get(scenario);
      expect(row).toBeDefined();
      expect(await recordLaunchLabResendWebhook(database.db, {
        scenarioId: row!.id,
        providerId: row!.provider_id ?? "",
        status
      })).toBe(true);
    }
    const completed = await runLaunchLabResendMatrix(
      env,
      "launch_lab_run_0001"
    );
    expect(requests).toHaveLength(4);
    expect(completed).toMatchObject({
      passed: true,
      launchGateEligible: false,
      recipientIdentityRetained: false
    });
  });

  it("does not regress a terminal webhook state when sent arrives late", async () => {
    const database = scenarioDatabase({
      delivered: {
        id: "lab_launch_lab_run_0002_resend_delivered",
        scenario: "delivered",
        expected_status: "delivered",
        state: "passed",
        observed_status: "delivered",
        provider_id: "email_terminal",
        failure_code: null
      }
    });
    expect(await recordLaunchLabResendWebhook(database.db, {
      scenarioId: "lab_launch_lab_run_0002_resend_delivered",
      providerId: "email_terminal",
      status: "accepted"
    })).toBe(true);
    expect(database.rows.get("delivered")?.state).toBe("passed");
    expect(database.rows.get("delivered")?.observed_status).toBe("delivered");
  });
});

type Scenario = {
  id: string;
  scenario: "delivered" | "bounced" | "complained" | "suppressed";
  expected_status: string;
  state: string;
  observed_status: string | null;
  provider_id: string | null;
  failure_code: string | null;
};

function scenarioDatabase(
  initial: Partial<Record<Scenario["scenario"], Scenario>> = {}
): {
  db: D1Database;
  rows: Map<Scenario["scenario"], Scenario>;
} {
  const rows = new Map(Object.entries(initial) as Array<
    [Scenario["scenario"], Scenario]
  >);
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async all() {
          if (query.includes("FROM launch_lab_provider_scenarios")) {
            return { results: [...rows.values()] };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("INSERT OR IGNORE")) {
            const scenario = String(values[2]) as Scenario["scenario"];
            if (!rows.has(scenario)) {
              rows.set(scenario, {
                id: String(values[0]),
                scenario,
                expected_status: String(values[3]),
                state: "pending",
                observed_status: null,
                provider_id: null,
                failure_code: null
              });
            }
          } else if (query.includes("UPDATE launch_lab_provider_scenarios")) {
            const id = String(values[5]);
            const row = [...rows.values()].find((value) => value.id === id);
            if (row) {
              if (row.state === "pending") {
                row.state = String(values[0]);
                row.observed_status = String(values[1]);
              }
              row.provider_id ??= values[2] ? String(values[2]) : null;
              row.failure_code ??= values[3] ? String(values[3]) : null;
            }
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          if (!query.includes("RETURNING id")) return null;
          const status = String(values[2]);
          const id = String(values[5]);
          const providerId = String(values[6]);
          const row = [...rows.values()].find((value) => value.id === id);
          if (!row || (row.provider_id && row.provider_id !== providerId)) {
            return null;
          }
          if (!["passed", "failed"].includes(row.state)) {
            row.observed_status = status;
            row.state = status === row.expected_status
              ? "passed"
              : ["delivered", "suppressed", "failed"].includes(status)
              ? "failed"
              : "running";
          }
          row.provider_id ??= providerId || null;
          return {
            id,
            run_id: id.split("_").slice(1, -2).join("_")
          };
        }
      };
    }
  } as unknown as D1Database;
  return { db, rows };
}
