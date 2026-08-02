import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL(
  "../migrations/0080_launch_lab_fixture_boundary.sql",
  import.meta.url
));

describe("Launch Lab fixture boundary migration", () => {
  it("defaults existing shows to launch-eligible and indexes public filtering", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE shows (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        title TEXT NOT NULL
      );`);
      db.prepare(
        "INSERT INTO shows (id, status, title) VALUES (?, ?, ?)"
      ).run("show_real", "active", "Real show");
      db.exec(readFileSync(migrationPath, "utf8"));

      expect(db.prepare(
        "SELECT test_fixture FROM shows WHERE id = 'show_real'"
      ).get()).toEqual({ test_fixture: 0 });
      db.prepare(
        "INSERT INTO shows (id, status, title, test_fixture) VALUES (?, ?, ?, ?)"
      ).run("show_lab", "coming_soon", "Lab", 1);
      expect(() => db.prepare(
        "UPDATE shows SET test_fixture = 0 WHERE id = 'show_lab'"
      ).run()).toThrow(/shows\.test_fixture is immutable/);
      expect(() => db.prepare(
        "INSERT INTO shows (id, status, title, test_fixture) VALUES (?, ?, ?, ?)"
      ).run("show_invalid", "coming_soon", "Invalid", 2)).toThrow(
        /CHECK constraint failed/
      );

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM shows
         WHERE test_fixture = 0 AND status != 'archived'
         ORDER BY title`
      ).all().map((row) => String(row.detail)).join("\n");
      expect(plan).toContain("shows_public_catalog");
    } finally {
      db.close();
    }
  });
});
