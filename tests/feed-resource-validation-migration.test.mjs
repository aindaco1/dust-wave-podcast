import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("feed resource validation migration", () => {
  it("moves the launch show to directory-sized art and expires older evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const filenames = readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort();
      for (const filename of filenames.filter((name) => name < "0076_")) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.prepare(
        `INSERT INTO show_feed_validations (
           show_id, status, feed_url, validator_version,
           feed_sha256, item_count, checked_at, validated_at
         ) VALUES (?, 'valid', ?, 'dustwave-rss-launch-v3', ?, 0, ?, ?)`
      ).run(
        "show_opera_en_la_selva",
        "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml",
        "f".repeat(64),
        "2026-08-01T12:00:00.000Z",
        "2026-08-01T12:00:00.000Z"
      );

      db.exec(readFileSync(
        join(migrationsDirectory, "0076_feed_resource_validation.sql"),
        "utf8"
      ));

      expect(db.prepare(
        "SELECT artwork_url FROM shows WHERE id = 'show_opera_en_la_selva'"
      ).get()).toEqual({
        artwork_url:
          "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork-feed.jpg"
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM show_feed_validations"
      ).get()).toEqual({ count: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
