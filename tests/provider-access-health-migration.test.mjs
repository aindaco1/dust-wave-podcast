import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL(
  "../migrations/0079_provider_access_health.sql",
  import.meta.url
));

describe("provider access health migration", () => {
  it("keeps evidence content-free, leased, and cadence-indexed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync(migrationPath, "utf8"));
      db.prepare(
        `INSERT INTO provider_access_health (
           provider, account_reference, status, checked_at,
           last_success_at, next_check_at
         ) VALUES (
           'youtube', 'channel_fixture', 'ready', datetime('now'),
           datetime('now'), datetime('now', '+12 hours')
         )`
      ).run();
      expect(db.prepare(
        `SELECT provider, status, failure_code, consecutive_failures
         FROM provider_access_health`
      ).get()).toEqual({
        provider: "youtube",
        status: "ready",
        failure_code: null,
        consecutive_failures: 0
      });
      expect(() => db.prepare(
        `UPDATE provider_access_health
         SET lease_token = ?, lease_expires_at = NULL
         WHERE provider = 'youtube'`
      ).run("a".repeat(32))).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(
        `UPDATE provider_access_health
         SET status = 'failed', failure_code = 'oauth_failed',
             consecutive_failures = 0
         WHERE provider = 'youtube'`
      ).run()).toThrow(/CHECK constraint failed/);

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT provider FROM provider_access_health
         WHERE next_check_at <= datetime('now')
         ORDER BY next_check_at`
      ).all().map((row) => String(row.detail)).join("\n");
      expect(plan).toContain("idx_provider_access_health_due");
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
