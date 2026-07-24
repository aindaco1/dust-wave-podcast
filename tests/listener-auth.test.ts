import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  exchangeListenerLogin,
  getListenerSession,
  LISTENER_SESSION_COOKIE,
  startListenerLogin
} from "../src/listener-auth";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listener passwordless authentication", () => {
  it("fails closed before reading identity input when providers are absent", async () => {
    const response = await startListenerLogin(
      listenerRequest("/v1/member/auth/start"),
      {
        SITE_ORIGIN: "https://dustwave.xyz",
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      { email: "listener@example.com" }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "listener_auth_not_configured"
    });
  });

  it("stores only pseudonymous login evidence while Resend receives the address", async () => {
    const boundValues: unknown[][] = [];
    const db = authenticationDatabase({ boundValues });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const response = await startListenerLogin(
      listenerRequest("/v1/member/auth/start"),
      listenerEnv(db),
      { email: "LISTENER@EXAMPLE.COM", preferredLanguage: "es" }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(boundValues.flat()).not.toContain("listener@example.com");
    expect(
      boundValues.flat().some((value) => /^[a-f0-9]{64}$/.test(String(value)))
    ).toBe(true);
    const resendBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(resendBody.to).toEqual(["listener@example.com"]);
    expect(resendBody.text).toContain("/podcasts/account/#magic-link=");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "idempotency-key": expect.stringMatching(
        /^podcast-listener-login\/[a-f0-9]{64}$/
      )
    });
  });

  it("returns the same accepted response for an unknown listener", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await startListenerLogin(
      listenerRequest("/v1/member/auth/start"),
      listenerEnv(authenticationDatabase({ listenerExists: false })),
      { email: "unknown@example.com" }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges one token into a scoped HttpOnly member session", async () => {
    const batchStatements: unknown[][] = [];
    const db = authenticationDatabase({ batchStatements });
    const response = await exchangeListenerLogin(
      listenerRequest("/v1/member/auth/exchange"),
      listenerEnv(db),
      { token: "one_time_token_fixture" }
    );
    const payload = await response.json() as {
      authenticated: boolean;
      csrfToken: string;
      expiresInSeconds: number;
      identity: {
        id: string;
        subscriptions: Array<{
          entitled: boolean;
          hasPrivateFeed: boolean;
          show: { slug: string };
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      `${LISTENER_SESSION_COOKIE}=`
    );
    expect(response.headers.get("set-cookie")).toContain("Path=/v1/member");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(payload.authenticated).toBe(true);
    expect(payload.csrfToken).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(payload.expiresInSeconds).toBe(30 * 24 * 60 * 60);
    expect(payload.identity.id).toBe("listener_fixture");
    expect(payload.identity.subscriptions[0]).toMatchObject({
      entitled: true,
      hasPrivateFeed: true,
      show: { slug: "opera-en-la-selva" }
    });
    expect(batchStatements).toHaveLength(1);
    expect(batchStatements[0]).toHaveLength(2);
  });

  it("rotates CSRF state without returning a private feed token", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const db = authenticationDatabase({ writes });
    const response = await getListenerSession(
      new Request(
        "https://feeds.dustwave.xyz/v1/member/session",
        {
          headers: {
            cookie: `${LISTENER_SESSION_COOKIE}=session_token_fixture`
          }
        }
      ),
      listenerEnv(db)
    );
    const payload = await response.json() as {
      authenticated: boolean;
      csrfToken: string;
      identity: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.authenticated).toBe(true);
    expect(JSON.stringify(payload.identity)).not.toContain("private_feed_token");
    const rotation = writes.find(({ query }) =>
      query.includes("SET csrf_token_hash = ?")
    );
    expect(rotation?.values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotation?.values).not.toContain(payload.csrfToken);
  });
});

function listenerRequest(path: string): Request {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method: "POST",
    headers: {
      origin: "https://dustwave.xyz",
      "cf-connecting-ip": "192.0.2.30"
    }
  });
}

function listenerEnv(db: D1Database): PodcastEnv {
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    DB: db,
    LISTENER_EMAIL_LOOKUP_PEPPER: "listener_pepper_fixture",
    LISTENER_SESSION_SECRET: "listener_session_fixture",
    LISTENER_TURNSTILE_REQUIRED: "false",
    RESEND_API_KEY: "resend_fixture"
  } as unknown as PodcastEnv;
}

function authenticationDatabase({
  listenerExists = true,
  boundValues = [],
  batchStatements = [],
  writes = []
}: {
  listenerExists?: boolean;
  boundValues?: unknown[][];
  batchStatements?: unknown[][];
  writes?: Array<{ query: string; values: unknown[] }>;
} = {}): D1Database {
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          boundValues.push(bound);
          return this;
        },
        async first() {
          if (query.includes("RETURNING attempt_count")) {
            return { attempt_count: 1 };
          }
          if (query.includes("FROM listener_accounts")) {
            return listenerExists ? { id: "listener_fixture" } : null;
          }
          if (query.includes("UPDATE listener_login_tokens")) {
            return { listener_id: "listener_fixture" };
          }
          if (query.includes("FROM listener_sessions")) {
            return {
              listener_id: "listener_fixture",
              csrf_token_hash: "old_csrf_hash"
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM subscriptions")) {
            return {
              results: [{
                subscription_id: "subscription_fixture",
                provider: "stripe",
                status: "active",
                current_period_end: "2099-01-01T00:00:00.000Z",
                show_id: "show_opera_en_la_selva",
                show_slug: "opera-en-la-selva",
                show_title: "Ópera en la Selva",
                billing_period: "month",
                entitled: 1,
                has_private_feed: 1
              }]
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
    },
    async batch(statements: unknown[]) {
      batchStatements.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };
  return db as unknown as D1Database;
}
