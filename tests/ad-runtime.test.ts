import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  issueAdminStagingAdDecision,
  recordTrustedDownloadQualification,
  serveStagingAdDecisionAudio
} from "../src/ad-runtime";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

const sessionSecret = "runtime-session-secret";
const decisionSecret = "runtime-decision-secret";
const qualificationSecret = "runtime-qualification-secret";
const csrfToken = "runtime-csrf-token";
const streamProfile = "mp3-44100-stereo-cbr128-frame-v1";
const sourceEtag = '"episode-source-etag"';

describe("signed staging ad decisions", () => {
  it("persists one immutable manifest and serves it only through its signed URL", async () => {
    const fixture = await runtimeEnvironment();
    const first = await issueAdminStagingAdDecision(
      issueRequest(),
      fixture.env
    );
    const issued = await first.json() as {
      decisionId: string;
      idempotent: boolean;
      signedUrl: string;
      manifestSha256: string;
      totalBytes: number;
      runtimeEnabled: boolean;
      publicEnclosureConnected: boolean;
    };

    expect(first.status).toBe(201);
    expect(issued.decisionId).toMatch(/^decision_[a-f0-9]{48}$/);
    expect(issued.idempotent).toBe(false);
    expect(issued.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.totalBytes).toBe(19);
    expect(issued.runtimeEnabled).toBe(false);
    expect(issued.publicEnclosureConnected).toBe(false);
    expect(fixture.batches).toHaveLength(1);
    expect(
      fixture.batches[0].filter(({ query }) =>
        query.includes("INSERT OR IGNORE INTO ad_decision_slots")
      )
    ).toHaveLength(2);
    expect(
      fixture.batches[0].find(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )?.values
    ).toContain("ad_decision.staging_issued");

    const audio = await serveStagingAdDecisionAudio(
      new Request(issued.signedUrl, {
        headers: { range: "bytes=2-16" }
      }),
      fixture.env,
      issued.decisionId
    );
    expect(audio.status).toBe(206);
    expect(audio.headers.get("content-range")).toBe("bytes 2-16/19");
    expect(await audio.text()).toBe("12PROGRAM1234AD");

    fixture.changeObjectEtag(
      "podcasts/show-1/ads/creative-v1.mp3",
      '"creative-mutated"'
    );
    const mutated = await serveStagingAdDecisionAudio(
      new Request(issued.signedUrl),
      fixture.env,
      issued.decisionId
    );
    expect(mutated.status).toBe(409);
    expect(await mutated.json()).toEqual({
      error: "ad_decision_object_mismatch"
    });
    fixture.changeObjectEtag(
      "podcasts/show-1/ads/creative-v1.mp3",
      '"creative-v1-etag"'
    );

    const second = await issueAdminStagingAdDecision(
      issueRequest(),
      fixture.env
    );
    const repeated = await second.json() as {
      decisionId: string;
      idempotent: boolean;
    };
    expect(second.status).toBe(200);
    expect(repeated).toEqual({
      decisionId: issued.decisionId,
      idempotent: true,
      signedUrl: expect.any(String),
      status: "selected",
      expiresAt: expect.any(String),
      manifestSha256: issued.manifestSha256,
      totalBytes: 19,
      runtimeEnabled: false,
      publicEnclosureConnected: false,
      flags: {
        showEnabled: false,
        episodeEnabled: false
      }
    });
    expect(fixture.batches).toHaveLength(1);
  });

  it("rejects a bad URL signature before looking up a decision", async () => {
    const env = {
      ENVIRONMENT: "staging",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: decisionSecret,
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const expires = Math.floor(Date.now() / 1_000) + 60;
    const response = await serveStagingAdDecisionAudio(
      new Request(
        `https://podcast.example/v1/ads/decisions/decision_fixture/audio`
        + `?expires=${expires}&manifest=${"a".repeat(64)}`
        + `&signature=${"b".repeat(64)}`
      ),
      env,
      "decision_fixture"
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_ad_decision_signature"
    });
  });

  it("stays unavailable in production even if a signing secret exists", async () => {
    const env = {
      ENVIRONMENT: "production",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: decisionSecret,
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const response = await serveStagingAdDecisionAudio(
      new Request(
        "https://feeds.dustwave.xyz/v1/ads/decisions/decision_fixture/audio"
      ),
      env,
      "decision_fixture"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("qualified-impression accounting", () => {
  it("deduplicates one complete slot and reports a reached hard cap", async () => {
    const state = {
      recorded: false,
      counter: 0,
      cap: 1
    };
    const db = qualificationDatabase(state);
    const first = await recordTrustedDownloadQualification(db, {
      decisionId: "decision_fixture",
      decisionSlotId: "slot_fixture",
      bytesServed: 4_000,
      secret: qualificationSecret
    });
    const repeated = await recordTrustedDownloadQualification(db, {
      decisionId: "decision_fixture",
      decisionSlotId: "slot_fixture",
      bytesServed: 4_000,
      secret: qualificationSecret
    });

    expect(first).toMatchObject({
      status: "qualified",
      idempotent: false
    });
    expect(repeated).toEqual({
      ...first,
      idempotent: true
    });
    expect(state.counter).toBe(1);

    state.recorded = false;
    const capped = await recordTrustedDownloadQualification(db, {
      decisionId: "decision_fixture",
      decisionSlotId: "slot_other",
      bytesServed: 4_000,
      secret: qualificationSecret
    });
    expect(capped).toEqual({
      status: "cap_reached",
      qualificationId: null,
      idempotent: false
    });
    expect(state.counter).toBe(1);
  });
});

function issueRequest(): Request {
  return new Request(
    "https://dust-wave-podcast-staging.jogo.workers.dev/v1/admin/ads/decisions/issue",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${ADMIN_SESSION_COOKIE}=runtime-session-token`,
        origin: "https://dustwave.xyz",
        "x-podcast-csrf": csrfToken,
        "cf-connecting-ip": "192.0.2.10"
      },
      body: JSON.stringify({
        episodeId: "episode-fixture",
        deviceType: "mobile",
        appName: "Apple Podcasts",
        streamProfile
      })
    }
  );
}

async function runtimeEnvironment(): Promise<{
  env: PodcastEnv;
  batches: Array<Array<{ query: string; values: unknown[] }>>;
  changeObjectEtag: (key: string, etag: string) => void;
}> {
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  let decision: Record<string, unknown> | null = null;
  const statement = (query: string) => {
    let values: unknown[] = [];
    return {
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
        if (query.includes("FROM episodes e") && query.includes("JOIN shows")) {
          return {
            id: "episode-fixture",
            show_id: "show-1",
            publication_revision: 1,
            status: "published",
            media_status: "ready",
            audio_key: "podcasts/show-1/episode-fixture/delivery.mp3",
            audio_bytes: 11,
            audio_mime_type: "audio/mpeg",
            audio_etag: sourceEtag,
            episode_dynamic_ads_enabled: 0,
            show_dynamic_ads_enabled: 0
          };
        }
        if (query.includes("FROM ad_decisions")) return decision;
        return null;
      },
      async all() {
        if (query.includes("FROM admin_user_roles")) {
          return { results: [{ role: "producer", show_id: "show-1" }] };
        }
        if (query.includes("FROM ad_campaigns c")) {
          return {
            results: [{
              id: "campaign-direct",
              revision: 3,
              campaign_type: "direct",
              sponsor_active: 1,
              approval_status: "approved",
              active: 1,
              starts_at: "2026-01-01T00:00:00.000Z",
              ends_at: null,
              kill_switch_at: null,
              priority: 10,
              impression_cap: 1_000,
              qualified_impression_goal: 500,
              qualified_impressions: 0,
              pacing_strategy: "even"
            }]
          };
        }
        if (query.includes("FROM ad_rules r")) {
          return {
            results: [{
              id: "rule-show",
              campaign_id: "campaign-direct",
              show_id: "show-1",
              episode_id: null,
              position: null,
              device_type: null,
              app_name: null,
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
              audio_key: "podcasts/show-1/ads/creative-v1.mp3",
              audio_bytes: 4,
              audio_mime_type: "audio/mpeg",
              audio_etag: '"creative-v1-etag"',
              stream_profile: streamProfile,
              sha256: "c".repeat(64),
              duration_ms: 1_000,
              weight: 1,
              active: 1,
              validation_status: "ready"
            }]
          };
        }
        if (query.includes("FROM episode_ad_markers")) {
          return {
            results: [
              {
                id: "marker-pre",
                plan_id: "adplan-fixture",
                position: "pre",
                starts_at_ms: null,
                approved_at: "2026-07-24T12:00:00.000Z"
              },
              {
                id: "marker-post",
                plan_id: "adplan-fixture",
                position: "post",
                starts_at_ms: null,
                approved_at: "2026-07-24T12:00:00.000Z"
              }
            ]
          };
        }
        if (query.includes("FROM episode_audio_segments")) {
          return {
            results: [{
              id: "program-segment-0",
              plan_id: "adplan-fixture",
              sequence: 0,
              object_key: "podcasts/show-1/episode-fixture/ad-plans/adplan-fixture/program-0.mp3",
              object_bytes: 11,
              source_offset: 0,
              byte_length: 11,
              audio_mime_type: "audio/mpeg",
              stream_profile: streamProfile,
              sha256: "d".repeat(64),
              source_etag: sourceEtag,
              validation_status: "ready",
              validated_at: "2026-07-24T12:00:00.000Z"
            }]
          };
        }
        return { results: [] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      }
    };
  };
  const db = {
    prepare: statement,
    async batch(statements: Array<{
      query: string;
      values: unknown[];
    }>) {
      const snapshot = statements.map((item) => ({
        query: item.query,
        values: [...item.values]
      }));
      batches.push(snapshot);
      const insert = snapshot.find(({ query }) =>
        query.includes("INSERT OR IGNORE INTO ad_decisions")
      );
      if (insert && !decision) {
        decision = {
          id: insert.values[0],
          episode_id: insert.values[2],
          publication_revision: insert.values[3],
          request_key_hash: insert.values[4],
          status: "selected",
          manifest_json: insert.values[10],
          manifest_etag: insert.values[11],
          total_bytes: insert.values[12],
          expires_at: insert.values[13],
          manifest_sha256: insert.values[15],
          qualification_expires_at: insert.values[17]
        };
      }
      return statements.map(() => ({
        success: true,
        meta: { changes: 1 }
      }));
    }
  } as unknown as D1Database;
  const objects: Record<string, {
    bytes: Uint8Array;
    etag: string;
  }> = {
    "podcasts/show-1/episode-fixture/ad-plans/adplan-fixture/program-0.mp3": {
      bytes: new TextEncoder().encode("PROGRAM1234"),
      etag: '"program-v1-etag"'
    },
    "podcasts/show-1/ads/creative-v1.mp3": {
      bytes: new TextEncoder().encode("AD12"),
      etag: '"creative-v1-etag"'
    }
  };
  const bucket = {
    async head(key: string) {
      const object = objects[key];
      return object
        ? { size: object.bytes.byteLength, httpEtag: object.etag }
        : null;
    },
    async get(
      key: string,
      options: { range: { offset: number; length: number } }
    ) {
      const object = objects[key];
      if (!object) return null;
      const { offset, length } = options.range;
      return {
        body: new Response(
          object.bytes.slice(offset, offset + length)
        ).body,
        size: object.bytes.byteLength,
        httpEtag: object.etag,
        range: { offset, length },
        writeHttpMetadata() {}
      };
    }
  } as unknown as R2Bucket;
  return {
    env: {
      DB: db,
      MEDIA_BUCKET: bucket,
      ENVIRONMENT: "staging",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: decisionSecret,
      MEDIA_KEY_PREFIX: "podcasts/",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      SITE_ORIGIN: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret
    } as unknown as PodcastEnv,
    batches,
    changeObjectEtag(key, etag) {
      const object = objects[key];
      if (!object) throw new Error(`Unknown fixture object: ${key}`);
      object.etag = etag;
    }
  };
}

function qualificationDatabase(state: {
  recorded: boolean;
  counter: number;
  cap: number;
}): D1Database {
  let qualificationId: string | null = null;
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("FROM ad_decision_slots")) {
            return {
              id: values[0],
              decision_id: values[1],
              campaign_id: "campaign-fixture",
              creative_id: "creative-fixture",
              creative_object_bytes: 4_000,
              status: "selected",
              qualification_expires_at:
                new Date(Date.now() + 60_000).toISOString(),
              impression_cap: state.cap,
              qualified_impressions: state.counter
            };
          }
          if (query.includes("FROM ad_impression_qualifications")) {
            return state.recorded && qualificationId
              ? { id: qualificationId }
              : null;
          }
          if (query.includes("FROM ad_campaigns")) {
            return {
              impression_cap: state.cap,
              qualified_impressions: state.counter
            };
          }
          return null;
        },
        async run() {
          if (
            query.includes("INSERT OR IGNORE")
            && !state.recorded
            && state.counter < state.cap
          ) {
            qualificationId = String(values[0]);
            state.recorded = true;
            state.counter += 1;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database;
}
