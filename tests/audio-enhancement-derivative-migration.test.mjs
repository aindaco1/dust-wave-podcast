import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("audio enhancement derivative migration", () => {
  it("replays from zero with immutable selection, multipart, QC, and approval evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const derivativeColumns = db.prepare(
        "PRAGMA table_info(audio_enhancement_derivatives)"
      ).all().map(({ name }) => name);
      expect(derivativeColumns).toEqual(expect.arrayContaining([
        "selected_preview_id",
        "source_master_id",
        "selected_preview_enhanced_sha256",
        "r2_upload_id",
        "output_upload_id",
        "derivative_quality_control_run_id",
        "processor_manifest_sha256",
        "processor_report_sha256",
        "approval_reason"
      ]));

      const partColumns = db.prepare(
        "PRAGMA table_info(audio_enhancement_derivative_parts)"
      ).all().map(({ name }) => name);
      expect(partColumns).toEqual(expect.arrayContaining([
        "part_number",
        "etag",
        "uploaded_bytes",
        "sha256"
      ]));

      const triggers = db.prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name LIKE 'audio_enhancement_derivative_%'
         ORDER BY name`
      ).all().map(({ name }) => name);
      expect(triggers).toEqual([
        "audio_enhancement_derivative_approval",
        "audio_enhancement_derivative_master_stale",
        "audio_enhancement_derivative_qc_failed",
        "audio_enhancement_derivative_qc_update",
        "audio_enhancement_derivative_source_insert"
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
