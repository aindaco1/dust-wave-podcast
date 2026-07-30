import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const authorMigration = "0065_opera_author_identity.sql";
const showId = "show_opera_en_la_selva";

describe("Ópera en la Selva author identity migration", () => {
  it("replaces only the legacy network fallback", () => {
    const legacy = databaseBeforeAuthorMigration();
    const customized = databaseBeforeAuthorMigration();
    try {
      expect(readAuthor(legacy)).toBe("Dust Wave");
      customized.prepare(
        "UPDATE shows SET author_name = ? WHERE id = ?"
      ).run("Custom Host", showId);

      applyAuthorMigration(legacy);
      applyAuthorMigration(customized);

      expect(readAuthor(legacy)).toBe("Jay Renteria");
      expect(readAuthor(customized)).toBe("Custom Host");
      expect(legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(legacy.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      legacy.close();
      customized.close();
    }
  });
});

function databaseBeforeAuthorMigration() {
  const database = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) =>
      candidate.endsWith(".sql") && candidate < authorMigration
    )
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
  return database;
}

function applyAuthorMigration(database) {
  database.exec(
    readFileSync(join(migrationsDirectory, authorMigration), "utf8")
  );
}

function readAuthor(database) {
  return database.prepare(
    "SELECT author_name FROM shows WHERE id = ?"
  ).get(showId).author_name;
}
