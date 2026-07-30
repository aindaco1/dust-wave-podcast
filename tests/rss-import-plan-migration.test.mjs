import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("RSS import plan migration", () => {
  it("replays from zero with immutable evidence and bounded selections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const planColumns = db.prepare(
        "PRAGMA table_info(rss_import_plans)"
      ).all().map(({ name }) => name);
      expect(planColumns).toEqual(expect.arrayContaining([
        "requested_feed_url_sha256",
        "requested_feed_display_url",
        "resolved_feed_url_sha256",
        "resolved_feed_display_url",
        "feed_sha256",
        "selection_sha256",
        "selected_item_count",
        "status",
        "cancellation_reason_sha256"
      ]));
      const itemColumns = db.prepare(
        "PRAGMA table_info(rss_import_plan_items)"
      ).all().map(({ name }) => name);
      expect(itemColumns).toEqual(expect.arrayContaining([
        "source_identity_sha256",
        "metadata_sha256",
        "enclosure_url_sha256",
        "enclosure_display_url"
      ]));

      const triggers = db.prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND tbl_name IN ('rss_import_plans', 'rss_import_plan_items')`
      ).all().map(({ name }) => String(name));
      expect(triggers).toEqual(expect.arrayContaining([
        "rss_import_plan_items_immutable_update",
        "rss_import_plan_items_immutable_delete",
        "rss_import_plans_evidence_immutable",
        "rss_import_plans_immutable_delete"
      ]));
      const migration = readFileSync(
        join(migrationsDirectory, "0055_rss_import_plans.sql"),
        "utf8"
      );
      expect(migration).toContain("selected_item_count BETWEEN 1 AND 25");
      expect(migration).toContain("instr(requested_feed_display_url, '?') = 0");
      expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
