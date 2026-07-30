import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  createAdminAdCreative,
  uploadAdminAdCreativeAudio,
  validateAdminAdCreative
} from "../src/ad-creatives";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

const sessionSecret = "creative-session-secret";
const csrfToken = "creative-csrf-token";

describe("admin sponsor creative audio", () => {
  it("streams, verifies, and validates a creative before it can be approved", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await creativeEnvironment(writes);
    const createResponse = await createAdminAdCreative(
      jsonRequest("/v1/admin/ads/campaigns/campaign-fixture/creatives", {
        name: "Launch spot",
        filename: "launch-spot.mp3",
        durationSeconds: 3,
        weight: 2
      }),
      env,
      "campaign-fixture"
    );
    const created = await createResponse.json() as {
      creativeId: string;
      validationStatus: string;
      upload: {
        path: string;
        lengthHeader: string;
        maximumBytes: number;
      };
    };

    expect(createResponse.status).toBe(201);
    expect(created.creativeId).toMatch(/^creative_[a-f0-9]{32}$/);
    expect(created.validationStatus).toBe("pending");
    expect(created.upload.lengthHeader).toBe("x-podcast-upload-bytes");
    expect(created.upload.maximumBytes).toBe(25 * 1024 * 1024);

    const audio = mp3Frames(100);
    const uploadResponse = await uploadAdminAdCreativeAudio(
      authenticatedRequest(created.upload.path, {
        method: "PUT",
        headers: {
          "content-type": "audio/mpeg",
          "x-podcast-upload-bytes": String(audio.byteLength)
        },
        body: audio
      }),
      env,
      created.creativeId
    );
    const uploaded = await uploadResponse.json() as {
      uploaded: boolean;
      bytes: number;
      validationStatus: string;
    };

    expect(uploadResponse.status).toBe(200);
    expect(uploaded).toMatchObject({
      uploaded: true,
      bytes: audio.byteLength,
      validationStatus: "pending"
    });
    expect(
      writes.find(({ query }) =>
        query.includes("audio_key = ?")
      )?.values[0]
    ).toMatch(
      new RegExp(
        `^podcasts/show-1/ads/campaign-fixture/${created.creativeId}/upload_[a-f0-9]{32}\\.mp3$`
      )
    );

    const validateResponse = await validateAdminAdCreative(
      jsonRequest(
        `/v1/admin/ads/creatives/${created.creativeId}/validate`,
        {}
      ),
      env,
      created.creativeId
    );
    const validated = await validateResponse.json() as {
      validationStatus: string;
      sha256: string;
      report: { frameCount: number; durationMs: number };
    };

    expect(validateResponse.status).toBe(200);
    expect(validated.validationStatus).toBe("ready");
    expect(validated.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.report).toMatchObject({
      frameCount: 100,
      durationMs: 2_612
    });
    expect(
      writes.filter(({ query }) =>
        query.includes("approval_status = 'draft'")
      )
    ).toHaveLength(3);
    expect(
      writes
        .filter(({ query }) => query.includes("INSERT INTO admin_audit_events"))
        .map(({ values }) => values)
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["ad_creative.created"]),
        expect.arrayContaining(["ad_creative.uploaded"]),
        expect.arrayContaining(["ad_creative.validated"])
      ])
    );
  });

  it("rejects an upload whose streamed size differs from its declared size", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await creativeEnvironment(writes, {
      initialCreative: {
        id: "creative-fixture",
        objectKey: "podcasts/show-1/ads/campaign-fixture/creative-fixture.mp3"
      }
    });
    const audio = mp3Frames(1);
    const response = await uploadAdminAdCreativeAudio(
      authenticatedRequest(
        "/v1/admin/ads/creatives/creative-fixture/audio",
        {
          method: "PUT",
          headers: {
            "content-type": "audio/mpeg",
            "x-podcast-upload-bytes": String(audio.byteLength + 1)
          },
          body: audio
        }
      ),
      env,
      "creative-fixture"
    ).catch((error: unknown) => error);

    expect(response).toMatchObject({
      code: "creative_size_mismatch",
      status: 409
    });
  });
});

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return authenticatedRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function authenticatedRequest(path: string, init: RequestInit): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${ADMIN_SESSION_COOKIE}=creative-session-token`);
  headers.set("origin", "https://dustwave.xyz");
  headers.set("x-podcast-csrf", csrfToken);
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    ...init,
    headers
  });
}

async function creativeEnvironment(
  writes: Array<{ query: string; values: unknown[] }>,
  {
    initialCreative
  }: {
    initialCreative?: { id: string; objectKey: string };
  } = {}
): Promise<PodcastEnv> {
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  let creative = initialCreative
    ? {
        id: initialCreative.id,
        campaignId: "campaign-fixture",
        objectKey: initialCreative.objectKey,
        audioBytes: null as number | null,
        audioMimeType: null as string | null,
        streamProfile: "mp3-44100-stereo-cbr128-frame-v1",
        validationStatus: "pending",
        durationSeconds: 3
      }
    : null;
  const objects = new Map<string, Uint8Array>();
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
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
          if (query.includes("FROM ad_campaigns c") && !query.includes("JOIN ad_creatives")) {
            return campaignScope();
          }
          if (query.includes("FROM ad_creatives a")) {
            if (!creative || values[0] !== creative.id) return null;
            return {
              id: creative.id,
              campaign_id: creative.campaignId,
              show_id: "show-1",
              campaign_active: 1,
              kill_switch_at: null,
              object_key: creative.objectKey,
              audio_bytes: creative.audioBytes,
              audio_mime_type: creative.audioMimeType,
              stream_profile: creative.streamProfile,
              validation_status: creative.validationStatus,
              duration_seconds: creative.durationSeconds
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "admin", show_id: "show-1" }]
            };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          if (query.includes("INSERT INTO ad_creatives")) {
            creative = {
              id: String(values[0]),
              campaignId: String(values[1]),
              objectKey: String(values[3]),
              audioBytes: null,
              audioMimeType: null,
              streamProfile: String(values[6]),
              validationStatus: "pending",
              durationSeconds: Number(values[4])
            };
          } else if (query.includes("audio_bytes = ?")) {
            if (creative) {
              creative.objectKey = String(values[0]);
              creative.audioBytes = Number(values[1]);
              creative.audioMimeType = "audio/mpeg";
              creative.streamProfile = String(values[3]);
              creative.validationStatus = "pending";
            }
          } else if (query.includes("validation_status = 'ready'")) {
            if (creative) creative.validationStatus = "ready";
          } else if (query.includes("validation_status = 'failed'")) {
            if (creative) creative.validationStatus = "failed";
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  } as unknown as D1Database;
  const bucket = {
    async put(key: string, value: ReadableStream) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return {
        size: bytes.byteLength,
        httpEtag: `"fixture-etag"`
      };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        async arrayBuffer() {
          return bytes.slice().buffer;
        }
      };
    },
    async delete(key: string) {
      objects.delete(key);
    }
  } as unknown as R2Bucket;
  return {
    DB: db,
    MEDIA_BUCKET: bucket,
    MEDIA_KEY_PREFIX: "podcasts/",
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret
  } as unknown as PodcastEnv;
}

function campaignScope(): Record<string, unknown> {
  return {
    id: "campaign-fixture",
    show_id: "show-1",
    campaign_type: "direct",
    sponsor_active: 1,
    name: "Campaign fixture",
    starts_at: "2026-08-01T00:00:00.000Z",
    ends_at: "2026-09-01T00:00:00.000Z",
    kill_switch_at: null,
    priority: 10,
    impression_cap: null,
    qualified_impression_goal: 1_000,
    pacing_strategy: "even",
    billing_model: "flat_fee",
    contract_amount_cents: 50_000,
    cpm_cents: null,
    active: 1,
    approval_status: "draft",
    revision: 1
  };
}

function mp3Frames(count: number): Uint8Array {
  const frameLength = 417;
  const bytes = new Uint8Array(frameLength * count);
  for (let index = 0; index < count; index += 1) {
    bytes.set([0xff, 0xfb, 0x90, 0x40], index * frameLength);
  }
  return bytes;
}
