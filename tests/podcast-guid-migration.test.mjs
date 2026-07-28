import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const operaGuid = "d21642df-1816-55c8-b308-6209066e9ef6";
const secondGuid = "917393e3-1b1e-5cef-ace4-edaa54e1f810";

describe("Podcasting 2.0 channel GUID migration", () => {
  it("backfills, validates, uniquely assigns, and then freezes channel identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      expect(
        db.prepare(
          "SELECT podcast_guid FROM shows WHERE id = ?"
        ).get("show_opera_en_la_selva")
      ).toEqual({ podcast_guid: operaGuid });

      insertShow(db, "show_second", "second-show", null);
      db.prepare(
        `INSERT INTO show_feed_validations (
           show_id, status, feed_url, validator_version,
           feed_sha256, item_count, checked_at, validated_at
         ) VALUES (?, 'valid', ?, 'dustwave-rss-launch-v3', ?, 0, ?, ?)`
      ).run(
        "show_second",
        "https://feeds.dustwave.xyz/second-show/rss.xml",
        "f".repeat(64),
        "2026-07-28T12:00:00.000Z",
        "2026-07-28T12:00:00.000Z"
      );
      db.prepare(
        "UPDATE shows SET podcast_guid = ? WHERE id = ?"
      ).run(secondGuid, "show_second");
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM show_feed_validations WHERE show_id = ?"
        ).get("show_second")
      ).toEqual({ count: 0 });

      expect(() =>
        db.prepare(
          "UPDATE shows SET podcast_guid = ? WHERE id = ?"
        ).run(operaGuid, "show_second")
      ).toThrow(/show_podcast_guid_immutable/u);
      expect(() =>
        insertShow(
          db,
          "show_invalid",
          "invalid-show",
          "d21642df-1816-45c8-b308-6209066e9ef6"
        )
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        insertShow(db, "show_duplicate", "duplicate-show", operaGuid)
      ).toThrow(/UNIQUE constraint failed/u);

      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});

function insertShow(db, id, slug, podcastGuid) {
  db.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, podcast_guid
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    slug,
    slug,
    `https://dustwave.xyz/podcasts/${slug}/`,
    slug,
    podcastGuid
  );
}
