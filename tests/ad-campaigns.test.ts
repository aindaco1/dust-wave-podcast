import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  approveAdminAdCampaign,
  createAdminAdCampaign,
  killAdminAdCampaign
} from "../src/ad-campaigns";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

const sessionSecret = "campaign-session-secret";
const csrfToken = "campaign-csrf-token";

describe("admin ad campaign operations", () => {
  it("creates a direct campaign as an audited, unapproved draft", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await campaignEnvironment({
      writes,
      first(query) {
        if (query.includes("FROM shows")) return { id: "show-1" };
        if (query.includes("FROM sponsors")) return null;
        return undefined;
      }
    });
    const response = await createAdminAdCampaign(
      campaignRequest("/v1/admin/ads/campaigns", {
        showId: "show-1",
        name: "Launch sponsor",
        campaignType: "direct",
        sponsorName: "Sponsor Fixture",
        sponsorWebsiteUrl: "https://sponsor.example/",
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-09-01T00:00:00.000Z",
        position: "mid",
        deviceType: "mobile",
        appName: "Apple Podcasts",
        billingModel: "flat_fee",
        contractAmountCents: 50_000
      }),
      env
    );
    const payload = await response.json() as {
      campaignId: string;
      approvalStatus: string;
      blockers: string[];
    };

    expect(response.status).toBe(201);
    expect(payload.campaignId).toMatch(/^campaign_[a-f0-9]{32}$/);
    expect(payload.approvalStatus).toBe("draft");
    expect(payload.blockers).toEqual([
      "creative_audio_not_ready",
      "campaign_approval_required"
    ]);
    expect(writes.some(({ query }) => query.includes("INSERT INTO sponsors"))).toBe(true);
    expect(writes.some(({ query }) => query.includes("INSERT INTO ad_campaigns"))).toBe(true);
    expect(writes.some(({ query }) => query.includes("INSERT INTO ad_rules"))).toBe(true);
    const audit = writes.find(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    );
    expect(audit?.values).toContain("ad_campaign.created");
    expect(writes.some(({ query }) =>
      query.includes("approval_status = 'approved'")
    )).toBe(false);
  });

  it("refuses approval until validated creative audio exists", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await campaignEnvironment({
      writes,
      first(query) {
        if (query.includes("FROM ad_campaigns c")) {
          return campaignScope();
        }
        if (query.includes("FROM ad_rules")) return { count: 1 };
        if (query.includes("FROM ad_creatives")) return { count: 0 };
        return undefined;
      }
    });
    const response = await approveAdminAdCampaign(
      campaignRequest(
        "/v1/admin/ads/campaigns/campaign-fixture/approve",
        {}
      ),
      env,
      "campaign-fixture"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "campaign_not_ready",
      blockers: ["creative_audio_not_ready"]
    });
    expect(writes.some(({ query }) =>
      query.includes("approval_status = 'approved'")
    )).toBe(false);
  });

  it("kills an approved campaign and audits the irreversible state change", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = await campaignEnvironment({
      writes,
      first(query) {
        if (query.includes("FROM ad_campaigns c")) {
          return campaignScope({ approval_status: "approved" });
        }
        return undefined;
      }
    });
    const response = await killAdminAdCampaign(
      campaignRequest(
        "/v1/admin/ads/campaigns/campaign-fixture/kill",
        {}
      ),
      env,
      "campaign-fixture"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      killed: true,
      idempotent: false,
      campaignId: "campaign-fixture"
    });
    expect(writes.some(({ query }) =>
      query.includes("approval_status = 'revoked'")
    )).toBe(true);
    const audit = writes.find(({ query }) =>
      query.includes("INSERT INTO admin_audit_events")
    );
    expect(audit?.values).toContain("ad_campaign.killed");
  });
});

function campaignRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=campaign-session-token`,
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

async function campaignEnvironment({
  writes,
  first
}: {
  writes: Array<{ query: string; values: unknown[] }>;
  first: (
    query: string,
    values: unknown[]
  ) => Record<string, unknown> | null | undefined;
}): Promise<PodcastEnv> {
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
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
          const result = first(query, values);
          return result === undefined ? null : result;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{
                role: "admin",
                show_id: "show-1"
              }]
            };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          return { success: true, meta: { changes: 1 } };
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

function campaignScope(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
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
    revision: 1,
    ...overrides
  };
}
