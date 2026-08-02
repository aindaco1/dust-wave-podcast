import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const entryPointMigration = "0078_directory_submission_entry_points.sql";
const expectedEntryPoints = Object.freeze({
  amazon_music: "https://podcasters.amazon.com/submit-rss",
  castbox: "https://castbox.fm/podcasters-tools/",
  iheartradio: "https://podcasters.iheart.com/add-podcast/",
  player_fm: "https://player.fm/add",
  spotify: "https://creators.spotify.com/"
});

describe("directory submission entry-point migration", () => {
  it("refreshes exact first-party actions without changing show evidence", () => {
    const database = databaseBeforeEntryPointMigration();
    try {
      const setupBefore = readShowSetup(database);
      applyEntryPointMigration(database);

      expect(Object.fromEntries(database.prepare(
        `SELECT id, submission_url
         FROM distribution_destinations
         WHERE id IN ('amazon_music', 'castbox', 'iheartradio', 'player_fm', 'spotify')
         ORDER BY id`
      ).all().map((row) => [row.id, row.submission_url]))).toEqual(
        expectedEntryPoints
      );
      expect(readShowSetup(database)).toEqual(setupBefore);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
      const migration = readFileSync(
        join(migrationsDirectory, entryPointMigration),
        "utf8"
      );
      expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    } finally {
      database.close();
    }
  });
});

function databaseBeforeEntryPointMigration() {
  const database = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) =>
      candidate.endsWith(".sql") && candidate < entryPointMigration
    )
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
  return database;
}

function applyEntryPointMigration(database) {
  database.exec(
    readFileSync(join(migrationsDirectory, entryPointMigration), "utf8")
  );
}

function readShowSetup(database) {
  return database.prepare(
    `SELECT show_id, destination_id, enabled, owner_setup_status,
            listing_url, owner_verified_at, last_checked_at, last_error,
            owner_account_label, submission_date, submission_evidence_url,
            setup_notes
     FROM show_distribution_destinations
     ORDER BY show_id, destination_id`
  ).all();
}
