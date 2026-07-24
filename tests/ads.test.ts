import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { previewAdminAdDecision } from "../src/ads";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

const sessionSecret = "preview-session-secret";
const csrfToken = "preview-csrf-token";
const streamProfile = "mp3-44100-stereo-cbr128-frame-v1";

describe("admin sponsor decision preview", () => {
  it("selects current D1 inventory without persisting or enabling delivery", async () => {
    const writes: string[] = [];
    const env = await previewEnvironment("show-1", writes);
    const response = await previewAdminAdDecision(
      previewRequest(),
      env
    );
    const payload = await response.json() as {
      previewOnly: boolean;
      persisted: boolean;
      publicDeliveryMode: string;
      context: { appName: string };
      readiness: {
        markerApproved: boolean;
        programSegmentsReady: boolean;
        activationReadyExceptRuntime: boolean;
        blockers: string[];
      };
      inventory: { campaignCount: number; fingerprint: string };
      decision: {
        status: string;
        selection: { campaignId: string; creativeId: string };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.previewOnly).toBe(true);
    expect(payload.persisted).toBe(false);
    expect(payload.publicDeliveryMode).toBe("full_file_only");
    expect(payload.context.appName).toBe("apple_podcasts");
    expect(payload.readiness).toMatchObject({
      markerApproved: true,
      programSegmentsReady: true,
      activationReadyExceptRuntime: false
    });
    expect(payload.readiness.blockers).toEqual([
      "runtime_not_connected",
      "show_dynamic_ads_disabled",
      "episode_dynamic_ads_disabled"
    ]);
    expect(payload.inventory.campaignCount).toBe(1);
    expect(payload.inventory.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.decision).toMatchObject({
      status: "selected",
      selection: {
        campaignId: "campaign-direct",
        creativeId: "creative-direct"
      }
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("UPDATE admin_sessions");
    expect(writes[0]).not.toMatch(/ad_decisions|qualified_impressions/);
  });

  it("enforces show-scoped roles before loading sponsor inventory", async () => {
    const writes: string[] = [];
    const env = await previewEnvironment("show-other", writes);
    const response = await previewAdminAdDecision(previewRequest(), env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(writes).toHaveLength(1);
  });
});

function previewRequest(): Request {
  return new Request("https://feeds.dustwave.xyz/v1/admin/ads/preview", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=preview-session-token`,
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify({
      episodeId: "episode-1",
      position: "mid",
      deviceType: "mobile",
      appName: "Apple Podcasts",
      streamProfile,
      at: "2026-07-24T12:00:00.000Z"
    })
  });
}

async function previewEnvironment(
  roleShowId: string,
  writes: string[]
): Promise<PodcastEnv> {
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const db = {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin-fixture",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("FROM episodes e")) {
            return {
              id: "episode-1",
              show_id: "show-1",
              publication_revision: 4,
              episode_dynamic_ads_enabled: 0,
              show_dynamic_ads_enabled: 0
            };
          }
          if (query.includes("FROM episode_ad_markers")) {
            return { id: "marker-mid" };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{
                role: "analyst",
                show_id: roleShowId
              }]
            };
          }
          if (query.includes("FROM ad_campaigns c")) {
            return {
              results: [{
                id: "campaign-direct",
                campaign_type: "direct",
                sponsor_active: 1,
                approval_status: "approved",
                active: 1,
                starts_at: "2026-07-01T00:00:00.000Z",
                ends_at: "2026-08-01T00:00:00.000Z",
                kill_switch_at: null,
                priority: 10,
                impression_cap: 1_000,
                qualified_impression_goal: 750,
                qualified_impressions: 100,
                pacing_strategy: "even"
              }]
            };
          }
          if (query.includes("FROM ad_rules r")) {
            return {
              results: [{
                id: "rule-direct",
                campaign_id: "campaign-direct",
                show_id: "show-1",
                episode_id: "episode-1",
                position: "mid",
                device_type: "mobile",
                app_name: "apple_podcasts",
                starts_at: null,
                ends_at: null
              }]
            };
          }
          if (query.includes("FROM ad_creatives a")) {
            return {
              results: [{
                id: "creative-direct",
                campaign_id: "campaign-direct",
                audio_key: "podcasts/ads/creative-direct.mp3",
                audio_bytes: 64_000,
                audio_mime_type: "audio/mpeg",
                stream_profile: streamProfile,
                weight: 1,
                active: 1,
                validation_status: "ready"
              }]
            };
          }
          if (query.includes("FROM episode_audio_segments")) {
            return {
              results: [{
                sequence: 0,
                stream_profile: streamProfile,
                validation_status: "ready"
              }]
            };
          }
          return { results: [] };
        },
        async run() {
          writes.push(query);
          return { success: true };
        }
      };
    }
  } as unknown as D1Database;

  return {
    DB: db,
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret
  } as unknown as PodcastEnv;
}
