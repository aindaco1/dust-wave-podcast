import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const registryMigration = "0077_directory_provider_registry.sql";
const showId = "show_opera_en_la_selva";

describe("directory provider registry migration", () => {
  it("refreshes first-party URLs and marks untouched Overcast setup unnecessary", () => {
    const database = databaseBeforeRegistryMigration();
    try {
      applyRegistryMigration(database);

      expect(readDestination(database, "castbox")).toMatchObject({
        owner_setup_status: "not_started",
        submission_url: "https://castbox.fm/podcasters.html"
      });
      expect(readDestination(database, "overcast")).toMatchObject({
        owner_setup_status: "not_required",
        submission_url: "https://overcast.fm/podcasterinfo"
      });
      expect(readShowOwnerSetup(database, "overcast")).toBe("not_required");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      database.close();
    }
  });

  it("preserves operator-authored show setup evidence", () => {
    const database = databaseBeforeRegistryMigration();
    try {
      database.prepare(
        `UPDATE show_distribution_destinations
         SET owner_setup_status = 'verified',
             owner_verified_at = '2026-08-01T12:00:00.000Z',
             owner_account_label = 'Dust Wave owner'
         WHERE show_id = ? AND destination_id = 'overcast'`
      ).run(showId);

      applyRegistryMigration(database);

      expect(database.prepare(
        `SELECT owner_setup_status, owner_verified_at,
                owner_account_label
         FROM show_distribution_destinations
         WHERE show_id = ? AND destination_id = 'overcast'`
      ).get(showId)).toEqual({
        owner_setup_status: "verified",
        owner_verified_at: "2026-08-01T12:00:00.000Z",
        owner_account_label: "Dust Wave owner"
      });
      const migration = readFileSync(
        join(migrationsDirectory, registryMigration),
        "utf8"
      );
      expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    } finally {
      database.close();
    }
  });
});

function databaseBeforeRegistryMigration() {
  const database = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) =>
      candidate.endsWith(".sql") && candidate < registryMigration
    )
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
  return database;
}

function applyRegistryMigration(database) {
  database.exec(
    readFileSync(join(migrationsDirectory, registryMigration), "utf8")
  );
}

function readDestination(database, destinationId) {
  return database.prepare(
    `SELECT owner_setup_status, submission_url
     FROM distribution_destinations
     WHERE id = ?`
  ).get(destinationId);
}

function readShowOwnerSetup(database, destinationId) {
  return database.prepare(
    `SELECT owner_setup_status
     FROM show_distribution_destinations
     WHERE show_id = ? AND destination_id = ?`
  ).get(showId, destinationId).owner_setup_status;
}
