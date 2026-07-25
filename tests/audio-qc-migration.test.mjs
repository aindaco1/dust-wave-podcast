import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("audio QC migration", () => {
  it("replays from zero and enforces policy/run state", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      expect(db.prepare(`
        SELECT revision, mono_integrated_lufs, stereo_integrated_lufs,
          maximum_true_peak_dbtp
        FROM show_audio_qc_policies
        WHERE show_id = 'show_opera_en_la_selva'
      `).get()).toMatchObject({
        revision: 1,
        mono_integrated_lufs: -19,
        stereo_integrated_lufs: -16,
        maximum_true_peak_dbtp: -1
      });
      db.exec(`
        INSERT INTO shows (
          id, slug, title, canonical_url, rss_slug
        ) VALUES (
          'show_audio_qc_fixture',
          'audio-qc-fixture',
          'Audio QC fixture',
          'https://dustwave.xyz/podcasts/audio-qc-fixture/',
          'audio-qc-fixture'
        );
      `);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM show_audio_qc_policies
        WHERE show_id = 'show_audio_qc_fixture'
      `).get()).toMatchObject({ count: 1 });
      db.exec(`
        INSERT INTO episodes (
          id, show_id, slug, title, canonical_url, source_audio_key
        ) VALUES (
          'episode_audio_qc_fixture',
          'show_audio_qc_fixture',
          'episode',
          'Episode',
          'https://dustwave.xyz/news/podcasts/audio-qc-fixture/episode/',
          'podcasts/show_audio_qc_fixture/episode_audio_qc_fixture/source_audio/upload_source.wav'
        );
        INSERT INTO media_uploads (
          id, show_id, episode_id, kind, object_key, r2_upload_id,
          filename, content_type, expected_bytes, status, completed_bytes,
          object_etag
        ) VALUES (
          'upload_audio_qc_fixture',
          'show_audio_qc_fixture',
          'episode_audio_qc_fixture',
          'source_audio',
          'podcasts/show_audio_qc_fixture/episode_audio_qc_fixture/source_audio/upload_source.wav',
          'r2_upload_fixture',
          'source.wav',
          'audio/wav',
          100,
          'completed',
          100,
          '"etag"'
        );
        INSERT INTO audio_qc_runs (
          id, episode_id, source_upload_id, source_object_key,
          source_object_bytes, source_object_etag, source_mime_type,
          policy_revision, policy_json, processor_manifest_sha256
        ) VALUES (
          'qc_fixture',
          'episode_audio_qc_fixture',
          'upload_audio_qc_fixture',
          'podcasts/show_audio_qc_fixture/episode_audio_qc_fixture/source_audio/upload_source.wav',
          100,
          '"etag"',
          'audio/wav',
          1,
          '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
          '${"a".repeat(64)}'
        );
      `);
      expect(() => db.exec(`
        INSERT INTO audio_qc_runs (
          id, episode_id, source_upload_id, source_object_key,
          source_object_bytes, source_object_etag, source_mime_type,
          policy_revision, policy_json, processor_manifest_sha256
        )
        SELECT
          'qc_fixture_duplicate', episode_id, source_upload_id,
          source_object_key, source_object_bytes, source_object_etag,
          source_mime_type, policy_revision, policy_json,
          processor_manifest_sha256
        FROM audio_qc_runs
        WHERE id = 'qc_fixture';
      `)).toThrow();
      expect(() => db.exec(`
        UPDATE audio_qc_runs
        SET status = 'succeeded'
        WHERE id = 'qc_fixture';
      `)).toThrow();
      db.exec(`
        UPDATE audio_qc_runs
        SET
          status = 'succeeded',
          source_sha256 = '${"b".repeat(64)}',
          report_json = '{}',
          report_sha256 = '${"c".repeat(64)}',
          blocker_count = 0,
          warning_count = 1,
          duration_ms = 60000,
          integrated_lufs = -20,
          true_peak_dbtp = -2,
          processor_version = 'fixture',
          completed_at = datetime('now')
        WHERE id = 'qc_fixture';
      `);
      expect(db.prepare(`
        SELECT status, blocker_count, warning_count
        FROM audio_qc_runs
        WHERE id = 'qc_fixture'
      `).get()).toMatchObject({
        status: "succeeded",
        blocker_count: 0,
        warning_count: 1
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
