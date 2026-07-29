import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("episode settings mutations", () => {
  it("derives missing early-access time from the selected show policy", async () => {
    const fixture = await episodeFixture();
    const response = await handleRequest(fixture.request({
      access: "early_access",
      premiumAt: null,
      publicAt: "2026-08-08T16:00:00.000Z"
    }), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: true,
      episodeId: "episode_fixture"
    });
    const update = fixture.writes.find(({ query }) =>
      query.includes("UPDATE episodes")
    );
    expect(update?.values).toEqual([
      "early_access",
      "2026-08-01T16:00:00.000Z",
      "2026-08-08T16:00:00.000Z",
      "episode_fixture"
    ]);
  });

  it("rejects premium access after the public release", async () => {
    const fixture = await episodeFixture();
    const response = await handleRequest(fixture.request({
      premiumAt: "2026-08-09T16:00:00.000Z",
      publicAt: "2026-08-08T16:00:00.000Z"
    }), fixture.env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: "premiumAt cannot be after publicAt"
    });
    expect(
      fixture.writes.some(({ query }) => query.includes("UPDATE episodes"))
    ).toBe(false);
  });

  it("enforces the single free mini-episode rule on updates", async () => {
    const fixture = await episodeFixture({ existingFreeMiniCount: 1 });
    const response = await handleRequest(fixture.request({
      access: "free_mini"
    }), fixture.env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: "This show already has its free mini episode"
    });
    expect(fixture.queries).toContainEqual(expect.stringContaining(
      "AND id != ?"
    ));
    expect(
      fixture.writes.some(({ query }) => query.includes("UPDATE episodes"))
    ).toBe(false);
  });

  it("rejects free mini access when the show has not enabled it", async () => {
    const fixture = await episodeFixture({ freeMiniEnabled: false });
    const response = await handleRequest(fixture.request({
      access: "free_mini"
    }), fixture.env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: "This show does not allow a free mini episode"
    });
    expect(
      fixture.writes.some(({ query }) => query.includes("UPDATE episodes"))
    ).toBe(false);
  });
});

async function episodeFixture({
  existingFreeMiniCount = 0,
  freeMiniEnabled = true
}: {
  existingFreeMiniCount?: number;
  freeMiniEnabled?: boolean;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("FROM episodes episode")) {
            return {
              show_id: "show_opera_en_la_selva",
              access: "public",
              premium_at: null,
              public_at: null,
              early_access_days: 7,
              free_mini_episode_enabled: freeMiniEnabled ? 1 : 0
            };
          }
          if (query.includes("SELECT COUNT(*) AS count")) {
            return { count: existingFreeMiniCount };
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
          writes.push({ query, values });
          return { success: true };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret
    } as unknown as PodcastEnv,
    queries,
    writes,
    request(body: Record<string, unknown>) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/episode_fixture",
        {
          method: "PATCH",
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
