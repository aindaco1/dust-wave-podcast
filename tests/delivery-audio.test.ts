import { describe, expect, it } from "vitest";

import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import {
  approveAdminDeliveryAudioJob,
  completeDeliveryAudioJob,
  listAdminDeliveryAudioJobs,
  queueAdminDeliveryAudioJob,
  scheduleAutomatedDeliveryAudioJobs,
  uploadDeliveryAudioProcessorPart
} from "../src/delivery-audio";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("delivery-audio and player-peaks boundaries", () => {
  it("keeps listing and approval private without an admin session", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz"
    } as unknown as PodcastEnv;
    const list = await listAdminDeliveryAudioJobs(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs"
      ),
      env,
      "episode_fixture"
    );
    const approve = await approveAdminDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "delivery-audio-jobs/delivery_fixture/approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "delivery_fixture"
    );

    expect(list.status).toBe(401);
    expect(approve.status).toBe(401);
    expect(list.headers.get("cache-control")).toContain("private");
    expect(await list.json()).toEqual({ error: "unauthorized" });
  });

  it("hides queueing outside isolated staging", async () => {
    const response = await queueAdminDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs",
        { method: "POST" }
      ),
      {
        ENVIRONMENT: "production",
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      "episode_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "delivery_audio_job_not_found"
    });
  });

  it("trusts an atomic guard-protected approval over D1 metadata", async () => {
    const fixture = await deliveryApprovalFixture();
    const response = await approveAdminDeliveryAudioJob(
      fixture.request({
        workingMasterId: "master_fixture",
        approvalReason:
          "The exact delivery bytes passed full-file validation."
      }),
      fixture.env,
      "delivery_fixture"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      job: {
        id: "delivery_fixture",
        status: "approved",
        approval: { approvedCurrent: true }
      }
    });
    expect(fixture.batchCount()).toBe(1);
    expect(
      fixture.queries.filter((query) =>
        query.includes("INSERT INTO publication_batch_guards")
      )
    ).toHaveLength(2);
  });

  it("queues one deterministic delivery render after the final master decision", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    let inserted = false;
    let multipartCreates = 0;
    const source = {
      episode_id: "episode_fixture",
      show_id: "show_fixture",
      current_master_id: "master_fixture",
      source_object_key:
        "podcasts/show_fixture/episode_fixture/working_masters/"
        + "master_fixture/master.wav",
      source_object_bytes: 4_000_000,
      source_object_etag: "\"source-etag\"",
      source_mime_type: "audio/wav",
      source_sha256: "a".repeat(64),
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
            if (query.includes("FROM episodes episode")) {
              return {
                results: inserted ? [] : [{
                  episode_id: source.episode_id,
                  current_master_id: source.current_master_id,
                  automated_attempt_count: 0
                }]
              };
            }
            return { results: [] };
          },
          async first() {
            if (query.includes("master.object_key AS source_object_key")) {
              return { ...source };
            }
            return null;
          },
          async run() {
            if (query.includes("INSERT OR IGNORE INTO delivery_audio_jobs")) {
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
      DB: db,
      ENVIRONMENT: "staging",
      FEED_ORIGIN:
        "https://dust-wave-podcast-staging.jogo.workers.dev",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_fixture",
      MEDIA_BUCKET: {
        async head() {
          return {
            size: source.source_object_bytes,
            httpEtag: source.source_object_etag,
            httpMetadata: { contentType: source.source_mime_type }
          };
        },
        async createMultipartUpload() {
          multipartCreates += 1;
          return {
            uploadId: "multipart_fixture",
            async abort() {}
          };
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomatedDeliveryAudioJobs(env)).toBe(1);
    expect(await scheduleAutomatedDeliveryAudioJobs(env)).toBe(0);
    expect(multipartCreates).toBe(1);
    const insertion = statements.find(({ query }) =>
      query.includes("INSERT OR IGNORE INTO delivery_audio_jobs")
    );
    expect(insertion?.values[0]).toMatch(
      /^delivery_audio_auto_[a-f0-9]{32}$/
    );
    expect(insertion?.values.at(-1)).toBeNull();
    const audit = statements.find(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    );
    expect(audit?.values[1]).toBeNull();
    expect(JSON.parse(String(audit?.values[5]))).toMatchObject({
      automated: true,
      automatedAttempt: 1,
      episodeId: source.episode_id,
      sourceMasterId: source.current_master_id
    });
  });

  it("fails a delivery automation scan closed without throwing", async () => {
    const env = {
      ENVIRONMENT: "staging",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_fixture",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomatedDeliveryAudioJobs(env)).toBe(0);
  });

  it("does not inspect production state for automatic delivery renders", async () => {
    const env = {
      ENVIRONMENT: "production",
      DB: {
        prepare() {
          throw new Error("production database must not be read");
        }
      }
    } as unknown as PodcastEnv;

    expect(await scheduleAutomatedDeliveryAudioJobs(env)).toBe(0);
  });

  it("rejects unsigned completion and parts before database access", async () => {
    const env = {
      ENVIRONMENT: "staging",
      FEED_ORIGIN:
        "https://dust-wave-podcast-staging.jogo.workers.dev",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: "processor-secret",
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const completion = await completeDeliveryAudioJob(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "delivery-audio-jobs/delivery_fixture/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "delivery_fixture"
    );
    const part = await uploadDeliveryAudioProcessorPart(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "delivery-audio-jobs/delivery_fixture/parts/1",
        { method: "PUT", body: "not-audio" }
      ),
      env,
      "delivery_fixture",
      "1"
    );

    expect(completion.status).toBe(401);
    expect(part.status).toBe(401);
    expect(await completion.json()).toEqual({
      error: "invalid_processor_signature"
    });
    expect(await part.json()).toEqual({
      error: "invalid_processor_signature"
    });
  });

  it("routes public peaks and rejects unsupported admin methods", async () => {
    const admin = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/delivery-audio-jobs",
        { method: "DELETE" }
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv
    );
    const publicPeaks = await handleRequest(
      new Request(
        "https://media.dustwave.xyz/episodes/episode_fixture/peaks"
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return null;
                  }
                };
              }
            };
          }
        }
      } as unknown as PodcastEnv
    );

    expect(admin.status).toBe(405);
    expect(publicPeaks.status).toBe(404);
    expect(publicPeaks.headers.get("cache-control")).toBe("no-store");
  });
});

async function deliveryApprovalFixture() {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  const queries: string[] = [];
  let batches = 0;
  const job = {
    id: "delivery_fixture",
    episode_id: "episode_fixture",
    show_id: "show_fixture",
    episode_slug: "episode-fixture",
    source_master_id: "master_fixture",
    source_object_key: "private/master.mp3",
    source_object_bytes: 4_000_000,
    source_object_etag: '"source-etag"',
    source_mime_type: "audio/mpeg",
    source_sha256: "1".repeat(64),
    source_duration_ms: 180_000,
    stream_profile: "mp3-44100-stereo-cbr128-frame-v1",
    output_object_key: "private/delivery.mp3",
    r2_upload_id: "r2_fixture",
    peaks_object_key: "private/delivery.peaks.json",
    processor_manifest_sha256: "2".repeat(64),
    status: "ready",
    output_object_bytes: 3_000_000,
    output_object_etag: '"output-etag"',
    output_sha256: "3".repeat(64),
    output_duration_ms: 180_000,
    peaks_object_bytes: 10_000,
    peaks_object_etag: '"peaks-etag"',
    peaks_sha256: "4".repeat(64),
    peaks_length: 1_024,
    processor_version: "delivery-fixture",
    processor_report_json: "{}",
    processor_report_sha256: "5".repeat(64),
    failure_code: null,
    requested_by_admin_user_id: "admin_fixture",
    requested_at: "2026-08-01T12:00:00.000Z",
    completed_at: "2026-08-01T12:05:00.000Z",
    approved_at: null as string | null,
    approval_reason: null as string | null,
    current_master_id: "master_fixture",
    current_audio_key: null as string | null,
    current_audio_bytes: null as number | null,
    current_audio_etag: null as string | null
  };
  const db = {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return { recent: 1 };
          }
          if (query.includes("FROM delivery_audio_jobs job")) {
            return { ...job };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("UPDATE episodes")) {
            job.current_audio_key = String(values[0]);
            job.current_audio_bytes = Number(values[1]);
            job.current_audio_etag = String(values[2]);
          }
          if (query.includes("UPDATE delivery_audio_jobs")) {
            job.status = "approved";
            job.approval_reason = String(values[1]);
            job.approved_at = "2026-08-01T12:10:00.000Z";
          }
          return { success: true, meta: { changes: 0 } };
        }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      batches += 1;
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret,
    MEDIA_BUCKET: {
      async head(key: string) {
        if (key === job.output_object_key) {
          return {
            size: job.output_object_bytes,
            httpEtag: job.output_object_etag,
            httpMetadata: { contentType: "audio/mpeg" },
            customMetadata: {
              "processor-manifest-sha256":
                job.processor_manifest_sha256,
              "stream-profile": job.stream_profile
            }
          };
        }
        return {
          size: job.peaks_object_bytes,
          httpEtag: job.peaks_object_etag,
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            jobId: job.id,
            "processor-manifest-sha256":
              job.processor_manifest_sha256,
            "peaks-sha256": job.peaks_sha256
          }
        };
      }
    }
  } as unknown as PodcastEnv;
  return {
    env,
    queries,
    batchCount: () => batches,
    request(body: Record<string, unknown>) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
          + "delivery-audio-jobs/delivery_fixture/approve",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            "x-podcast-csrf": csrfToken
          },
          body: JSON.stringify(body)
        }
      );
    }
  };
}
