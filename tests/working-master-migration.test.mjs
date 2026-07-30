import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("working-master migration", () => {
  it("replays from zero and invalidates derived approvals on replacement", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.exec(`
        INSERT INTO admin_users (
          id, email_lookup_hash, status, activated_at
        ) VALUES (
          'admin_master_fixture',
          'fixture-email-hash',
          'active',
          datetime('now')
        );
        INSERT INTO episodes (
          id, show_id, slug, title, summary, content_html, canonical_url,
          source_audio_key
        ) VALUES (
          'episode_master_fixture',
          'show_opera_en_la_selva',
          'master-fixture',
          'Master fixture',
          'Summary',
          '<p>Notes</p>',
          'https://dustwave.xyz/news/podcasts/opera/master-fixture/',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav'
        );
        INSERT INTO media_uploads (
          id, show_id, episode_id, kind, object_key, r2_upload_id,
          filename, content_type, expected_bytes, status, completed_bytes,
          object_etag, initiated_by_admin_user_id, completed_at
        ) VALUES (
          'upload_master_fixture',
          'show_opera_en_la_selva',
          'episode_master_fixture',
          'source_audio',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav',
          'r2-fixture',
          'source.wav',
          'audio/wav',
          1000,
          'completed',
          1000,
          '"fixture-etag"',
          'admin_master_fixture',
          datetime('now')
        );
        INSERT INTO audio_qc_runs (
          id, episode_id, source_upload_id, source_object_key,
          source_object_bytes, source_object_etag, source_mime_type,
          policy_revision, policy_json, processor_manifest_sha256,
          status, source_sha256, report_json, report_sha256,
          blocker_count, warning_count, duration_ms, integrated_lufs,
          true_peak_dbtp, processor_version, requested_by_admin_user_id,
          completed_at
        ) VALUES (
          'qc_master_fixture_1',
          'episode_master_fixture',
          'upload_master_fixture',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav',
          1000,
          '"fixture-etag"',
          'audio/wav',
          1,
          '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
          '${"1".repeat(64)}',
          'succeeded',
          '${"2".repeat(64)}',
          '{}',
          '${"3".repeat(64)}',
          0,
          0,
          60000,
          -19,
          -2,
          'fixture-processor',
          'admin_master_fixture',
          datetime('now')
        );
        INSERT INTO episode_working_masters (
          id, episode_id, revision, origin_kind, source_upload_id,
          quality_control_run_id, object_key, object_bytes, object_etag,
          mime_type, source_sha256, quality_control_report_sha256,
          approval_reason, approved_by_admin_user_id
        ) VALUES (
          'master_fixture_1',
          'episode_master_fixture',
          1,
          'source_original',
          'upload_master_fixture',
          'qc_master_fixture_1',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav',
          1000,
          '"fixture-etag"',
          'audio/wav',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          'Initial exact source approval.',
          'admin_master_fixture'
        );
        UPDATE episode_working_master_states
        SET revision = 1, current_master_id = 'master_fixture_1'
        WHERE episode_id = 'episode_master_fixture';

        INSERT INTO transcripts (
          id, episode_id, language, status, content_json, edited_html,
          approved_at, revision, content_sha256, speaker_labels_confirmed,
          approved_revision, approved_by_admin_user_id
        ) VALUES (
          'transcript_master_fixture',
          'episode_master_fixture',
          'es',
          'approved',
          '{}',
          '<p>Transcript</p>',
          datetime('now'),
          1,
          '${"4".repeat(64)}',
          1,
          1,
          'admin_master_fixture'
        );
        INSERT INTO episode_chapter_sets (
          episode_id, status, revision, content_sha256, approved_revision,
          approved_at, approved_by_admin_user_id
        ) VALUES (
          'episode_master_fixture',
          'approved',
          1,
          '${"5".repeat(64)}',
          1,
          datetime('now'),
          'admin_master_fixture'
        );
        INSERT INTO clips (
          id, episode_id, title, starts_at_ms, ends_at_ms, status
        ) VALUES (
          'clip_master_fixture',
          'episode_master_fixture',
          'Fixture clip',
          0,
          5000,
          'ready'
        );

        UPDATE show_audio_qc_policies
        SET revision = 2
        WHERE show_id = 'show_opera_en_la_selva';
        INSERT INTO audio_qc_runs (
          id, episode_id, source_upload_id, source_object_key,
          source_object_bytes, source_object_etag, source_mime_type,
          policy_revision, policy_json, processor_manifest_sha256,
          status, source_sha256, report_json, report_sha256,
          blocker_count, warning_count, duration_ms, integrated_lufs,
          true_peak_dbtp, processor_version, requested_by_admin_user_id,
          completed_at
        ) VALUES (
          'qc_master_fixture_2',
          'episode_master_fixture',
          'upload_master_fixture',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav',
          1000,
          '"fixture-etag"',
          'audio/wav',
          2,
          '{"schemaVersion":"audio-qc-policy-v1","revision":2}',
          '${"6".repeat(64)}',
          'succeeded',
          '${"2".repeat(64)}',
          '{}',
          '${"7".repeat(64)}',
          0,
          0,
          60000,
          -19,
          -2,
          'fixture-processor',
          'admin_master_fixture',
          datetime('now')
        );
        INSERT INTO episode_working_masters (
          id, episode_id, revision, origin_kind, source_upload_id,
          quality_control_run_id, object_key, object_bytes, object_etag,
          mime_type, source_sha256, quality_control_report_sha256,
          approval_reason, approved_by_admin_user_id
        ) VALUES (
          'master_fixture_2',
          'episode_master_fixture',
          2,
          'source_original',
          'upload_master_fixture',
          'qc_master_fixture_2',
          'podcasts/show_opera_en_la_selva/episode_master_fixture/source_audio/source.wav',
          1000,
          '"fixture-etag"',
          'audio/wav',
          '${"2".repeat(64)}',
          '${"7".repeat(64)}',
          'Reapproved against the current policy.',
          'admin_master_fixture'
        );
        UPDATE episode_working_master_states
        SET revision = 2, current_master_id = 'master_fixture_2'
        WHERE episode_id = 'episode_master_fixture';
      `);

      expect(db.prepare(`
        SELECT revision, current_master_id
        FROM episode_working_master_states
        WHERE episode_id = 'episode_master_fixture'
      `).get()).toEqual({
        revision: 2,
        current_master_id: "master_fixture_2"
      });
      expect(db.prepare(`
        SELECT status, approved_revision, approved_at,
          approved_by_admin_user_id
        FROM transcripts
        WHERE id = 'transcript_master_fixture'
      `).get()).toEqual({
        status: "needs_review",
        approved_revision: null,
        approved_at: null,
        approved_by_admin_user_id: null
      });
      expect(db.prepare(`
        SELECT status, approved_revision, approved_at,
          approved_by_admin_user_id
        FROM episode_chapter_sets
        WHERE episode_id = 'episode_master_fixture'
      `).get()).toEqual({
        status: "needs_review",
        approved_revision: null,
        approved_at: null,
        approved_by_admin_user_id: null
      });
      expect(db.prepare(`
        SELECT status FROM clips WHERE id = 'clip_master_fixture'
      `).get()).toEqual({ status: "draft" });
      expect(() => db.exec(`
        UPDATE episode_working_master_states
        SET revision = 3, current_master_id = 'master_fixture_missing'
        WHERE episode_id = 'episode_master_fixture';
      `)).toThrow(/working master state reference is invalid/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
