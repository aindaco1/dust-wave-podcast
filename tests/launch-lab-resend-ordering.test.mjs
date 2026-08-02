import { afterEach, describe, expect, it } from "vitest";

import {
  recordLaunchLabResendWebhook,
  runLaunchLabResendMatrix
} from "../src/launch-lab-resend";
import {
  ensureLaunchLabRun,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";
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

  it("recovers an untagged suppression from the signed content-free journal", async () => {
    const fixture = await resendJournalFixture("launch_resend_journal_0001");
    sqlite = fixture.sqlite;
    fixture.sqlite.prepare(
      `INSERT INTO podcast_resend_webhook_events (
         id, event_type, provider_id
       ) VALUES (?, 'email.suppressed', ?),
                (?, 'email.delivered', ?)`
    ).run(
      "webhook_suppressed_fixture",
      fixture.providerId,
      "webhook_late_delivery_fixture",
      fixture.providerId
    );
    const providerCall = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("provider I/O must not run after journal recovery");
    };
    try {
      const result = await runLaunchLabResendMatrix(
        fixture.env,
        fixture.runId
      );
      expect(scenario(fixture.sqlite, fixture.scenarioId)).toMatchObject({
        state: "passed",
        observed_status: "suppressed"
      });
      expect(result).toMatchObject({
        passed: true,
        launchGateEligible: false,
        recipientIdentityRetained: false
      });
      expect(JSON.stringify(result)).not.toContain(fixture.providerId);
      await expect(runLaunchLabResendMatrix(
        fixture.env,
        fixture.runId
      )).resolves.toMatchObject({ passed: true });
      expect(fixture.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM podcast_resend_webhook_events"
      ).get()).toEqual({ count: 2 });
      const queryPlan = fixture.sqlite.prepare(
        `EXPLAIN QUERY PLAN
         SELECT event_type
         FROM podcast_resend_webhook_events
         WHERE provider_id = ?`
      ).all(fixture.providerId).map(({ detail }) => String(detail)).join(" ");
      expect(queryPlan).toContain(
        "podcast_resend_webhook_events_provider_status"
      );
      expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all())
        .toEqual([]);
    } finally {
      globalThis.fetch = providerCall;
    }
  });

  it("rejects another provider object and an untyped bounce", async () => {
    const fixture = await resendJournalFixture("launch_resend_journal_0002");
    sqlite = fixture.sqlite;
    fixture.sqlite.prepare(
      `INSERT INTO podcast_resend_webhook_events (
         id, event_type, provider_id
       ) VALUES (?, 'email.suppressed', ?),
                (?, 'email.bounced', ?)`
    ).run(
      "webhook_other_provider",
      "email_another_provider",
      "webhook_untyped_bounce",
      fixture.providerId
    );
    const providerCall = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: String(init?.method) });
      return new Response(JSON.stringify({
        id: fixture.providerId,
        last_event: "sent"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    try {
      const result = await runLaunchLabResendMatrix(
        fixture.env,
        fixture.runId
      );
      expect(requests).toEqual([{
        url: `https://api.resend.com/emails/${fixture.providerId}`,
        method: "GET"
      }]);
      expect(scenario(fixture.sqlite, fixture.scenarioId)).toMatchObject({
        state: "running",
        observed_status: "accepted"
      });
      expect(result).toMatchObject({ passed: false });
    } finally {
      globalThis.fetch = providerCall;
    }
  });
});

function scenario(sqlite, id = scenarioId) {
  return sqlite.prepare(
    `SELECT state, observed_status, completed_at
     FROM launch_lab_provider_scenarios
     WHERE id = ?`
  ).get(id);
}

async function resendJournalFixture(runIdValue) {
  const database = migratedSqlite();
  const db = sqliteD1(database);
  database.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, test_fixture
     ) VALUES (?, ?, ?, ?, ?, 1)`
  ).run(
    `show_${runIdValue}`,
    runIdValue,
    "Resend journal",
    `https://staging.example/podcasts/${runIdValue}/`,
    runIdValue
  );
  expect(await ensureLaunchLabRun(db, {
    runId: runIdValue,
    showId: `show_${runIdValue}`,
    sourceCommit: "a".repeat(40)
  })).toBe(true);
  await seedLaunchLabScenarios(db, runIdValue);
  database.prepare(
    `UPDATE launch_lab_provider_scenarios
     SET
       state = 'passed',
       observed_status = expected_status,
       provider_id = 'email_' || scenario || '_fixture',
       completed_at = datetime('now')
     WHERE run_id = ? AND provider = 'resend'`
  ).run(runIdValue);
  const suppressedScenarioId = `lab_${runIdValue}_resend_suppressed`;
  const suppressedProviderId = `email_${runIdValue}_suppressed`;
  database.prepare(
    `UPDATE launch_lab_provider_scenarios
     SET state = 'running', observed_status = 'accepted',
       provider_id = ?, completed_at = NULL, attempt_count = 1
     WHERE id = ?`
  ).run(suppressedProviderId, suppressedScenarioId);
  return {
    sqlite: database,
    runId: runIdValue,
    scenarioId: suppressedScenarioId,
    providerId: suppressedProviderId,
    env: {
      DB: db,
      RESEND_API_KEY: "re_test_fixture",
      PODCAST_EMAIL_FROM: "Dust Wave Podcasts <podcasts@dustwave.xyz>"
    }
  };
}
