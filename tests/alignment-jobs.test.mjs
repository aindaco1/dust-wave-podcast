import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  buildAlignmentProcessorManifest,
  buildAlignmentTranscriptProjection,
  canonicalAlignmentSha256,
  MAXIMUM_ALIGNMENT_RESULT_BYTES
} from "@dustwave/timed-text/alignment";
import { hmacSha256 } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  completeAlignmentProcessorJob,
  getAlignmentProcessorManifest,
  getAlignmentProcessorSource
} from "../src/alignment-jobs";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const processorSecret = "alignment-processor-secret";
const showId = "show_opera_en_la_selva";
const episodeId = "episode_alignment_fixture";
const transcriptId = "transcript_alignment_fixture";
const masterId = "master_alignment_fixture";
const jobId = "alignment_job_fixture";
const revisionId = "alignment_revision_fixture";
const sourceSha256 = "b".repeat(64);
const transcriptContentSha256 = "c".repeat(64);
const runnerRevision = "3c5ab054fdad375901eb186f32d7aed6cdb40413";
const runnerDigest =
  "sha256:5b07bbf315bd62a3c445a7a5a476bf642f91aa1c781173aa1f4e4e8021a51178";
const sourceKey =
  `podcasts/${showId}/${episodeId}/source_audio/source.wav`;
const resultKey =
  `podcasts/${showId}/${episodeId}/alignment/${jobId}/result.json`;
const cues = [
  {
    id: "cue_1",
    startsAtMs: 0,
    endsAtMs: 1_500,
    speakerLabel: "",
    speakerConfirmed: false,
    textMarkdown: "Ópera en la Selva"
  },
  {
    id: "cue_2",
    startsAtMs: 1_500,
    endsAtMs: 3_000,
    speakerLabel: "",
    speakerConfirmed: false,
    textMarkdown: "continúa"
  }
];

describe("word-alignment orchestration", () => {
  it("keeps signed processor routes absent outside staging", async () => {
    const env = {
      ENVIRONMENT: "production",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          throw new Error("production alignment route must not read D1");
        }
      }
    };
    for (const [handler, suffix, action] of [
      [getAlignmentProcessorManifest, "manifest", "manifest"],
      [getAlignmentProcessorSource, "source", "source"]
    ]) {
      const response = await handler(
        new Request(`https://feeds.dustwave.xyz/${suffix}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, action })
        }),
        env,
        jobId
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    const completion = await completeAlignmentProcessorJob(
      new Request("https://feeds.dustwave.xyz/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      env,
      jobId
    );
    expect(completion.status).toBe(404);
  });

  it("projects one exact private result to needs-review words", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      const projection = await buildAlignmentTranscriptProjection({
        transcriptId,
        contentSha256: transcriptContentSha256,
        language: "es",
        cues
      });
      const adapter = {
        name: "whisperx",
        version: "3.8.6",
        model: "default",
        modelVersion: "default-en-es-v1",
        settingsVersion: "whisperx-align-v1",
        runnerDigest
      };
      const manifest = await buildAlignmentProcessorManifest({
        schemaVersion: "alignment-processor-v1",
        processorVersion: "dustwave-alignment-workflow-v1",
        jobId,
        alignmentRevisionId: revisionId,
        episodeId,
        showId,
        transcriptId,
        workingMasterId: masterId,
        language: "es",
        source: {
          objectKey: sourceKey,
          objectBytes: 1000,
          etag: "source-etag",
          mimeType: "audio/wav",
          sha256: sourceSha256,
          durationMs: 3000
        },
        transcript: projection,
        adapter,
        runner: {
          repository: "aindaco1/dust-wave-alignment-runner",
          revision: runnerRevision
        },
        output: {
          maximumResultBytes: MAXIMUM_ALIGNMENT_RESULT_BYTES
        },
        sourceUrl:
          `https://dust-wave-podcast-staging.jogo.workers.dev/`
          + `v1/processor/alignments/${jobId}/source`,
        callbackUrl:
          `https://dust-wave-podcast-staging.jogo.workers.dev/`
          + `v1/processor/alignments/${jobId}/complete`
      });
      seedAlignmentJob(database, projection, manifest.manifestSha256);
      const candidateWords = projection.cues.flatMap((cue) =>
        cue.words.map((word, index) => ({
          wordId: word.wordId,
          cueId: cue.cueId,
          text: word.text,
          startsAtMs: cue.startsAtMs + index * 200,
          endsAtMs: cue.startsAtMs + index * 200 + 150,
          confidence: 0.95,
          timingOrigin: "forced_alignment",
          unalignedReason: null
        }))
      );
      const resultManifest = {
        schemaVersion: "2",
        jobId,
        alignmentRevisionId: revisionId,
        language: "es",
        sourceAudioSha256: sourceSha256,
        transcriptContentSha256,
        transcriptProjectionSha256: projection.projectionSha256,
        adapter,
        candidateWords,
        projectionIssues: [],
        resource: {
          inputDurationMinutes: 0.05,
          wallClockMinutes: 0.02,
          peakMemoryMb: 512,
          runner: "python-3.12"
        }
      };
      const result = {
        manifest: resultManifest,
        manifestSha256: await canonicalAlignmentSha256(resultManifest)
      };
      const objects = new Map();
      const env = {
        ENVIRONMENT: "staging",
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        MEDIA_PROCESSOR_CALLBACK_SECRET: processorSecret,
        DB: d1Database(database),
        MEDIA_BUCKET: {
          async head(key) {
            return objects.get(key) ?? null;
          },
          async put(key, body, options) {
            if (objects.has(key)) return null;
            const text = String(body);
            const stored = {
              key,
              size: new TextEncoder().encode(text).byteLength,
              etag: "result-etag",
              httpEtag: "\"result-etag\"",
              customMetadata: options.customMetadata,
              checksums: {
                toJSON() {
                  return { sha256: options.sha256 };
                }
              }
            };
            objects.set(key, stored);
            return stored;
          }
        }
      };
      const callback = {
        jobId,
        alignmentRevisionId: revisionId,
        processorManifestSha256: manifest.manifestSha256,
        status: "succeeded",
        result
      };
      const response = await completeAlignmentProcessorJob(
        await signedRequest(callback),
        env,
        jobId
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        job: {
          id: jobId,
          status: "ready",
          alignmentStatus: "needs_review",
          quality: {
            wordCount: 5,
            alignedWordCount: 5,
            structurallyEligible: true
          },
          benchmark: {
            passedRunId: null,
            requiredForApproval: true
          }
        },
        idempotent: false
      });
      expect(objects.has(resultKey)).toBe(true);
      expect(database.prepare(`
        SELECT status, result_manifest_sha256, failure_code
        FROM transcript_alignment_jobs
        WHERE id = ?
      `).get(jobId)).toEqual({
        status: "ready",
        result_manifest_sha256: result.manifestSha256,
        failure_code: null
      });
      expect(database.prepare(`
        SELECT status
        FROM transcript_alignment_revisions
        WHERE id = ?
      `).get(revisionId)).toEqual({ status: "needs_review" });
      expect(database.prepare(`
        SELECT COUNT(*) AS count,
               SUM(timing_status = 'aligned') AS aligned
        FROM transcript_words
        WHERE alignment_revision_id = ?
      `).get(revisionId)).toEqual({ count: 5, aligned: 5 });
      const audit = database.prepare(`
        SELECT metadata_json
        FROM admin_audit_events
        WHERE action = 'alignment.completed'
      `).get();
      expect(audit.metadata_json).not.toContain("Ópera");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        alignmentRevisionId: revisionId,
        wordCount: 5,
        alignedWordCount: 5,
        structurallyEligible: true
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const replay = await completeAlignmentProcessorJob(
        await signedRequest(callback),
        env,
        jobId
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ idempotent: true });
      expect(database.prepare(`
        SELECT COUNT(*) AS count
        FROM transcript_words
        WHERE alignment_revision_id = ?
      `).get(revisionId)).toEqual({ count: 5 });

      expect(() => database.exec(`
        UPDATE transcript_alignment_revisions
        SET status = 'passed'
        WHERE id = '${revisionId}';
      `)).toThrow(/alignment pass requires an exact approval/);
      database.exec(`
        INSERT INTO alignment_benchmark_runs (
          id, corpus_version, adapter, adapter_version, model, model_version,
          settings_version, runner_digest, status, report_json,
          report_sha256, clean_environment_reproduced, completed_at
        ) VALUES (
          'benchmark_alignment_fixture',
          'rights-cleared-bilingual-v1',
          'whisperx',
          '3.8.6',
          'default',
          'default-en-es-v1',
          'whisperx-align-v1',
          '${runnerDigest}',
          'failed',
          '{}',
          '${"f".repeat(64)}',
          0,
          datetime('now')
        );
      `);
      expect(() => database.exec(`
        INSERT INTO transcript_alignment_approvals (
          id, alignment_revision_id, benchmark_run_id, admin_user_id
        ) VALUES (
          'alignment_approval_fixture',
          '${revisionId}',
          'benchmark_alignment_fixture',
          'admin_alignment_fixture'
        );
      `)).toThrow(/passed benchmark/);
      database.exec(`
        UPDATE alignment_benchmark_runs
        SET status = 'passed', clean_environment_reproduced = 1
        WHERE id = 'benchmark_alignment_fixture';
        INSERT INTO transcript_alignment_approvals (
          id, alignment_revision_id, benchmark_run_id, admin_user_id
        ) VALUES (
          'alignment_approval_fixture',
          '${revisionId}',
          'benchmark_alignment_fixture',
          'admin_alignment_fixture'
        );
        UPDATE transcript_alignment_revisions
        SET status = 'passed'
        WHERE id = '${revisionId}';
      `);
      expect(database.prepare(`
        SELECT status
        FROM transcript_alignment_revisions
        WHERE id = ?
      `).get(revisionId)).toEqual({ status: "passed" });

      database.exec(`
        INSERT INTO transcript_alignment_revisions (
          id, transcript_id, source_audio_sha256,
          transcript_revision_sha256, language, adapter, adapter_version,
          model, model_version, settings_version, runner_digest, status,
          quality_report_json, input_fingerprint
        ) VALUES (
          'alignment_revision_second_fixture',
          '${transcriptId}',
          '${sourceSha256}',
          '${transcriptContentSha256}',
          'es',
          'whisperx',
          '3.8.6',
          'default',
          'default-en-es-v1',
          'whisperx-align-v1',
          '${runnerDigest}',
          'processing',
          '{}',
          '${"9".repeat(64)}'
        );
        INSERT INTO transcript_words (
          id, transcript_id, position, word, starts_at_ms, ends_at_ms,
          confidence, alignment_revision_id, cue_id, timing_status,
          timing_origin
        ) VALUES (
          'word_second_revision_fixture',
          '${transcriptId}',
          0,
          'Ópera',
          0,
          150,
          0.95,
          'alignment_revision_second_fixture',
          'cue_1',
          'aligned',
          'forced_alignment'
        );
      `);
      expect(database.prepare(`
        SELECT COUNT(*) AS count
        FROM transcript_words
        WHERE transcript_id = ? AND position = 0
      `).get(transcriptId)).toEqual({ count: 2 });
      expect(() => database.exec(`
        INSERT INTO transcript_words (
          id, transcript_id, position, word, starts_at_ms, ends_at_ms,
          confidence, alignment_revision_id, cue_id, timing_status,
          timing_origin
        ) VALUES (
          'word_duplicate_position_fixture',
          '${transcriptId}',
          0,
          'duplicate',
          200,
          350,
          0.95,
          'alignment_revision_second_fixture',
          'cue_1',
          'aligned',
          'forced_alignment'
        );
      `)).toThrow(/UNIQUE constraint failed/);

      database.exec(`
        UPDATE transcript_alignment_revisions
        SET status = 'superseded'
        WHERE id = '${revisionId}';
      `);
      expect(database.prepare(`
        SELECT status, failure_code
        FROM transcript_alignment_jobs
        WHERE id = ?
      `).get(jobId)).toEqual({
        status: "stale",
        failure_code: "transcript_changed"
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function seedAlignmentJob(database, projection, processorManifestSha256) {
  const contentJson = JSON.stringify({
    schemaVersion: 1,
    language: "es",
    cues
  });
  database.exec(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at
    ) VALUES (
      'admin_alignment_fixture',
      'alignment-email-hash',
      'active',
      datetime('now')
    );
    INSERT INTO episodes (
      id, show_id, slug, title, canonical_url, source_language,
      source_audio_key
    ) VALUES (
      '${episodeId}',
      '${showId}',
      'alignment-fixture',
      'Alignment fixture',
      'https://dustwave.xyz/news/podcasts/opera/alignment-fixture/',
      'es',
      '${sourceKey}'
    );
    INSERT INTO media_uploads (
      id, show_id, episode_id, kind, object_key, r2_upload_id,
      filename, content_type, expected_bytes, status, completed_bytes,
      object_etag
    ) VALUES (
      'upload_alignment_fixture',
      '${showId}',
      '${episodeId}',
      'source_audio',
      '${sourceKey}',
      'r2-alignment-fixture',
      'source.wav',
      'audio/wav',
      1000,
      'completed',
      1000,
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
      'qc_alignment_fixture',
      '${episodeId}',
      'upload_alignment_fixture',
      '${sourceKey}',
      1000,
      'source-etag',
      'audio/wav',
      1,
      '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
      '${"a".repeat(64)}',
      'succeeded',
      '${sourceSha256}',
      '{}',
      '${"d".repeat(64)}',
      0,
      0,
      3000,
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
      'upload_alignment_fixture',
      'qc_alignment_fixture',
      '${sourceKey}',
      1000,
      'source-etag',
      'audio/wav',
      '${sourceSha256}',
      '${"d".repeat(64)}',
      'Exact source approved for alignment fixture.',
      'admin_alignment_fixture'
    );
    UPDATE episode_working_master_states
    SET revision = 1, current_master_id = '${masterId}'
    WHERE episode_id = '${episodeId}';
    INSERT INTO transcripts (
      id, episode_id, language, source, status, content_json, edited_html,
      revision, content_sha256, speaker_labels_confirmed,
      approved_revision, approved_at, approved_by_admin_user_id
    ) VALUES (
      '${transcriptId}',
      '${episodeId}',
      'es',
      'editor',
      'approved',
      '${sqlText(contentJson)}',
      '',
      1,
      '${transcriptContentSha256}',
      1,
      1,
      datetime('now'),
      'admin_alignment_fixture'
    );
    INSERT INTO transcript_alignment_revisions (
      id, transcript_id, source_audio_sha256,
      transcript_revision_sha256, language, adapter, adapter_version,
      model, model_version, settings_version, runner_digest, status,
      result_manifest_key, quality_report_json, input_fingerprint
    ) VALUES (
      '${revisionId}',
      '${transcriptId}',
      '${sourceSha256}',
      '${transcriptContentSha256}',
      'es',
      'whisperx',
      '3.8.6',
      'default',
      'default-en-es-v1',
      'whisperx-align-v1',
      '${runnerDigest}',
      'processing',
      '${resultKey}',
      '{}',
      '${"e".repeat(64)}'
    );
    INSERT INTO transcript_alignment_jobs (
      id, request_id, alignment_revision_id, transcript_id, episode_id,
      working_master_id, source_object_key, source_object_bytes,
      source_object_etag, source_mime_type, source_duration_ms,
      source_audio_sha256, transcript_revision,
      transcript_content_sha256, transcript_projection_json,
      transcript_projection_sha256, language, adapter, adapter_version,
      model, model_version, settings_version, runner_revision,
      runner_digest, processor_manifest_sha256, result_object_key,
      input_fingerprint, status, attempt_count
    ) VALUES (
      '${jobId}',
      'alignment_request_fixture',
      '${revisionId}',
      '${transcriptId}',
      '${episodeId}',
      '${masterId}',
      '${sourceKey}',
      1000,
      'source-etag',
      'audio/wav',
      3000,
      '${sourceSha256}',
      1,
      '${transcriptContentSha256}',
      '${sqlText(JSON.stringify(projection))}',
      '${projection.projectionSha256}',
      'es',
      'whisperx',
      '3.8.6',
      'default',
      'default-en-es-v1',
      'whisperx-align-v1',
      '${runnerRevision}',
      '${runnerDigest}',
      '${processorManifestSha256}',
      '${resultKey}',
      '${"e".repeat(64)}',
      'running',
      1
    );
  `);
}

async function signedRequest(body) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    processorSecret,
    "hex"
  );
  return new Request(
    `https://feeds.dustwave.xyz/v1/processor/alignments/${jobId}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podcast-processor-timestamp": String(timestamp),
        "x-podcast-processor-signature": signature
      },
      body: rawBody
    }
  );
}

function d1Database(database) {
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
        return { results: database.prepare(query).all(...values) };
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

function sqlText(value) {
  return value.replaceAll("'", "''");
}
