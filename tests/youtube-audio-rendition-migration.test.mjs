import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("YouTube audio rendition migration", () => {
  it("replays from zero with immutable multipart and output evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const episodeColumns = db.prepare("PRAGMA table_info(episodes)")
        .all()
        .map(({ name }) => name);
      expect(episodeColumns).toContain("youtube_rendition_upload_id");

      const renditionColumns = db.prepare(
        "PRAGMA table_info(episode_youtube_audio_renditions)"
      ).all().map(({ name }) => name);
      expect(renditionColumns).toEqual(expect.arrayContaining([
        "working_master_id",
        "source_sha256",
        "artwork_sha256",
        "r2_upload_id",
        "processor_manifest_sha256",
        "output_upload_id",
        "output_sha256",
        "processor_report_json"
      ]));

      const partColumns = db.prepare(
        "PRAGMA table_info(episode_youtube_audio_rendition_parts)"
      ).all().map(({ name }) => name);
      expect(partColumns).toEqual(expect.arrayContaining([
        "part_number",
        "etag",
        "uploaded_bytes",
        "sha256"
      ]));

      const triggers = db.prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name LIKE 'episode_youtube_rendition_%'
         ORDER BY name`
      ).all().map(({ name }) => name);
      expect(triggers).toEqual([
        "episode_youtube_rendition_artwork_stale",
        "episode_youtube_rendition_audio_stale",
        "episode_youtube_rendition_master_stale",
        "episode_youtube_rendition_selected"
      ]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
