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
        "approval_reason",
        "rejected_by_admin_user_id",
        "rejection_reason",
        "rejected_at"
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
        "audio_enhancement_derivative_rejection_consistency",
        "audio_enhancement_derivative_rejection_evidence",
        "audio_enhancement_derivative_rejection_immutable",
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

  it("accepts only exact rejection evidence and keeps it immutable", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE admin_users (id TEXT PRIMARY KEY);
        CREATE TABLE episodes (
          id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL
        );
        CREATE TABLE show_audio_qc_policies (
          show_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        CREATE TABLE episode_working_master_states (
          episode_id TEXT PRIMARY KEY,
          current_master_id TEXT
        );
        CREATE TABLE audio_qc_runs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          blocker_count INTEGER,
          policy_revision INTEGER,
          source_sha256 TEXT,
          report_sha256 TEXT
        );
        CREATE TABLE audio_enhancement_derivatives (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          status TEXT NOT NULL,
          source_master_id TEXT NOT NULL,
          derivative_quality_control_run_id TEXT,
          output_sha256 TEXT,
          approved_by_admin_user_id TEXT,
          approval_reason TEXT,
          approved_at TEXT
        );
      `);
      db.exec(readFileSync(
        join(
          migrationsDirectory,
          "0066_audio_enhancement_derivative_rejections.sql"
        ),
        "utf8"
      ));
      db.exec(`
        INSERT INTO admin_users (id) VALUES ('admin_fixture');
        INSERT INTO episodes (id, show_id)
        VALUES ('episode_fixture', 'show_fixture');
        INSERT INTO show_audio_qc_policies (show_id, revision)
        VALUES ('show_fixture', 1);
        INSERT INTO episode_working_master_states (
          episode_id, current_master_id
        ) VALUES ('episode_fixture', 'master_fixture');
        INSERT INTO audio_qc_runs (
          id, status, blocker_count, policy_revision,
          source_sha256, report_sha256
        ) VALUES (
          'qc_fixture', 'succeeded', 0, 1,
          '${"a".repeat(64)}', '${"b".repeat(64)}'
        );
        INSERT INTO audio_enhancement_derivatives (
          id, episode_id, status, source_master_id,
          derivative_quality_control_run_id, output_sha256
        ) VALUES (
          'derivative_fixture', 'episode_fixture', 'ready',
          'master_fixture', 'qc_fixture', '${"a".repeat(64)}'
        );
      `);

      db.prepare(`
        UPDATE audio_enhancement_derivatives
        SET
          status = 'stale',
          rejected_by_admin_user_id = 'admin_fixture',
          rejection_reason = ?,
          rejected_at = datetime('now')
        WHERE id = 'derivative_fixture'
      `).run("The original master is the stronger editorial choice.");
      expect(db.prepare(`
        SELECT status, rejected_by_admin_user_id, rejection_reason,
          rejected_at IS NOT NULL AS has_rejected_at
        FROM audio_enhancement_derivatives
        WHERE id = 'derivative_fixture'
      `).get()).toEqual({
        status: "stale",
        rejected_by_admin_user_id: "admin_fixture",
        rejection_reason:
          "The original master is the stronger editorial choice.",
        has_rejected_at: 1
      });
      expect(() => db.prepare(`
        UPDATE audio_enhancement_derivatives
        SET rejection_reason = ?
        WHERE id = 'derivative_fixture'
      `).run("A different terminal reason must not replace evidence."))
        .toThrow(/immutable|inconsistent/);

      db.exec(`
        INSERT INTO audio_enhancement_derivatives (
          id, episode_id, status, source_master_id,
          derivative_quality_control_run_id, output_sha256
        ) VALUES (
          'derivative_policy_stale', 'episode_fixture', 'ready',
          'master_fixture', 'qc_fixture', '${"a".repeat(64)}'
        );
        UPDATE show_audio_qc_policies SET revision = 2
        WHERE show_id = 'show_fixture';
      `);
      expect(() => db.prepare(`
        UPDATE audio_enhancement_derivatives
        SET
          status = 'stale',
          rejected_by_admin_user_id = 'admin_fixture',
          rejection_reason = ?,
          rejected_at = datetime('now')
        WHERE id = 'derivative_policy_stale'
      `).run("This candidate no longer has current policy evidence."))
        .toThrow(/rejection evidence is invalid/);

      db.exec(`
        INSERT INTO audio_enhancement_derivatives (
          id, episode_id, status, source_master_id
        ) VALUES (
          'derivative_master_stale', 'episode_fixture', 'ready',
          'master_fixture'
        );
        UPDATE audio_enhancement_derivatives
        SET status = 'stale'
        WHERE id = 'derivative_master_stale';
      `);
      expect(db.prepare(`
        SELECT status, rejected_at
        FROM audio_enhancement_derivatives
        WHERE id = 'derivative_master_stale'
      `).get()).toEqual({ status: "stale", rejected_at: null });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
