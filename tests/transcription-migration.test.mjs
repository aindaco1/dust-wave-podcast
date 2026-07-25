import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("transcription orchestration migration", () => {
  it("replays from zero, creates show settings, and stales active jobs with the master", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      expect(db.prepare(`
        SELECT model, settings_version, vocabulary_json
        FROM show_transcription_settings
        WHERE show_id = 'show_opera_en_la_selva'
      `).get()).toEqual({
        model: "@cf/openai/whisper-large-v3-turbo",
        settings_version: "whisper-source-v1",
        vocabulary_json: "[]"
      });
      db.exec(`
        INSERT INTO admin_users (
          id, email_lookup_hash, status, activated_at
        ) VALUES (
          'admin_transcription_fixture',
          'transcription-email-hash',
          'active',
          datetime('now')
        );
        INSERT INTO episodes (
          id, show_id, slug, title, canonical_url, source_language,
          source_audio_key
        ) VALUES (
          'episode_transcription_fixture',
          'show_opera_en_la_selva',
          'transcription-fixture',
          'Transcription fixture',
          'https://dustwave.xyz/news/podcasts/opera/transcription-fixture/',
          'es',
          'podcasts/show_opera_en_la_selva/episode_transcription_fixture/source_audio/source.wav'
        );
        INSERT INTO media_uploads (
          id, show_id, episode_id, kind, object_key, r2_upload_id,
          filename, content_type, expected_bytes, status, completed_bytes,
          object_etag
        ) VALUES (
          'upload_transcription_fixture',
          'show_opera_en_la_selva',
          'episode_transcription_fixture',
          'source_audio',
          'podcasts/show_opera_en_la_selva/episode_transcription_fixture/source_audio/source.wav',
          'r2-transcription-fixture',
          'source.wav',
          'audio/wav',
          1000,
          'completed',
          1000,
          'fixture-etag'
        );
        INSERT INTO audio_qc_runs (
          id, episode_id, source_upload_id, source_object_key,
          source_object_bytes, source_object_etag, source_mime_type,
          policy_revision, policy_json, processor_manifest_sha256,
          status, source_sha256, report_json, report_sha256,
          blocker_count, warning_count, duration_ms, integrated_lufs,
          true_peak_dbtp, processor_version, completed_at
        ) VALUES (
          'qc_transcription_fixture',
          'episode_transcription_fixture',
          'upload_transcription_fixture',
          'podcasts/show_opera_en_la_selva/episode_transcription_fixture/source_audio/source.wav',
          1000,
          'fixture-etag',
          'audio/wav',
          1,
          '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
          '${"a".repeat(64)}',
          'succeeded',
          '${"b".repeat(64)}',
          '{}',
          '${"c".repeat(64)}',
          0,
          0,
          60000,
          -19,
          -2,
          'fixture',
          datetime('now')
        );
        INSERT INTO episode_working_masters (
          id, episode_id, revision, origin_kind, source_upload_id,
          quality_control_run_id, object_key, object_bytes, object_etag,
          mime_type, source_sha256, quality_control_report_sha256,
          approval_reason, approved_by_admin_user_id
        ) VALUES (
          'master_transcription_fixture',
          'episode_transcription_fixture',
          1,
          'source_original',
          'upload_transcription_fixture',
          'qc_transcription_fixture',
          'podcasts/show_opera_en_la_selva/episode_transcription_fixture/source_audio/source.wav',
          1000,
          'fixture-etag',
          'audio/wav',
          '${"b".repeat(64)}',
          '${"c".repeat(64)}',
          'Exact source approved for transcription.',
          'admin_transcription_fixture'
        );
        UPDATE episode_working_master_states
        SET
          revision = 1,
          current_master_id = 'master_transcription_fixture'
        WHERE episode_id = 'episode_transcription_fixture';
        INSERT INTO transcription_jobs (
          id, request_id, episode_id, working_master_id,
          working_master_sha256, source_object_key, source_object_bytes,
          source_object_etag, source_mime_type, source_duration_ms,
          language, model, settings_revision, settings_version,
          settings_json, input_fingerprint, raw_response_object_key,
          normalized_object_key, webvtt_object_key, srt_object_key,
          plain_text_object_key, requested_by_admin_user_id
        ) VALUES (
          'transcription_fixture',
          'transcription_request_fixture',
          'episode_transcription_fixture',
          'master_transcription_fixture',
          '${"b".repeat(64)}',
          'podcasts/show_opera_en_la_selva/episode_transcription_fixture/source_audio/source.wav',
          1000,
          'fixture-etag',
          'audio/wav',
          60000,
          'es',
          '@cf/openai/whisper-large-v3-turbo',
          1,
          'whisper-source-v1',
          '{"schemaVersion":1,"task":"transcribe","vadFilter":true,"conditionOnPreviousText":true,"vocabulary":[]}',
          '${"d".repeat(64)}',
          'podcasts/show/episode/transcription/job/provider-response.json',
          'podcasts/show/episode/transcription/job/timed-text.json',
          'podcasts/show/episode/transcription/job/captions.vtt',
          'podcasts/show/episode/transcription/job/captions.srt',
          'podcasts/show/episode/transcription/job/transcript.txt',
          'admin_transcription_fixture'
        );
        INSERT INTO transcription_chunk_runs (
          id, transcription_job_id, processor_manifest_sha256, policy_json
        ) VALUES (
          'transcription_chunks_fixture',
          'transcription_fixture',
          '${"e".repeat(64)}',
          '{"targetChunkDurationMs":720000,"maximumChunkDurationMs":900000,"minimumChunkDurationMs":120000,"overlapMs":1500,"silenceThresholdDb":-35,"minimumSilenceDurationMs":500,"outputMimeType":"audio/mpeg","outputCodec":"libmp3lame","outputSampleRateHz":16000,"outputChannels":1,"outputBitrateKbps":64}'
        );
      `);
      expect(() => db.exec(`
        UPDATE episodes
        SET source_language = 'fr'
        WHERE id = 'episode_transcription_fixture';
      `)).toThrow();
      expect(() => db.exec(`
        UPDATE transcription_jobs
        SET status = 'succeeded', completed_at = datetime('now')
        WHERE id = 'transcription_fixture';
      `)).toThrow();
      expect(() => db.exec(`
        INSERT INTO transcription_chunks (
          run_id, chunk_index, core_starts_at_ms, core_ends_at_ms,
          media_starts_at_ms, media_ends_at_ms, encoded_duration_ms,
          boundary_kind, object_key,
          object_bytes, object_etag, mime_type, sha256,
          provider_raw_object_key
        ) VALUES (
          'transcription_chunks_fixture', 0, 0, 60000, 0, 60000, 60000, 'end',
          'podcasts/show/episode/transcription/job/chunk-audio/000.mp3',
          16777217, 'chunk-etag', 'audio/mpeg', '${"f".repeat(64)}',
          'podcasts/show/episode/transcription/job/chunks/000/provider-response.json'
        );
      `)).toThrow();
      db.exec(`
        UPDATE episode_working_master_states
        SET current_master_id = NULL
        WHERE episode_id = 'episode_transcription_fixture';
      `);
      expect(db.prepare(`
        SELECT status, failure_code, completed_at IS NOT NULL AS completed
        FROM transcription_jobs
        WHERE id = 'transcription_fixture'
      `).get()).toEqual({
        status: "stale",
        failure_code: "working_master_changed",
        completed: 1
      });
      expect(db.prepare(`
        SELECT status, failure_code, completed_at IS NOT NULL AS completed
        FROM transcription_chunk_runs
        WHERE id = 'transcription_chunks_fixture'
      `).get()).toEqual({
        status: "stale",
        failure_code: "source_invalid",
        completed: 1
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
