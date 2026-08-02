import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLaunchLabRun,
  presentLaunchLabRun,
  seedLaunchLabScenarios
} from "../src/launch-lab-ledger";
import { reconcileLaunchLabYouTubeChannelIdentity } from
  "../src/launch-lab-youtube";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const channelId = "channel_fixture";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Launch Lab YouTube channel health reconciliation", () => {
  it("records fresh exact durable evidence idempotently without provider I/O", async () => {
    const fixture = await youtubeHealthFixture("launch_youtube_health_0001");
    try {
      fixture.insertReadyHealth();
      const providerCall = vi.fn(() => {
        throw new Error("provider I/O is forbidden during reconciliation");
      });
      vi.stubGlobal("fetch", providerCall);

      await expect(reconcileLaunchLabYouTubeChannelIdentity(
        fixture.env,
        fixture.runId
      )).resolves.toBe(true);
      await expect(reconcileLaunchLabYouTubeChannelIdentity(
        fixture.env,
        fixture.runId
      )).resolves.toBe(true);

      const run = await presentLaunchLabRun(fixture.env.DB, fixture.runId);
      expect(run?.scenarios.find(({ provider, scenario }) =>
        provider === "youtube" && scenario === "channel_identity"
      )).toMatchObject({
        expectedStatus: "verified",
        observedStatus: "verified",
        state: "passed",
        failureCode: null
      });
      expect(JSON.stringify(run)).not.toContain(channelId);
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      fixture.sqlite.close();
    }
  });

  it.each([
    ["missing", "missing"],
    ["stale", "stale"],
    ["mismatched", "mismatched"],
    ["actively refreshing", "leased"],
    ["failed", "failed"]
  ])("keeps %s provider evidence pending", async (_label, state) => {
    const runId = `launch_youtube_${state}_0001`;
    const fixture = await youtubeHealthFixture(runId);
    try {
      if (state !== "missing") fixture.insertReadyHealth();
      if (state === "stale") {
        fixture.sqlite.exec(
          "UPDATE provider_access_health "
          + "SET last_success_at = datetime('now', '-25 hours')"
        );
      } else if (state === "mismatched") {
        fixture.sqlite.exec(
          "UPDATE provider_access_health "
          + "SET account_reference = 'another_channel'"
        );
      } else if (state === "leased") {
        fixture.sqlite.exec(
          "UPDATE provider_access_health SET lease_token = '"
          + "a".repeat(32)
          + "', lease_expires_at = datetime('now', '+2 minutes')"
        );
      } else if (state === "failed") {
        fixture.sqlite.exec(
          "UPDATE provider_access_health SET status = 'failed', "
          + "failure_code = 'youtube_oauth_failed', "
          + "consecutive_failures = 1"
        );
      }

      await expect(reconcileLaunchLabYouTubeChannelIdentity(
        fixture.env,
        fixture.runId
      )).resolves.toBe(false);
      const run = await presentLaunchLabRun(fixture.env.DB, fixture.runId);
      expect(run?.scenarios.find(({ provider, scenario }) =>
        provider === "youtube" && scenario === "channel_identity"
      )).toMatchObject({
        state: "pending",
        observedStatus: null,
        failureCode: null
      });
    } finally {
      fixture.sqlite.close();
    }
  });

  it("rejects an invalid configured identity before reading D1", async () => {
    const env = {
      YOUTUBE_CHANNEL_ID: "bad channel",
      DB: {
        prepare() {
          throw new Error("D1 must not be read");
        }
      }
    };
    await expect(reconcileLaunchLabYouTubeChannelIdentity(
      env,
      "launch_youtube_invalid_0001"
    )).resolves.toBe(false);
  });
});

async function youtubeHealthFixture(runId) {
  const sqlite = migratedSqlite();
  const db = sqliteD1(sqlite);
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, test_fixture
     ) VALUES (?, ?, ?, ?, ?, 1)`
  ).run(
    "show_youtube_health",
    "youtube-health",
    "YouTube health",
    "https://staging.example/podcasts/youtube-health/",
    "youtube-health"
  );
  expect(await ensureLaunchLabRun(db, {
    runId,
    showId: "show_youtube_health",
    sourceCommit: "a".repeat(40)
  })).toBe(true);
  await seedLaunchLabScenarios(db, runId);
  return {
    sqlite,
    runId,
    env: { DB: db, YOUTUBE_CHANNEL_ID: channelId },
    insertReadyHealth() {
      sqlite.prepare(
        `INSERT INTO provider_access_health (
           provider, account_reference, status, checked_at,
           last_success_at, next_check_at, consecutive_failures
         ) VALUES (
           'youtube', ?, 'ready', datetime('now'), datetime('now'),
           datetime('now', '+12 hours'), 0
         )`
      ).run(channelId);
    }
  };
}
