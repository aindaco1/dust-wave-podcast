import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("virtual-audio diagnostic lease migration", () => {
  it("replays from zero with bounded hashes and one-time exchange", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const leaseId = "lease_fixture_0001";
      const tokenHash = "a".repeat(64);
      db.prepare(`
        INSERT INTO virtual_audio_diagnostic_leases (
          id, token_hash, expires_at
        ) VALUES (?, ?, '2099-01-01 00:00:00')
      `).run(leaseId, tokenHash);

      const exchange = db.prepare(`
        UPDATE virtual_audio_diagnostic_leases
        SET exchanged_at = datetime('now')
        WHERE
          id = ?
          AND token_hash = ?
          AND exchanged_at IS NULL
          AND expires_at > datetime('now')
      `);
      expect(exchange.run(leaseId, tokenHash).changes).toBe(1);
      expect(exchange.run(leaseId, tokenHash).changes).toBe(0);

      expect(() => db.prepare(`
        INSERT INTO virtual_audio_diagnostic_leases (
          id, token_hash, expires_at
        ) VALUES (?, ?, '2099-01-01 00:00:00')
      `).run("lease_fixture_0002", "G".repeat(64)))
        .toThrow(/CHECK constraint failed/);

      const cleanupPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        DELETE FROM virtual_audio_diagnostic_leases
        WHERE expires_at <= datetime('now')
      `).all()
        .map((step) => String(step.detail))
        .join("\n");
      expect(cleanupPlan).toContain(
        "idx_virtual_audio_diagnostic_leases_expiry"
      );
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
