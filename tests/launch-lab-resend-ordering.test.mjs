import { afterEach, describe, expect, it } from "vitest";

import { recordLaunchLabResendWebhook } from "../src/launch-lab-resend";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const runId = "launch_resend_order_0001";
const scenarioId = `lab_${runId}_resend_complained`;
const providerId = "email_resend_ordering_fixture";

describe("Launch Lab Resend event ordering contract", () => {
  let sqlite;

  afterEach(() => sqlite?.close());

  it("keeps delivery intermediate and recovers an older false terminal mismatch", async () => {
    sqlite = migratedSqlite();
    const db = sqliteD1(sqlite);
    sqlite.prepare(
      `INSERT INTO shows (
         id, slug, title, canonical_url, rss_slug, test_fixture
       ) VALUES (?, ?, ?, ?, ?, 1)`
    ).run(
      "show_resend_ordering",
      "resend-ordering",
      "Resend ordering",
      "https://staging.example/podcasts/resend-ordering/",
      "resend-ordering"
    );
    sqlite.prepare(
      `INSERT INTO launch_lab_runs (
         id, show_id, source_commit
       ) VALUES (?, ?, ?)`
    ).run(runId, "show_resend_ordering", "a".repeat(40));
    sqlite.prepare(
      `INSERT INTO launch_lab_provider_scenarios (
         id, run_id, provider, scenario, expected_status,
         state, observed_status, provider_id, attempt_count
       ) VALUES (?, ?, 'resend', 'complained', 'suppressed',
         'running', 'accepted', ?, 1)`
    ).run(scenarioId, runId, providerId);

    expect(await recordLaunchLabResendWebhook(db, {
      scenarioId,
      providerId,
      status: "delivered"
    })).toBe(true);
    expect(scenario(sqlite)).toMatchObject({
      state: "running",
      observed_status: "delivered",
      completed_at: null
    });

    sqlite.prepare(
      `UPDATE launch_lab_provider_scenarios
       SET state = 'failed', completed_at = datetime('now')
       WHERE id = ?`
    ).run(scenarioId);
    expect(await recordLaunchLabResendWebhook(db, {
      scenarioId,
      providerId,
      status: "suppressed"
    })).toBe(true);
    expect(scenario(sqlite)).toMatchObject({
      state: "passed",
      observed_status: "suppressed"
    });
    expect(sqlite.prepare(
      "SELECT status FROM launch_lab_runs WHERE id = ?"
    ).get(runId)).toEqual({ status: "passed" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

function scenario(sqlite) {
  return sqlite.prepare(
    `SELECT state, observed_status, completed_at
     FROM launch_lab_provider_scenarios
     WHERE id = ?`
  ).get(scenarioId);
}
