import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SQL_UTC_NOW_RFC3339 } from "../src/sql-time";
import { validDateTime } from "../src/validation";

const sourceDirectory = fileURLToPath(
  new URL("../src/", import.meta.url)
);

describe("RFC 3339 SQL time boundaries", () => {
  it("uses the same fixed-width UTC representation as validated inputs", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const row = db.prepare(
        `SELECT ${SQL_UTC_NOW_RFC3339} AS current_time`
      ).get();

      expect(row.current_time).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
      );
      expect(
        validDateTime("2026-07-28T15:00:00-06:00", "releaseAt")
      ).toBe("2026-07-28T21:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("selects due same-day ISO timestamps without releasing future rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE release_events (
           id TEXT PRIMARY KEY,
           status TEXT NOT NULL,
           release_at TEXT NOT NULL
         );
         CREATE INDEX release_events_due
           ON release_events(status, release_at);`
      );
      const clock = db.prepare(
        `SELECT ${SQL_UTC_NOW_RFC3339} AS current_time`
      ).get();
      const now = Date.parse(clock.current_time);
      const insert = db.prepare(
        `INSERT INTO release_events (id, status, release_at)
         VALUES (?, 'queued', ?)`
      );
      insert.run("same_day_past", new Date(now - 60_000).toISOString());
      insert.run("same_instant", clock.current_time);
      insert.run("same_day_future", new Date(now + 60_000).toISOString());
      insert.run("malformed", "not-a-timestamp");

      const due = db.prepare(
        `SELECT id
         FROM release_events
         WHERE status = 'queued'
           AND release_at <= ${SQL_UTC_NOW_RFC3339}
         ORDER BY release_at`
      ).all().map(({ id }) => String(id));

      expect(due).toEqual(["same_day_past", "same_instant"]);
    } finally {
      db.close();
    }
  });

  it("keeps the composite due-time index usable", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE release_events (
           id TEXT PRIMARY KEY,
           status TEXT NOT NULL,
           release_at TEXT NOT NULL
         );
         CREATE INDEX release_events_due
           ON release_events(status, release_at);`
      );
      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id
         FROM release_events
         WHERE status = 'queued'
           AND release_at <= ${SQL_UTC_NOW_RFC3339}`
      ).all().map(({ detail }) => String(detail)).join("\n");

      expect(plan).toContain("release_events_due");
      expect(plan).toContain("release_at<?");
    } finally {
      db.close();
    }
  });

  it("prevents raw SQLite clocks on canonical external boundaries", () => {
    const source = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(sourceDirectory, name), "utf8"))
      .join("\n")
      .replace(/\s+/gu, " ");
    const externalBoundary =
      String.raw`(?:public_at|premium_at|current_period_end|effective_at|scheduled_at)`;

    expect(source).not.toMatch(
      new RegExp(
        `${externalBoundary}\\s*(?:<=|>)\\s*datetime\\('now'\\)`,
        "u"
      )
    );
    expect(source).not.toMatch(
      /datetime\((?:public_at|premium_at)\)\s*<=\s*datetime\('now'\)/u
    );
  });
});
