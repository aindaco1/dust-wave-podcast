import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import {
  inviteAdminUser,
  updateAdminUserStatus
} from "../src/admin-users";
import type { PodcastEnv } from "../src/env";

describe("super-admin lifecycle", () => {
  it("stores only an email HMAC when inviting another super-admin", async () => {
    const fixture = await lifecycleFixture();
    const response = await inviteAdminUser(
      fixture.request("/v1/admin/users", {
        email: "SECOND.ADMIN@EXAMPLE.COM",
        role: "super_admin"
      }),
      fixture.env
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: "invited",
      role: { role: "super_admin", showId: null },
      delivery: "standard_magic_link_login"
    });
    expect(fixture.boundValues.flat()).not.toContain(
      "second.admin@example.com"
    );
    expect(
      fixture.boundValues.flat().some((value) =>
        /^[a-f0-9]{64}$/.test(String(value))
      )
    ).toBe(true);
    expect(fixture.batchCount()).toBe(1);
  });

  it("requires a login from the preceding 15 minutes", async () => {
    const fixture = await lifecycleFixture({ recent: false });
    const response = await inviteAdminUser(
      fixture.request("/v1/admin/users", {
        email: "second.admin@example.com",
        role: "super_admin"
      }),
      fixture.env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(fixture.batchCount()).toBe(0);
  });

  it("refuses to suspend either of the last two active super-admins", async () => {
    const fixture = await lifecycleFixture({
      activeSuperAdminCount: 2,
      target: { status: "active", is_super_admin: 1 }
    });
    const response = await updateAdminUserStatus(
      fixture.request("/v1/admin/users/admin_second", {
        status: "suspended"
      }),
      fixture.env,
      "admin_second"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "minimum_two_active_super_admins"
    });
    expect(
      fixture.queries.some((query) =>
        query.includes("UPDATE admin_users")
      )
    ).toBe(false);
  });
});

async function lifecycleFixture({
  recent = true,
  activeSuperAdminCount = 3,
  target = null
}: {
  recent?: boolean;
  activeSuperAdminCount?: number;
  target?: { status: "active"; is_super_admin: number } | null;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const queries: string[] = [];
  const boundValues: unknown[][] = [];
  let batches = 0;
  const db = {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          boundValues.push(bound);
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return recent ? { recent: 1 } : null;
          }
          if (query.includes("SELECT id") && query.includes("email_lookup_hash")) {
            return null;
          }
          if (query.includes("SELECT") && query.includes("is_super_admin")) {
            return target;
          }
          if (query.includes("COUNT(DISTINCT u.id) AS count")) {
            return { count: activeSuperAdminCount };
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
          return { success: true, values };
        }
      };
    },
    async batch(statements: unknown[]) {
      batches += 1;
      return statements.map(() => ({ success: true }));
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_EMAIL_LOOKUP_PEPPER: "pepper_fixture",
    ADMIN_SESSION_SECRET: sessionSecret
  } as unknown as PodcastEnv;
  return {
    env,
    queries,
    boundValues,
    batchCount: () => batches,
    request(path: string, body: Record<string, unknown>) {
      return new Request(`https://feeds.dustwave.xyz${path}`, {
        method: path.includes("admin_second") ? "PATCH" : "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
          origin: "https://dustwave.xyz",
          "x-podcast-csrf": csrfToken
        },
        body: JSON.stringify(body)
      });
    }
  };
}
