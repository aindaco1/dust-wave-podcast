import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { processTranscriptionJob } from "../src/transcription-jobs";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("source-language transcription consumer", () => {
  it("writes private immutable segment artifacts and one review revision", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      const sourceBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const sourceSha256 = createHash("sha256")
        .update(sourceBytes)
        .digest("hex");
      seedTranscriptionJob(database, sourceBytes.byteLength, sourceSha256);
      const artifacts = new Map();
      let providerCalls = 0;
      const env = {
        DB: d1Database(database, { failFirstBatch: true }),
        MEDIA_BUCKET: {
          async get(key) {
            if (key === sourceKey) {
              return {
                key,
                size: sourceBytes.byteLength,
                etag: "source-etag",
                async bytes() {
                  return sourceBytes;
                }
              };
            }
            const artifact = artifacts.get(key);
            return artifact
              ? {
                  ...artifact,
                  async text() {
                    return artifact.body;
                  }
                }
              : null;
          },
          async head(key) {
            return artifacts.get(key) ?? null;
          },
          async put(
            key,
            value,
            options
          ) {
            if (artifacts.has(key)) return null;
            const object = {
              key,
              size: new TextEncoder().encode(value).byteLength,
              etag: `etag-${artifacts.size + 1}`,
              body: value,
              customMetadata: options.customMetadata
            };
            artifacts.set(key, object);
            return object;
          }
        },
        AI: {
          aiGatewayLogId: "workers-ai-request-fixture",
          async run(
            model,
            input
          ) {
            providerCalls += 1;
            expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
            expect(input).toMatchObject({
              task: "transcribe",
              language: "es",
              vad_filter: true,
              condition_on_previous_text: true
            });
            expect(typeof input.audio).toBe("string");
            return {
              text: "Belleza y alegría. Beauty and joy.",
              word_count: 6,
              segments: [
                {
                  start: 0,
                  end: 1.25,
                  text: "Belleza y alegría.",
                  words: [
                    { word: "Belleza", start: 0, end: 0.4 }
                  ]
                },
                {
                  start: 1.25,
                  end: 2.5,
                  text: "Beauty and joy."
                }
              ],
              vtt: "provider output is retained privately but not trusted"
            };
          }
        }
      };
      const message = {
        id: jobId,
        type: "transcribe",
        showId,
        episodeId,
        requestedAt: new Date().toISOString()
      };

      await expect(processTranscriptionJob(env, message)).rejects.toThrow(
        /fixture batch interruption/
      );
      await processTranscriptionJob(env, message);
      await processTranscriptionJob(env, message);

      expect(providerCalls).toBe(1);
      expect(artifacts.size).toBe(5);
      expect([...artifacts.keys()].sort()).toEqual([
        `${artifactPrefix}/captions.srt`,
        `${artifactPrefix}/captions.vtt`,
        `${artifactPrefix}/provider-response.json`,
        `${artifactPrefix}/timed-text.json`,
        `${artifactPrefix}/transcript.txt`
      ]);
      expect(
        artifacts.get(`${artifactPrefix}/timed-text.json`)
          ?.customMetadata
      ).toMatchObject({
        jobId,
        sourceSha256
      });
      expect(
        JSON.parse(
          artifacts.get(`${artifactPrefix}/timed-text.json`)?.body ?? "{}"
        )
      ).toMatchObject({
        schemaVersion: "timed-text-v1",
        timingPrecision: "segment",
        language: "es"
      });

      expect(database.prepare(`
        SELECT status, attempt_count, transcript_revision,
          provider_request_id, failure_code
        FROM transcription_jobs
        WHERE id = ?
      `).get(jobId)).toEqual({
        status: "succeeded",
        attempt_count: 2,
        transcript_revision: 1,
        provider_request_id: "workers-ai-request-fixture",
        failure_code: null
      });
      const transcript = database.prepare(`
        SELECT source, status, revision, speaker_labels_confirmed,
          approved_revision, content_json
        FROM transcripts
        WHERE episode_id = ? AND language = 'es'
      `).get(episodeId);
      expect(transcript).toMatchObject({
        source: "workers_ai",
        status: "needs_review",
        revision: 1,
        speaker_labels_confirmed: 0,
        approved_revision: null
      });
      const content = JSON.parse(transcript.content_json);
      expect(content.cues).toHaveLength(2);
      expect(content.cues[0]).toEqual({
        id: "cue_000001",
        startsAtMs: 0,
        endsAtMs: 1_250,
        speakerLabel: "",
        speakerConfirmed: false,
        textMarkdown: "Belleza y alegría."
      });
      expect(content.cues[0]).not.toHaveProperty("words");
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM transcript_words
      `).get()).toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM transcript_alignment_revisions
      `).get()).toEqual({ count: 0 });
      const audit = database.prepare(`
        SELECT metadata_json
        FROM admin_audit_events
        WHERE action = 'transcription.completed'
      `).get();
      expect(audit.metadata_json).not.toContain("Belleza");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        wordTimingCreated: false,
        timingPrecision: "segment",
        cueCount: 2
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function d1Database(database, { failFirstBatch = false } = {}) {
  let batchFailurePending = failFirstBatch;
  const prepare = (query) => {
    let values = [];
    const statement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first() {
        return database.prepare(query).get(...values) ?? null;
      },
      async all() {
        return {
          results: database.prepare(query).all(...values)
        };
      },
      async run() {
        return statement.executeRun();
      },
      executeRun() {
        const result = database.prepare(query).run(...values);
        return {
          success: true,
          meta: { changes: Number(result.changes) },
          results: []
        };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      if (batchFailurePending) {
        batchFailurePending = false;
        throw new Error("fixture batch interruption");
      }
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) =>
          statement.executeRun()
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}

function seedTranscriptionJob(database, sourceBytes, sourceSha256) {
  database.exec(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at
    ) VALUES (
      'admin_transcription_consumer',
      'consumer-email-hash',
      'active',
      datetime('now')
    );
    INSERT INTO episodes (
      id, show_id, slug, title, canonical_url, source_language,
      source_audio_key
    ) VALUES (
      '${episodeId}',
      '${showId}',
      'transcription-consumer',
      'Transcription consumer',
      'https://dustwave.xyz/news/podcasts/opera/transcription-consumer/',
      'es',
      '${sourceKey}'
    );
    INSERT INTO media_uploads (
      id, show_id, episode_id, kind, object_key, r2_upload_id,
      filename, content_type, expected_bytes, status, completed_bytes,
      object_etag
    ) VALUES (
      'upload_transcription_consumer',
      '${showId}',
      '${episodeId}',
      'source_audio',
      '${sourceKey}',
      'r2-transcription-consumer',
      'source.wav',
      'audio/wav',
      ${sourceBytes},
      'completed',
      ${sourceBytes},
      'source-etag'
    );
    INSERT INTO audio_qc_runs (
      id, episode_id, source_upload_id, source_object_key,
      source_object_bytes, source_object_etag, source_mime_type,
      policy_revision, policy_json, processor_manifest_sha256,
      status, source_sha256, report_json, report_sha256,
      blocker_count, warning_count, duration_ms, integrated_lufs,
      true_peak_dbtp, processor_version, completed_at
    ) VALUES (
      'qc_transcription_consumer',
      '${episodeId}',
      'upload_transcription_consumer',
      '${sourceKey}',
      ${sourceBytes},
      'source-etag',
      'audio/wav',
      1,
      '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
      '${"a".repeat(64)}',
      'succeeded',
      '${sourceSha256}',
      '{}',
      '${"c".repeat(64)}',
      0,
      0,
      2500,
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
      '${masterId}',
      '${episodeId}',
      1,
      'source_original',
      'upload_transcription_consumer',
      'qc_transcription_consumer',
      '${sourceKey}',
      ${sourceBytes},
      'source-etag',
      'audio/wav',
      '${sourceSha256}',
      '${"c".repeat(64)}',
      'Exact source approved for transcription consumer test.',
      'admin_transcription_consumer'
    );
    UPDATE episode_working_master_states
    SET revision = 1, current_master_id = '${masterId}'
    WHERE episode_id = '${episodeId}';
    INSERT INTO transcription_jobs (
      id, request_id, episode_id, working_master_id,
      working_master_sha256, source_object_key, source_object_bytes,
      source_object_etag, source_mime_type, source_duration_ms,
      language, model, settings_revision, settings_version,
      settings_json, input_fingerprint, raw_response_object_key,
      normalized_object_key, webvtt_object_key, srt_object_key,
      plain_text_object_key, requested_by_admin_user_id
    ) VALUES (
      '${jobId}',
      'transcription_request_consumer',
      '${episodeId}',
      '${masterId}',
      '${sourceSha256}',
      '${sourceKey}',
      ${sourceBytes},
      'source-etag',
      'audio/wav',
      2500,
      'es',
      '@cf/openai/whisper-large-v3-turbo',
      1,
      'whisper-source-v1',
      '{"schemaVersion":1,"task":"transcribe","vadFilter":true,"conditionOnPreviousText":true,"vocabulary":[]}',
      '${"d".repeat(64)}',
      '${artifactPrefix}/provider-response.json',
      '${artifactPrefix}/timed-text.json',
      '${artifactPrefix}/captions.vtt',
      '${artifactPrefix}/captions.srt',
      '${artifactPrefix}/transcript.txt',
      'admin_transcription_consumer'
    );
  `);
}

const showId = "show_opera_en_la_selva";
const episodeId = "episode_transcription_consumer";
const masterId = "master_transcription_consumer";
const jobId = "transcription_consumer";
const sourceKey =
  `podcasts/${showId}/${episodeId}/source_audio/source.wav`;
const artifactPrefix =
  `podcasts/${showId}/${episodeId}/transcription/${jobId}`;
