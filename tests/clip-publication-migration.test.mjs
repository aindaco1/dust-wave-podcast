import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("public clip publication migration", () => {
  it("replays from zero with immutable evidence and public lookup indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const columns = db.prepare(
        "PRAGMA table_info(clip_publications)"
      ).all().map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "show_id",
        "episode_id",
        "clip_id",
        "clip_revision",
        "render_id",
        "public_slug",
        "status",
        "output_object_key",
        "output_object_bytes",
        "output_object_etag",
        "output_sha256",
        "processor_manifest_sha256",
        "approved_at",
        "withdrawn_at"
      ]));

      const indexes = db.prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'clip_publications'`
      ).all().map(({ name }) => String(name));
      expect(indexes).toContain("clip_publications_public_lookup");

      const tableSql = String(db.prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'clip_publications'`
      ).get().sql);
      expect(tableSql).toContain(
        "status IN ('draft', 'approved', 'withdrawn')"
      );
      expect(tableSql).toContain(
        "UNIQUE (show_id, episode_id, public_slug)"
      );
      expect(tableSql).toContain("output_mime_type = 'video/mp4'");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
