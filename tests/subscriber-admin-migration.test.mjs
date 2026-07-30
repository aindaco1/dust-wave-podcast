import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("subscriber administration migration", () => {
  it("replays from zero and indexes show-scoped keyset reads", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      const showPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT subscription.id, subscription.updated_at
        FROM subscriptions subscription
        WHERE subscription.show_id = ?
        ORDER BY subscription.updated_at DESC, subscription.id DESC
        LIMIT ?
      `).all("show_opera_en_la_selva", 50)
        .map((step) => String(step.detail))
        .join("\n");
      expect(showPlan).toContain("subscription_admin_show_updated");

      const globalPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT subscription.id, subscription.updated_at
        FROM subscriptions subscription
        ORDER BY subscription.updated_at DESC, subscription.id DESC
        LIMIT ?
      `).all(50)
        .map((step) => String(step.detail))
        .join("\n");
      expect(globalPlan).toContain("subscription_admin_updated");
      const sourcePlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT provider, status
        FROM subscription_entitlement_sources
        WHERE listener_id = ? AND show_id = ?
        ORDER BY provider
      `).all("listener_fixture", "show_opera_en_la_selva")
        .map((step) => String(step.detail))
        .join("\n");
      expect(sourcePlan).toMatch(
        /USING INDEX sqlite_autoindex_subscription_entitlement_sources_/
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
