import { describe, expect, it } from "vitest";

import {
  getAdminAdQualificationReconciliation
} from "../src/ad-reporting";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

describe("ad qualification reconciliation", () => {
  it("returns one role-scoped, bounded page and exact durable-counter totals", async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const env = reportingEnvironment(queries);
    const response = await getAdminAdQualificationReconciliation(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/ads/reconciliation"
        + "?showId=show-1&limit=1",
        {
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=reporting-session-token`
          }
        }
      ),
      env
    );
    const payload = await response.json() as {
      methodology: { version: string };
      summary: {
        counterValue: number;
        qualificationRows: number;
        difference: number;
      };
      campaigns: Array<{
        id: string;
        reconciled: boolean;
        qualificationRows: number;
      }>;
      pagination: { limit: number; nextCursor: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.methodology.version).toBe("trusted-download-v1");
    expect(payload.summary).toMatchObject({
      counterValue: 12,
      qualificationRows: 12,
      difference: 0
    });
    expect(payload.campaigns).toEqual([
      expect.objectContaining({
        id: "campaign-newest",
        reconciled: true,
        qualificationRows: 7
      })
    ]);
    expect(payload.pagination).toEqual({
      limit: 1,
      nextCursor: "campaign-newest"
    });
    const pageQuery = queries.find(({ query }) =>
      query.includes("WITH scoped_campaigns")
    );
    expect(pageQuery?.values).toEqual(["show-1", 2]);
    expect(pageQuery?.query).toContain("LIMIT ?");
    expect(pageQuery?.query).toContain("qualification_totals");
  });
});

function reportingEnvironment(
  queries: Array<{ query: string; values: unknown[] }>
): PodcastEnv {
  const campaigns = [
    reconciliationRow({
      id: "campaign-newest",
      name: "Newest sponsor",
      counter_value: 7,
      qualification_rows: 7,
      qualified_impressions: 7,
      impression_cap: 10
    }),
    reconciliationRow({
      id: "campaign-older",
      name: "Older sponsor",
      counter_value: 5,
      qualification_rows: 5,
      qualified_impressions: 5,
      impression_cap: 5
    })
  ];
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
              admin_user_id: "admin-reporting",
              csrf_token_hash: "unused"
            };
          }
          if (query.includes("COUNT(*) AS campaign_count")) {
            return {
              campaign_count: 2,
              counter_value: 12,
              qualification_rows: 12,
              difference: 0,
              discrepancy_count: 0,
              campaigns_at_cap: 1,
              last_qualified_at: "2026-07-24T12:00:00.000Z"
            };
          }
          return null;
        },
        async all() {
          queries.push({ query, values });
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "analyst", show_id: "show-1" }]
            };
          }
          if (query.includes("WITH scoped_campaigns")) {
            return { results: campaigns };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  } as unknown as D1Database;
  return {
    DB: db,
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    SITE_ORIGIN: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: "reporting-session-secret"
  } as unknown as PodcastEnv;
}

function reconciliationRow(
  overrides: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    id: "campaign-fixture",
    name: "Sponsor fixture",
    campaign_type: "direct",
    sponsor_name: "Sponsor",
    approval_status: "approved",
    active: 1,
    kill_switch_at: null,
    starts_at: "2026-07-01T00:00:00.000Z",
    ends_at: null,
    impression_cap: null,
    qualified_impression_goal: 100,
    qualified_impressions: 0,
    pacing_strategy: "even",
    counter_value: 0,
    qualification_rows: 0,
    difference: 0,
    last_qualified_at: "2026-07-24T12:00:00.000Z",
    created_at: "2026-07-24T00:00:00.000Z",
    ...overrides
  };
}
