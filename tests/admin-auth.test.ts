import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_SESSION_COOKIE,
  getAdminSession,
  startAdminLogin
} from "../src/admin-auth";
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
            if (query.includes("RETURNING attempt_count")) {
              return { attempt_count: 1 };
            }
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
    expect(
      boundValues.flat().some((value) => /^[a-f0-9]{64}$/.test(String(value)))
    ).toBe(true);
    const resendBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(resendBody.to).toEqual(["admin@example.com"]);
    expect(resendBody.text).toContain("#magic-link=");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "idempotency-key": expect.stringMatching(
        /^podcast-admin-login\/[a-f0-9]{64}$/
      )
    });
  });

  it("silently rate-limits login email without looking up an account", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        let action = "";
        return {
          bind(...values: unknown[]) {
            action = String(values[0] ?? "");
            return this;
          },
          async first() {
            if (query.includes("RETURNING attempt_count")) {
              return {
                attempt_count: action === "start_email" ? 6 : 1
              };
            }
            return null;
          },
          async run() {
            return { success: true };
          }
        };
      }
    } as unknown as D1Database;
    const fetchMock = vi.spyOn(globalThis, "fetch");
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
        method: "POST",
        headers: {
          origin: "https://dustwave.xyz",
          "cf-connecting-ip": "192.0.2.10"
        }
      }),
      env,
      { email: "admin@example.com" }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("retry-after")).toBe("900");
    expect(queries.some((query) => query.includes("FROM admin_users"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates the in-memory CSRF token when restoring an authenticated session", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
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
                admin_user_id: "admin_fixture",
                csrf_token_hash: "old_csrf_hash"
              };
            }
            return null;
          },
          async all() {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          },
          async run() {
            writes.push({ query, values });
            return { success: true };
          }
        };
      }
    } as unknown as D1Database;
    const env = {
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: "session_fixture",
      DB: db
    } as unknown as PodcastEnv;

    const response = await getAdminSession(
      new Request("https://feeds.dustwave.xyz/v1/admin/session", {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=session_token_fixture` }
      }),
      env
    );
    const payload = await response.json() as {
      authenticated: boolean;
      csrfToken: string;
      expiresInSeconds: number;
    };
    const rotation = writes.find(({ query }) => query.includes("SET csrf_token_hash = ?"));

    expect(response.status).toBe(200);
    expect(payload.authenticated).toBe(true);
    expect(payload.csrfToken).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(payload.expiresInSeconds).toBe(8 * 60 * 60);
    expect(rotation?.values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotation?.values).not.toContain(payload.csrfToken);
  });
});
