import { describe, expect, it } from "vitest";

import {
  scheduleAutomaticTranscriptionJobs
} from "../src/transcription-jobs";
import type { PodcastEnv } from "../src/env";

describe("automatic transcription queueing", () => {
  it("creates one system-owned job and defers it to the existing scheduler", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    let inserted = false;
    let queueMessages = 0;
    const source = {
      show_id: "show_fixture",
      source_language: "es",
      current_master_id: "master_fixture",
      working_master_id: "master_fixture",
      source_sha256: "a".repeat(64),
      object_key:
        "podcasts/show_fixture/episode_fixture/working_masters/"
        + "master_fixture/master.wav",
      object_bytes: 4_000_000,
      object_etag: "source-etag",
      mime_type: "audio/wav",
      duration_ms: 180_000,
      settings_revision: 1,
      model: "@cf/openai/whisper-large-v3-turbo",
      settings_version: "whisper-source-v1",
      vocabulary_json: "[]",
      transcript_revision: null
    };
    const job = {
      id: "transcription_fixture",
      request_id: "transcription_auto_fixture",
      episode_id: "episode_fixture",
      show_id: source.show_id,
      working_master_id: source.working_master_id,
      working_master_sha256: source.source_sha256,
      source_object_key: source.object_key,
      source_object_bytes: source.object_bytes,
      source_object_etag: source.object_etag,
      source_mime_type: source.mime_type,
      source_duration_ms: source.duration_ms,
      language: "es",
      adapter: "workers_ai",
      model: source.model,
      settings_revision: 1,
      settings_version: source.settings_version,
      settings_json: "{}",
      input_fingerprint: "b".repeat(64),
      base_transcript_revision: 0,
      status: "queued",
      attempt_count: 0,
      raw_response_object_key: "private/raw.json",
      normalized_object_key: "private/normalized.json",
      webvtt_object_key: "private/captions.vtt",
      srt_object_key: "private/captions.srt",
      plain_text_object_key: "private/transcript.txt",
      raw_response_sha256: null,
      normalized_sha256: null,
      transcript_id: null,
      transcript_revision: null,
      transcript_sha256: null,
      provider_request_id: null,
      failure_code: null,
      last_error: null,
      requested_at: "2026-08-01T00:00:00Z",
      started_at: null,
      completed_at: null,
      updated_at: "2026-08-01T00:00:00Z"
    };
    const db = {
      prepare(query: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            values = bound;
            statements.push({ query, values });
            return this;
          },
          async all() {
            if (query.includes("FROM episodes episode")) {
              return {
                results: inserted ? [] : [{
                  episode_id: "episode_fixture",
                  current_master_id: source.current_master_id,
                  source_language: source.source_language
                }]
              };
            }
            return { results: [] };
          },
          async first() {
            if (query.includes("FROM transcription_jobs job")) {
              return inserted ? { ...job } : null;
            }
            if (query.includes("episode.show_id")) return { ...source };
            return null;
          },
          async run() {
            if (query.includes("INSERT OR IGNORE INTO transcription_jobs")) {
              if (inserted) return { success: true, meta: { changes: 0 } };
              inserted = true;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          }
        };
        return statement;
      },
      async batch(batch: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(batch.map((statement) => statement.run()));
      }
    } as unknown as D1Database;
    const env = {
      ENVIRONMENT: "staging",
      DB: db,
      JOBS: {
        async send() {
          queueMessages += 1;
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticTranscriptionJobs(env)).toBe(1);
    expect(await scheduleAutomaticTranscriptionJobs(env)).toBe(0);
    expect(queueMessages).toBe(0);
    const insertion = statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO transcription_jobs")
    );
    expect(insertion?.values[0]).toMatch(/^transcription_[a-f0-9]{32}$/);
    expect(insertion?.values[1]).toMatch(
      /^transcription_auto_[a-f0-9]{32}$/
    );
    const settings = insertion?.values.find((value) =>
      typeof value === "string"
      && value.includes("workers-ai-segment-caption-v2")
    );
    expect(JSON.parse(String(settings))).toMatchObject({
      schemaVersion: 2,
      pipelineVersion: "workers-ai-segment-caption-v2",
      captionSegmentationPolicy: {
        minimumCueDurationMs: 500,
        maximumCueDurationMs: 10_000,
        maximumCharactersPerSecond: 25,
        maximumCharactersPerCue: 160
      }
    });
    expect(insertion?.values.at(-1)).toBeNull();
    const audit = statements.find(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    );
    expect(audit?.values[1]).toBeNull();
    expect(JSON.parse(String(audit?.values[5]))).toMatchObject({
      automated: true,
      episodeId: "episode_fixture",
      workingMasterId: source.working_master_id,
      language: "es"
    });
  });

  it("does not inspect production state", async () => {
    const env = {
      ENVIRONMENT: "production",
      DB: {
        prepare() {
          throw new Error("production database must not be read");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticTranscriptionJobs(env)).toBe(0);
  });

  it("fails a staging scan closed", async () => {
    const env = {
      ENVIRONMENT: "staging",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticTranscriptionJobs(env)).toBe(0);
  });
});
