import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import {
  approveAdminAudioEnhancementDerivative,
  completeAudioEnhancementDerivative,
  listAdminAudioEnhancementDerivatives,
  queueAdminAudioEnhancementDerivative,
  rejectAdminAudioEnhancementDerivative,
  uploadAudioEnhancementDerivativeProcessorPart
} from "../src/audio-enhancement-derivatives";
import { handleRequest } from "../src/app";
import { prepareAdminAuditAfterSingleChange } from "../src/audit";
import type { PodcastEnv } from "../src/env";

describe("full-length audio enhancement derivative boundaries", () => {
  it("keeps list and approval private without an admin session", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz"
    } as unknown as PodcastEnv;
    const list = await listAdminAudioEnhancementDerivatives(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives"
      ),
      env,
      "episode_fixture"
    );
    const approve = await approveAdminAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "audio-enhancement-derivatives/derivative_fixture/approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "derivative_fixture"
    );
    const reject = await rejectAdminAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "audio-enhancement-derivatives/derivative_fixture/reject",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "derivative_fixture"
    );

    expect(list.status).toBe(401);
    expect(approve.status).toBe(401);
    expect(reject.status).toBe(401);
    expect(list.headers.get("cache-control")).toContain("private");
    expect(await list.json()).toEqual({ error: "unauthorized" });
  });

  it("hides queueing outside isolated staging", async () => {
    const response = await queueAdminAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives",
        { method: "POST" }
      ),
      {
        ENVIRONMENT: "production",
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      "episode_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
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
    const completion = await completeAudioEnhancementDerivative(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "audio-enhancement-derivatives/derivative_fixture/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      env,
      "derivative_fixture"
    );
    const part = await uploadAudioEnhancementDerivativeProcessorPart(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/"
        + "audio-enhancement-derivatives/"
        + "derivative_fixture/parts/1",
        { method: "PUT", body: "not-audio" }
      ),
      env,
      "derivative_fixture",
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

  it("routes derivative endpoints and rejects unsupported methods", async () => {
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/"
        + "episode_fixture/audio-enhancement-derivatives",
        { method: "DELETE" }
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "method_not_allowed"
    });
  });

  it("routes derivative rejection and keeps it private", async () => {
    const response = await handleRequest(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
        + "audio-enhancement-derivatives/derivative_fixture/reject",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects exact evidence without changing the working master", async () => {
    const fixture = await rejectionFixture();
    const first = await rejectAdminAudioEnhancementDerivative(
      fixture.request({
        baseRevision: 1,
        rejectionReason:
          "The original master is the stronger editorial choice.",
        acknowledgeExactDerivative: true
      }),
      fixture.env,
      "derivative_fixture"
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      derivative: {
        id: "derivative_fixture",
        status: "rejected",
        rejectionReason:
          "The original master is the stronger editorial choice."
      },
      idempotent: false
    });
    expect(fixture.row.status).toBe("stale");
    expect(fixture.row.current_master_id).toBe("master_fixture");
    expect(
      fixture.queries.some((query) =>
        query.includes("UPDATE episode_working_master_states")
      )
    ).toBe(false);
    expect(fixture.auditActions()).toEqual([
      "audio_enhancement_derivative.rejected"
    ]);

    const retry = await rejectAdminAudioEnhancementDerivative(
      fixture.request({
        baseRevision: 1,
        rejectionReason:
          "The original master is the stronger editorial choice.",
        acknowledgeExactDerivative: true
      }),
      fixture.env,
      "derivative_fixture"
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      derivative: { status: "rejected" },
      idempotent: true
    });
    expect(fixture.batchCount()).toBe(1);
  });

  it("trusts a resolved guard-protected approval batch over D1 metadata", async () => {
    const fixture = await rejectionFixture();
    const response = await approveAdminAudioEnhancementDerivative(
      fixture.request({
        baseRevision: 1,
        masterId: "master_enhanced",
        approvalReason:
          "The exact enhanced candidate passed full-file review."
      }, "approve"),
      fixture.env,
      "derivative_fixture"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      master: {
        id: "master_enhanced",
        episodeId: "episode_fixture",
        revision: 2,
        originKind: "enhanced_derivative",
        sourceSha256: "8".repeat(64)
      }
    });
    expect(fixture.batchCount()).toBe(1);
    expect(
      fixture.queries.filter((query) =>
        query.includes("INSERT INTO publication_batch_guards")
      )
    ).toHaveLength(2);
  });

  it("requires recent authentication before either terminal choice", async () => {
    const fixture = await rejectionFixture({ recent: false });
    const body = {
      baseRevision: 1,
      rejectionReason:
        "The original master is the stronger editorial choice.",
      acknowledgeExactDerivative: true
    };
    const reject = await rejectAdminAudioEnhancementDerivative(
      fixture.request(body),
      fixture.env,
      "derivative_fixture"
    );
    const approve = await approveAdminAudioEnhancementDerivative(
      fixture.request({
        baseRevision: 1,
        masterId: "master_enhanced",
        approvalReason: "The enhanced candidate is approved."
      }, "approve"),
      fixture.env,
      "derivative_fixture"
    );

    expect(reject.status).toBe(403);
    expect(approve.status).toBe(403);
    expect(await reject.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(await approve.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(
      fixture.queries.some((query) =>
        query.includes("FROM audio_enhancement_derivatives derivative")
      )
    ).toBe(false);
    expect(fixture.batchCount()).toBe(0);
  });

  it("records lifecycle audits only after one guarded row changes", () => {
    let query = "";
    let values: unknown[] = [];
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return this;
      }
    };
    const db = {
      prepare(nextQuery: string) {
        query = nextQuery;
        return statement;
      }
    } as unknown as D1Database;

    expect(
      prepareAdminAuditAfterSingleChange(db, {
        adminUserId: null,
        action: "audio_enhancement_derivative.ready",
        targetType: "audio_enhancement_derivative",
        targetId: "derivative_fixture",
        metadata: { outputSha256: "a".repeat(64) }
      })
    ).toBe(statement);
    expect(query).toContain("WHERE changes() = ?");
    expect(values).toContain(1);
    expect(values).toContain("audio_enhancement_derivative.ready");
    expect(values).toContain("derivative_fixture");
    expect(values).toContain(null);
  });
});

async function rejectionFixture({ recent = true } = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  const queries: string[] = [];
  const audits: string[] = [];
  let batches = 0;
  const row = {
    id: "derivative_fixture",
    episode_id: "episode_fixture",
    show_id: "show_fixture",
    selected_preview_id: "preview_fixture",
    source_master_id: "master_fixture",
    source_upload_id: "upload_source_fixture",
    source_quality_control_run_id: "qc_source_fixture",
    source_object_key: "private/source.wav",
    source_object_bytes: 4_000_000,
    source_object_etag: "\"source-etag\"",
    source_mime_type: "audio/wav",
    source_sha256: "1".repeat(64),
    source_quality_control_report_sha256: "2".repeat(64),
    selected_preview_manifest_sha256: "3".repeat(64),
    selected_preview_report_sha256: "4".repeat(64),
    selected_preview_enhanced_sha256: "5".repeat(64),
    recipe_json: JSON.stringify({
      schemaVersion: "audio-enhancement-derivative-recipe-v1",
      presetId: "dialogue-gentle-v1",
      targetIntegratedLufs: -19,
      maximumTruePeakDbtp: -1
    }),
    recipe_sha256: "6".repeat(64),
    output_object_key: "private/derivative.mp3",
    r2_upload_id: "r2_fixture",
    processor_manifest_sha256: "7".repeat(64),
    status: "ready",
    output_upload_id: "upload_output_fixture",
    derivative_quality_control_run_id: "qc_output_fixture",
    output_object_bytes: 3_000_000,
    output_object_etag: "\"output-etag\"",
    output_sha256: "8".repeat(64),
    output_duration_ms: 180_000,
    processor_version: "fixture-processor",
    processor_report_json: "{}",
    processor_report_sha256: "9".repeat(64),
    failure_code: null,
    requested_by_admin_user_id: "admin_fixture",
    requested_at: "2026-07-29T12:00:00.000Z",
    completed_at: "2026-07-29T12:05:00.000Z",
    approved_at: null,
    approval_reason: null,
    rejected_by_admin_user_id: null as string | null,
    rejection_reason: null as string | null,
    rejected_at: null as string | null,
    current_master_id: "master_fixture",
    source_duration_ms: 180_000,
    quality_control_status: "succeeded",
    quality_control_policy_revision: 1,
    current_policy_revision: 1,
    quality_control_source_sha256: "8".repeat(64),
    quality_control_report_sha256: "a".repeat(64),
    quality_control_blocker_count: 0,
    quality_control_warning_count: 1,
    quality_control_completed_at: "2026-07-29T12:06:00.000Z"
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
            return recent ? { recent: 1 } : null;
          }
          if (
            query.includes(
              "FROM audio_enhancement_derivatives derivative"
            )
          ) {
            return { ...row };
          }
          if (query.includes("FROM episode_working_master_states")) {
            return {
              revision: 1,
              current_master_id: "master_fixture"
            };
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
          if (
            query.includes("UPDATE audio_enhancement_derivatives")
            && query.includes("rejected_by_admin_user_id")
          ) {
            row.status = "stale";
            row.rejected_by_admin_user_id = String(values[0]);
            row.rejection_reason = String(values[1]);
            row.rejected_at = "2026-07-29T12:10:00.000Z";
            return { success: true, meta: { changes: 1 } };
          }
          if (
            query.includes("INSERT INTO admin_audit_events")
            && values[2]
          ) {
            audits.push(String(values[2]));
            return { success: true, meta: { changes: 1 } };
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
    MEDIA_BUCKET: {
      async head() {
        return {
          key: row.output_object_key,
          size: row.output_object_bytes,
          httpEtag: row.output_object_etag,
          httpMetadata: { contentType: "audio/mpeg" },
          customMetadata: {
            "processor-manifest-sha256":
              row.processor_manifest_sha256
          }
        };
      }
    },
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret,
    ENVIRONMENT: "staging"
  } as unknown as PodcastEnv;
  return {
    env,
    row,
    queries,
    auditActions: () => audits,
    batchCount: () => batches,
    request(
      body: Record<string, unknown>,
      action: "approve" | "reject" = "reject"
    ) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/"
          + "audio-enhancement-derivatives/derivative_fixture/"
          + action,
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
