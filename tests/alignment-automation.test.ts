import { describe, expect, it } from "vitest";

import {
  AUTOMATED_ALIGNMENT_CANDIDATES_SQL,
  scheduleAutomaticAlignmentJobs
} from "../src/alignment-jobs";
import type { PodcastEnv } from "../src/env";

describe("automatic word-alignment queueing", () => {
  it("creates one system-owned exact-revision job for an approved transcript", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    let inserted = false;
    const source = {
      transcript_id: "transcript_fixture",
      episode_id: "episode_fixture",
      show_id: "show_fixture",
      language: "es",
      transcript_status: "approved",
      transcript_revision: 2,
      approved_revision: 2,
      transcript_content_json: JSON.stringify({
        schemaVersion: 1,
        language: "es",
        cues: [
          {
            id: "cue_1",
            startsAtMs: 0,
            endsAtMs: 2_000,
            speakerLabel: "Jay",
            speakerConfirmed: true,
            textMarkdown: "Ópera en la Selva"
          }
        ]
      }),
      transcript_content_sha256: "b".repeat(64),
      current_master_id: "master_fixture",
      working_master_id: "master_fixture",
      source_object_key:
        "podcasts/show_fixture/episode_fixture/working_masters/"
        + "master_fixture/master.wav",
      source_object_bytes: 4_000_000,
      source_object_etag: "source-etag",
      source_mime_type: "audio/wav",
      source_audio_sha256: "a".repeat(64),
      source_duration_ms: 180_000
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
            if (query === AUTOMATED_ALIGNMENT_CANDIDATES_SQL) {
              return {
                results: inserted ? [] : [{
                  episode_id: source.episode_id,
                  current_master_id: source.current_master_id,
                  transcript_id: source.transcript_id,
                  transcript_revision: source.transcript_revision,
                  transcript_content_sha256:
                    source.transcript_content_sha256,
                  language: source.language
                }]
              };
            }
            return { results: [] };
          },
          async first() {
            if (query.includes("transcript.id AS transcript_id")) {
              return { ...source };
            }
            if (query.includes("FROM transcript_alignment_jobs job")) {
              return inserted ? { status: "queued" } : null;
            }
            return null;
          },
          async run() {
            if (query.includes("INSERT OR IGNORE INTO transcript_alignment_jobs")) {
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
      FEED_ORIGIN:
        "https://dust-wave-podcast-staging.jogo.workers.dev",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_fixture",
      DB: db
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticAlignmentJobs(env)).toBe(1);
    expect(await scheduleAutomaticAlignmentJobs(env)).toBe(0);
    const candidate = statements.find(({ query }) =>
      query === AUTOMATED_ALIGNMENT_CANDIDATES_SQL
    );
    expect(candidate?.values).toEqual([
      "whisperx",
      "3.8.6",
      "default",
      "default-en-es-v1",
      "whisperx-align-v1",
      "e611801d2af82dcdb079444b7e8a7eea4309d1a6",
      "sha256:8a7cda2702487a1d542d5fb740efe8580ca9edd99f405d722d610536c73a3a11",
      10
    ]);
    const insertion = statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO transcript_alignment_jobs")
    );
    expect(insertion?.values[0]).toMatch(/^alignment_job_[a-f0-9]{32}$/);
    expect(insertion?.values[1]).toMatch(/^alignment_auto_[a-f0-9]{32}$/);
    expect(insertion?.values.at(-1)).toBeNull();
    const audit = statements.find(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    );
    expect(audit?.values[1]).toBeNull();
    expect(JSON.parse(String(audit?.values[5]))).toMatchObject({
      automated: true,
      episodeId: source.episode_id,
      transcriptId: source.transcript_id,
      transcriptRevision: source.transcript_revision,
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

    expect(await scheduleAutomaticAlignmentJobs(env)).toBe(0);
  });

  it("fails a staging scan closed", async () => {
    const env = {
      ENVIRONMENT: "staging",
      FEED_ORIGIN:
        "https://dust-wave-podcast-staging.jogo.workers.dev",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_fixture",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomaticAlignmentJobs(env)).toBe(0);
  });
});
