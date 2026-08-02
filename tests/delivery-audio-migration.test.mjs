import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { AUTOMATED_DELIVERY_AUDIO_CANDIDATES_SQL } from
  "../src/delivery-audio";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("delivery-audio migration", () => {
  it("replays from zero with master, multipart, peaks, and approval evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const jobColumns = db.prepare(
        "PRAGMA table_info(delivery_audio_jobs)"
      ).all().map(({ name }) => name);
      expect(jobColumns).toEqual(expect.arrayContaining([
        "source_master_id",
        "stream_profile",
        "r2_upload_id",
        "peaks_object_key",
        "output_sha256",
        "peaks_sha256",
        "processor_manifest_sha256",
        "processor_report_sha256",
        "approval_reason"
      ]));

      const partColumns = db.prepare(
        "PRAGMA table_info(delivery_audio_job_parts)"
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
           AND name LIKE 'delivery_audio_%'
         ORDER BY name`
      ).all().map(({ name }) => name);
      expect(triggers).toEqual([
        "delivery_audio_job_approval_evidence",
        "delivery_audio_job_ready_evidence",
        "delivery_audio_job_source_insert",
        "delivery_audio_jobs_episode_audio_stale",
        "delivery_audio_jobs_working_master_stale",
        "delivery_audio_manual_upload_guard"
      ]);
      expect(() => db.prepare(
        AUTOMATED_DELIVERY_AUDIO_CANDIDATES_SQL
      ).all(3, 10)).not.toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
