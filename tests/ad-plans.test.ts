import {
  hmacSha256,
  sha256Hex
} from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  approveAdminEpisodeAdPlan,
  completeEpisodeAdPlanProcessing,
  submitAdminEpisodeAdPlan
} from "../src/ad-plans";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

const sessionSecret = "ad-plan-session-secret";
const processorSecret = "ad-plan-processor-secret";
const csrfToken = "ad-plan-csrf-token";
const streamProfile = "mp3-44100-stereo-cbr128-frame-v1";

describe("episode ad plans", () => {
  it("submits marker intent without changing active markers or segments", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await adPlanEnvironment({ writes });
    const response = await submitAdminEpisodeAdPlan(
      authenticatedJson("/v1/admin/episodes/episode-fixture/ad-plan", {
        streamProfile,
        markers: [
          { position: "pre" },
          { position: "mid", startsAtMs: 1_500 },
          { position: "post" }
        ]
      }),
      env,
      "episode-fixture"
    );
    const payload = await response.json() as {
      planId: string;
      revision: number;
      status: string;
      outputPrefix: string;
    };

    expect(response.status).toBe(202);
    expect(payload.planId).toMatch(/^adplan_[a-f0-9]{32}$/);
    expect(payload.revision).toBe(1);
    expect(payload.status).toBe("pending_processor");
    expect(payload.outputPrefix).toBe(
      `podcasts/show-1/episode-fixture/ad-plans/${payload.planId}`
    );
    expect(
      writes.some(({ query }) => query.includes("INSERT INTO episode_ad_plans"))
    ).toBe(true);
    expect(
      writes.some(({ query }) =>
        query.includes("INSERT INTO episode_ad_markers")
        || query.includes("INSERT INTO episode_audio_segments")
      )
    ).toBe(false);
    expect(
      writes.find(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )?.values
    ).toContain("episode_ad_plan.submitted");
  });

  it("accepts only signed processor evidence for frame-bounded R2 objects", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const plan = adPlanRow({ status: "pending_processor" });
    const segment = segmentManifest(plan.id);
    const env = await adPlanEnvironment({
      writes,
      plan,
      objectSizes: { [segment.objectKey]: segment.objectBytes }
    });
    const body = {
      processorVersion: "ffmpeg-7.1-dustwave-1",
      source: {
        objectKey: plan.source_object_key,
        objectBytes: plan.source_object_bytes,
        etag: plan.source_object_etag
      },
      segments: [segment],
      report: { decoderErrors: 0, fullDecode: true }
    };
    const request = await signedProcessorRequest(plan.id, body);
    const response = await completeEpisodeAdPlanProcessing(
      request,
      env,
      plan.id
    );
    const payload = await response.json() as {
      status: string;
      segmentCount: number;
      manifestSha256: string;
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("needs_review");
    expect(payload.segmentCount).toBe(1);
    expect(payload.manifestSha256).toBe(
      await sha256Hex(JSON.stringify([segment]))
    );
    const update = writes.find(({ query }) =>
      query.includes("status = 'needs_review'")
    );
    expect(update?.values).toContain("ffmpeg-7.1-dustwave-1");
  });

  it("rejects processor callbacks before a database lookup when the signature is invalid", async () => {
    const env = {
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: processorSecret,
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const response = await completeEpisodeAdPlanProcessing(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/ad-plans/adplan-fixture/complete",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-podcast-processor-timestamp": String(
              Math.floor(Date.now() / 1_000)
            ),
            "x-podcast-processor-signature": "invalid"
          },
          body: "{}"
        }
      ),
      env,
      "adplan-fixture"
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_processor_signature"
    });
  });

  it("atomically promotes reviewed markers and segments without enabling runtime ads", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
    const plan = adPlanRow({ status: "needs_review" });
    const segment = segmentManifest(plan.id);
    plan.segment_manifest_json = JSON.stringify([segment]);
    plan.processor_manifest_sha256 = await sha256Hex(
      plan.segment_manifest_json
    );
    const env = await adPlanEnvironment({
      writes,
      batches,
      plan,
      objectSizes: { [segment.objectKey]: segment.objectBytes }
    });
    const response = await approveAdminEpisodeAdPlan(
      authenticatedJson(
        `/v1/admin/ads/plans/${plan.id}/approve`,
        {}
      ),
      env,
      plan.id
    );
    const payload = await response.json() as {
      status: string;
      markerCount: number;
      segmentCount: number;
      runtimeEnabled: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "approved",
      markerCount: 1,
      segmentCount: 1,
      runtimeEnabled: false
    });
    expect(batches).toHaveLength(1);
    expect(
      batches[0].some(({ query }) =>
        query.includes("DELETE FROM episode_ad_markers")
      )
    ).toBe(true);
    expect(
      batches[0].some(({ query }) =>
        query.includes("INSERT INTO episode_audio_segments")
        && query.includes("'ready'")
      )
    ).toBe(true);
    expect(
      batches[0].some(({ query }) =>
        query.includes("dynamic_ads_enabled")
      )
    ).toBe(false);
    expect(
      batches[0].find(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )?.values
    ).toContain("episode_ad_plan.approved");
  });
});

function authenticatedJson(
  path: string,
  body: Record<string, unknown>
): Request {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=ad-plan-session-token`,
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

async function signedProcessorRequest(
  planId: string,
  body: Record<string, unknown>
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    processorSecret,
    "hex"
  );
  return new Request(
    `https://feeds.dustwave.xyz/v1/processor/ad-plans/${planId}/complete`,
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

async function adPlanEnvironment({
  writes,
  batches = [],
  plan = null,
  objectSizes = {}
}: {
  writes: Array<{ query: string; values: unknown[] }>;
  batches?: Array<Array<{ query: string; values: unknown[] }>>;
  plan?: ReturnType<typeof adPlanRow> | null;
  objectSizes?: Record<string, number>;
}): Promise<PodcastEnv> {
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        get values() {
          return values;
        },
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin-fixture",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT p.*, e.show_id")) return plan;
          if (query.includes("COALESCE(MAX(revision)")) {
            return { revision: 0 };
          }
          if (query.includes("SELECT duration_seconds FROM episodes")) {
            return { duration_seconds: 3 };
          }
          if (query.includes("FROM episodes")) return episodeSource();
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return { results: [{ role: "producer", show_id: "show-1" }] };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      batches.push(
        statements.map((statement) => ({
          query: statement.query,
          values: [...statement.values]
        }))
      );
      return statements.map(() => ({
        success: true,
        meta: { changes: 1 }
      }));
    }
  } as unknown as D1Database;
  const bucket = {
    async head(key: string) {
      if (key === episodeSource().audio_key) {
        return {
          size: episodeSource().audio_bytes,
          httpEtag: episodeSource().audio_etag
        };
      }
      const size = objectSizes[key];
      return size ? { size } : null;
    }
  } as unknown as R2Bucket;
  return {
    DB: db,
    MEDIA_BUCKET: bucket,
    MEDIA_KEY_PREFIX: "podcasts/",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    SITE_ORIGIN: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret,
    MEDIA_PROCESSOR_CALLBACK_SECRET: processorSecret
  } as unknown as PodcastEnv;
}

function episodeSource(): Record<string, unknown> {
  return {
    id: "episode-fixture",
    show_id: "show-1",
    duration_seconds: 3,
    audio_key: "podcasts/show-1/episode-fixture/delivery.mp3",
    audio_bytes: 48_000,
    audio_etag: '"source-etag"',
    audio_mime_type: "audio/mpeg",
    media_status: "ready"
  };
}

function adPlanRow({
  status
}: {
  status: "pending_processor" | "needs_review";
}) {
  return {
    id: "adplan-fixture",
    episode_id: "episode-fixture",
    show_id: "show-1",
    revision: 1,
    status,
    source_object_key:
      "podcasts/show-1/episode-fixture/delivery.mp3",
    source_object_bytes: 48_000,
    source_object_etag: '"source-etag"',
    source_audio_mime_type: "audio/mpeg",
    stream_profile: streamProfile,
    marker_manifest_json: JSON.stringify([
      { position: "pre", startsAtMs: null }
    ]),
    segment_manifest_json: null as string | null,
    processor_report_json: null,
    processor_manifest_sha256: null as string | null,
    processor_version: null,
    submitted_at: "2026-07-24T12:00:00.000Z",
    processor_completed_at: null,
    reviewed_at: null,
    rejection_reason: null
  };
}

function segmentManifest(planId: string) {
  const frameCount = 115;
  return {
    id: "segment-fixture-0",
    sequence: 0,
    objectKey:
      `podcasts/show-1/episode-fixture/ad-plans/${planId}/program-0.mp3`,
    objectBytes: frameCount * 417,
    sourceOffset: 0,
    byteLength: frameCount * 417,
    audioMimeType: "audio/mpeg",
    streamProfile,
    sha256: "a".repeat(64),
    durationMs: Math.round((frameCount * 1_152 * 1_000) / 44_100),
    frameCount
  };
}
