import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { AUTOMATED_SHOW_NOTES_SOURCES_SQL } from "../src/show-notes";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("editorial AI draft migration", () => {
  it("replays from zero with private, bounded, retryable proposals", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const columns = db.prepare(
        "PRAGMA table_info(editorial_ai_drafts)"
      ).all().map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "episode_id",
        "working_master_id",
        "source_transcript_id",
        "source_transcript_revision",
        "source_transcript_sha256",
        "included_cue_count",
        "total_cue_count",
        "transcript_truncated",
        "episode_evidence_sha256",
        "output_language",
        "input_fingerprint",
        "status",
        "attempt_count",
        "lease_expires_at",
        "draft_json",
        "draft_sha256"
      ]));
      expect(columns).not.toEqual(expect.arrayContaining([
        "admin_email",
        "provider_response",
        "transcript_text",
        "login_token"
      ]));
      expect(() => db.prepare(AUTOMATED_SHOW_NOTES_SOURCES_SQL).all(10))
        .not.toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
