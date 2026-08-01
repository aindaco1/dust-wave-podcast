import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { AUTOMATED_CHAPTER_SOURCES_SQL } from "../src/chapter-drafts";
import { AUTOMATED_CLIP_SOURCES_SQL } from "../src/clip-drafts";
import {
  ADMIN_SHOW_NOTES_DRAFTS_SQL,
  AUTOMATED_SHOW_NOTES_SOURCES_SQL
} from "../src/show-notes";

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
        "source_alignment_revision_id",
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
      expect(() => db.prepare(ADMIN_SHOW_NOTES_DRAFTS_SQL).all(
        "episode_fixture"
      )).not.toThrow();
      expect(() => db.prepare(AUTOMATED_CHAPTER_SOURCES_SQL).all(10))
        .not.toThrow();
      expect(() => db.prepare(AUTOMATED_CLIP_SOURCES_SQL).all(10))
        .not.toThrow();
      const tableSql = db.prepare(
        "SELECT sql FROM sqlite_schema WHERE name = 'editorial_ai_drafts'"
      ).get().sql;
      expect(tableSql).toContain("'show_notes', 'chapters', 'clips'");
      expect(tableSql).toContain(
        "kind NOT IN ('chapters', 'clips')"
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });

  it("preserves existing proposal rows while requiring clip alignment", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE episodes (id TEXT PRIMARY KEY);
        CREATE TABLE episode_working_masters (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE
        );
        CREATE TABLE transcripts (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE
        );
        CREATE TABLE transcript_alignment_revisions (
          id TEXT PRIMARY KEY,
          transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE
        );
      `);
      const chapterMigration = readFileSync(
        join(migrationsDirectory, "0073_chapter_ai_drafts.sql"),
        "utf8"
      );
      const priorTable = chapterMigration.match(
        /CREATE TABLE editorial_ai_drafts \([\s\S]*?\n\);/
      )?.[0];
      expect(priorTable).toBeTruthy();
      db.exec(String(priorTable));
      db.exec(`
        CREATE INDEX editorial_ai_drafts_episode_ready
          ON editorial_ai_drafts(episode_id, kind, status, completed_at DESC);
        CREATE INDEX editorial_ai_drafts_recovery
          ON editorial_ai_drafts(status, lease_expires_at, attempt_count, updated_at);
        INSERT INTO episodes (id) VALUES ('episode_fixture');
        INSERT INTO episode_working_masters (id, episode_id)
          VALUES ('master_fixture', 'episode_fixture');
        INSERT INTO transcripts (id, episode_id)
          VALUES ('transcript_fixture', 'episode_fixture');
        INSERT INTO transcript_alignment_revisions (id, transcript_id)
          VALUES ('alignment_fixture', 'transcript_fixture');
      `);
      const insert = db.prepare(
        `INSERT INTO editorial_ai_drafts (
           id, episode_id, working_master_id, kind, source_transcript_id,
           source_alignment_revision_id, source_language,
           source_transcript_revision, source_transcript_sha256,
           included_cue_count, total_cue_count, transcript_truncated,
           episode_evidence_sha256, output_language, model, prompt_version,
           input_fingerprint, status, attempt_count, failure_code
         ) VALUES (?, ?, ?, ?, ?, ?, 'es', 1, ?, 1, 1, 0, ?, 'es', ?, ?, ?,
           'failed', 1, 'fixture_failure')`
      );
      insert.run(
        "show_notes_fixture",
        "episode_fixture",
        "master_fixture",
        "show_notes",
        "transcript_fixture",
        null,
        "a".repeat(64),
        "b".repeat(64),
        "model_fixture",
        "show-notes-v1",
        "c".repeat(64)
      );
      insert.run(
        "chapters_fixture",
        "episode_fixture",
        "master_fixture",
        "chapters",
        "transcript_fixture",
        "alignment_fixture",
        "d".repeat(64),
        "e".repeat(64),
        "model_fixture",
        "chapter-draft-v1",
        "f".repeat(64)
      );

      db.exec(readFileSync(
        join(migrationsDirectory, "0074_clip_ai_drafts.sql"),
        "utf8"
      ));

      expect(db.prepare(
        `SELECT id, kind, source_alignment_revision_id
         FROM editorial_ai_drafts
         ORDER BY id`
      ).all()).toEqual([
        {
          id: "chapters_fixture",
          kind: "chapters",
          source_alignment_revision_id: "alignment_fixture"
        },
        {
          id: "show_notes_fixture",
          kind: "show_notes",
          source_alignment_revision_id: null
        }
      ]);
      expect(() => insertClipFixture(db, null, "1".repeat(64))).toThrow();
      expect(() => insertClipFixture(
        db,
        "alignment_fixture",
        "2".repeat(64)
      )).not.toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function insertClipFixture(db, alignmentRevisionId, inputFingerprint) {
  db.prepare(
    `INSERT INTO editorial_ai_drafts (
       id, episode_id, working_master_id, kind, source_transcript_id,
       source_alignment_revision_id, source_language,
       source_transcript_revision, source_transcript_sha256,
       included_cue_count, total_cue_count, transcript_truncated,
       episode_evidence_sha256, output_language, model, prompt_version,
       input_fingerprint, status, attempt_count, failure_code
     ) VALUES (?, 'episode_fixture', 'master_fixture', 'clips',
       'transcript_fixture', ?, 'es', 1, ?, 1, 1, 0, ?, 'es',
       'model_fixture', 'clip-draft-v1', ?, 'failed', 1, 'fixture_failure')`
  ).run(
    `clips_fixture_${inputFingerprint[0]}`,
    alignmentRevisionId,
    "3".repeat(64),
    "4".repeat(64),
    inputFingerprint
  );
}
