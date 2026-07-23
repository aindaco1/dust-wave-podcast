import { afterEach, describe, expect, it, vi } from "vitest";

import { startAdminLogin } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin authentication privacy", () => {
  it("stores only an email lookup HMAC while sending the address directly to Resend", async () => {
    const boundValues: unknown[][] = [];
    const db = {
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            boundValues.push(bound);
            return this;
          },
          async first() {
            return query.includes("FROM admin_users") ? { id: "admin_fixture" } : null;
          },
          async run() {
            return { success: true };
          }
        };
      }
    } as unknown as D1Database;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const env = {
      ENVIRONMENT: "staging",
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: db,
      ADMIN_EMAIL_LOOKUP_PEPPER: "pepper_fixture",
      ADMIN_SESSION_SECRET: "session_fixture",
      ADMIN_TURNSTILE_REQUIRED: "false",
      RESEND_API_KEY: "resend_fixture"
    } as unknown as PodcastEnv;
    const response = await startAdminLogin(
      new Request("https://feeds.dustwave.xyz/v1/admin/auth/start", {
        method: "POST"
      }),
      env,
      { email: "ADMIN@EXAMPLE.COM", preferredLanguage: "es" }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(boundValues.flat()).not.toContain("admin@example.com");
    expect(String(boundValues[0][0])).toMatch(/^[a-f0-9]{64}$/);
    const resendBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(resendBody.to).toEqual(["admin@example.com"]);
    expect(resendBody.text).toContain("#magic-link=");
  });
});
