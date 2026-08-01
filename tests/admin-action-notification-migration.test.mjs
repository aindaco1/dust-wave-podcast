import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("admin action notification migration", () => {
  it("replays from zero with bounded, content-minimal lifecycle evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const columns = db.prepare(
        "PRAGMA table_info(admin_action_notifications)"
      ).all().map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "episode_id",
        "action_kind",
        "target_id",
        "action_digest",
        "status",
        "attempt_count",
        "lease_expires_at",
        "provider_id",
        "failure_code",
        "sent_at",
        "resolved_at"
      ]));
      expect(columns).not.toEqual(expect.arrayContaining([
        "email",
        "login_token",
        "media_object_key",
        "provider_response"
      ]));
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
