import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ensureLaunchLabRun,
  presentLaunchLabRun,
  recordLaunchLabObservations,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";

const migrationPath = fileURLToPath(new URL(
  "../migrations/0080_launch_lab_fixture_boundary.sql",
  import.meta.url
));

describe("Launch Lab provider ledger", () => {
  it("seeds one immutable contract and records content-free recovery evidence", async () => {
    const fixture = ledgerFixture();
    try {
      expect(await ensureLaunchLabRun(fixture.db, {
        runId: "launch_lab_run_ledger_0001",
        showId: "show_lab",
        sourceCommit: "a".repeat(40)
      })).toBe(true);
      await seedLaunchLabScenarios(fixture.db, "launch_lab_run_ledger_0001");
      await seedLaunchLabScenarios(fixture.db, "launch_lab_run_ledger_0001");
      expect(fixture.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM launch_lab_provider_scenarios"
      ).get()).toEqual({ count: 41 });

      await recordLaunchLabObservations(
        fixture.db,
        "launch_lab_run_ledger_0001",
        [{
          provider: "ads",
          scenario: "targeting_matrix",
          observedStatus: "mismatch",
          failureCode: "targeting_contract_failed"
        }]
      );
      expect((await presentLaunchLabRun(
        fixture.db,
        "launch_lab_run_ledger_0001"
      ))?.status).toBe("failed");

      await recordLaunchLabObservations(
        fixture.db,
        "launch_lab_run_ledger_0001",
        [{
          provider: "ads",
          scenario: "targeting_matrix",
          observedStatus: "verified"
        }]
      );
      const run = await presentLaunchLabRun(
        fixture.db,
        "launch_lab_run_ledger_0001"
      );
      expect(run).toMatchObject({
        status: "running",
        passed: false,
        launchGateEligible: false
      });
      expect(run?.scenarios.find(({ provider, scenario }) =>
        provider === "ads" && scenario === "targeting_matrix"
      )).toMatchObject({
        expectedStatus: "verified",
        observedStatus: "verified",
        state: "passed",
        failureCode: null
      });

      await expect(recordLaunchLabObservations(
        fixture.db,
        "launch_lab_run_ledger_0001",
        [{
          provider: "ads",
          scenario: "invented_scenario",
          observedStatus: "verified"
        }]
      )).rejects.toThrow(/not allowlisted/);
      expect(await ensureLaunchLabRun(fixture.db, {
        runId: "launch_lab_run_ledger_0001",
        showId: "show_lab",
        sourceCommit: "b".repeat(40)
      })).toBe(false);
    } finally {
      fixture.sqlite.close();
    }
  });
});

function ledgerFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE shows (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    title TEXT NOT NULL
  );`);
  sqlite.exec(readFileSync(migrationPath, "utf8"));
  sqlite.prepare(
    "INSERT INTO shows (id, status, title, test_fixture) VALUES (?, ?, ?, 1)"
  ).run("show_lab", "coming_soon", "Launch Lab");
  const db = {
    prepare(query) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) }
          };
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(query).all(...values) };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return { sqlite, db };
}
