import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("episode YouTube publication migration", () => {
  it("replays from zero with immutable evidence and quarantine constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const columns = db.prepare(
        "PRAGMA table_info(episode_youtube_publications)"
      ).all().map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "publication_revision",
        "distribution_job_id",
        "video_upload_id",
        "video_object_key",
        "video_object_bytes",
        "video_object_etag",
        "channel_id",
        "privacy_status",
        "provider_video_id",
        "failure_code"
      ]));
      const tableSql = db.prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'episode_youtube_publications'`
      ).get().sql;
      expect(tableSql).toContain("'reconciliation_required'");
      expect(tableSql).toContain("video_content_type = 'video/mp4'");
      expect(tableSql).toContain("UNIQUE (episode_id, publication_revision)");
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
