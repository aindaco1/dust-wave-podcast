import {
  hmacSha256,
  sha256Hex
} from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { LISTENER_SESSION_COOKIE } from "../src/listener-auth";
import {
  handlePoolGrantEvent,
  redeemPoolCode
} from "../src/pool-redemptions";

const POOL_CODE = "DW-POD-ABCDEFGH-JKLMNPQR-STUVWXYZ-23456789";

describe("Pool podcast redemption bridge", () => {
  it("fails closed before D1 when the bridge gate is off", async () => {
    let touchedDatabase = false;
    const response = await handlePoolGrantEvent(
      new Request("https://feeds.dustwave.xyz/v1/internal/pool/grants", {
        method: "POST"
      }),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        POOL_REDEMPTION_ENABLED: "false",
        DB: {
          prepare() {
            touchedDatabase = true;
            throw new Error("unexpected D1 access");
          }
        }
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(404);
    expect(touchedDatabase).toBe(false);
  });

  it("rejects a bad bridge signature before D1", async () => {
    let touchedDatabase = false;
    const rawBody = JSON.stringify({
      eventId: "event_bad_signature",
      grantId: "grant_bad_signature",
      action: "revoke"
    });
    const response = await handlePoolGrantEvent(
      new Request("https://feeds.dustwave.xyz/v1/internal/pool/grants", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pool-podcast-timestamp": String(Math.floor(Date.now() / 1_000)),
          "x-pool-podcast-signature": "a".repeat(64)
        },
        body: rawBody
      }),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        POOL_REDEMPTION_ENABLED: "true",
        POOL_PODCAST_BRIDGE_SECRET: "pool_bridge_secret_fixture",
        POOL_REDEMPTION_CODE_PEPPER: "pool_code_pepper_fixture",
        LISTENER_EMAIL_LOOKUP_PEPPER: "listener_email_pepper_fixture",
        DB: {
          prepare() {
            touchedDatabase = true;
            throw new Error("unexpected D1 access");
          }
        }
      } as unknown as PodcastEnv
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_pool_grant_signature"
    });
    expect(touchedDatabase).toBe(false);
  });

  it("stores only code/email HMACs and replays a signed grant idempotently", async () => {
    const fixture = bridgeDatabase();
    const body = {
      eventId: "event_pool_fixture_1",
      grantId: "grant_pool_fixture_1",
      action: "grant",
      showSlug: "opera-en-la-selva",
      email: "Listener@Example.com",
      code: POOL_CODE,
      durationDays: 365,
      redeemBy: "2027-07-24T00:00:00.000Z"
    };
    const env = bridgeEnv(fixture.db);
    const first = await handlePoolGrantEvent(
      await signedBridgeRequest(body, env.POOL_PODCAST_BRIDGE_SECRET as string),
      env
    );
    const replay = await handlePoolGrantEvent(
      await signedBridgeRequest(body, env.POOL_PODCAST_BRIDGE_SECRET as string),
      env
    );
    const firstPayload = await first.json() as { idempotent: boolean };
    const replayPayload = await replay.json() as { idempotent: boolean };
    const evidence = JSON.stringify(fixture.writes);

    expect(first.status).toBe(201);
    expect(firstPayload.idempotent).toBe(false);
    expect(replay.status).toBe(200);
    expect(replayPayload.idempotent).toBe(true);
    expect(fixture.codes).toHaveLength(1);
    expect(evidence).not.toContain(POOL_CODE);
    expect(evidence).not.toContain("Listener@Example.com");
    expect(evidence).not.toContain("listener@example.com");
    expect(fixture.codes[0].code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.codes[0].recipient_email_lookup_hash)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps an out-of-order revocation final", async () => {
    const fixture = bridgeDatabase();
    const env = bridgeEnv(fixture.db);
    const revoke = {
      eventId: "event_pool_revoke_1",
      grantId: "grant_pool_tombstone_1",
      action: "revoke"
    };
    const grant = {
      eventId: "event_pool_grant_after_revoke_1",
      grantId: "grant_pool_tombstone_1",
      action: "grant",
      showSlug: "opera-en-la-selva",
      email: "listener@example.com",
      code: POOL_CODE,
      durationDays: 365
    };

    expect((await handlePoolGrantEvent(
      await signedBridgeRequest(
        revoke,
        env.POOL_PODCAST_BRIDGE_SECRET as string
      ),
      env
    )).status).toBe(200);
    const response = await handlePoolGrantEvent(
      await signedBridgeRequest(
        grant,
        env.POOL_PODCAST_BRIDGE_SECRET as string
      ),
      env
    );
    const payload = await response.json() as { status: string };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("revoked");
    expect(fixture.codes).toHaveLength(0);
  });
});

describe("authenticated Pool code redemption", () => {
  it("atomically creates an independent Pool source without storing the raw code", async () => {
    const csrfToken = "pool_csrf_fixture";
    const sessionSecret = "pool_listener_session_secret";
    const emailPepper = "pool_listener_email_pepper";
    const emailHash = await hmacSha256(
      "listener@example.com",
      emailPepper,
      "hex"
    );
    const fixture = redemptionDatabase({
      csrfHash: await sha256Hex(`${sessionSecret}:${csrfToken}`),
      recipientEmailHash: emailHash,
      listenerEmailHash: emailHash
    });
    const response = await redeemPoolCode(
      redemptionRequest(csrfToken),
      redemptionEnv(fixture.db, sessionSecret, emailPepper)
    );
    const payload = await response.json() as {
      redemption: {
        show: { slug: string };
        status: string;
        currentPeriodEnd: string | null;
      };
      idempotent: boolean;
    };
    const evidence = JSON.stringify(fixture.writes);

    expect(response.status).toBe(201);
    expect(payload.idempotent).toBe(false);
    expect(payload.redemption).toMatchObject({
      show: { slug: "opera-en-la-selva" },
      status: "active"
    });
    expect(Date.parse(payload.redemption.currentPeriodEnd as string))
      .toBeGreaterThan(Date.now() + 364 * 24 * 60 * 60 * 1_000);
    expect(fixture.source?.provider_subscription_id)
      .toBe("grant_pool_fixture_1");
    expect(fixture.redemptionId).toBeTruthy();
    expect(evidence).not.toContain(POOL_CODE);
    expect(evidence).not.toContain("listener@example.com");
  });

  it("uses the same not-available response for the wrong verified email", async () => {
    const csrfToken = "pool_csrf_fixture";
    const sessionSecret = "pool_listener_session_secret";
    const fixture = redemptionDatabase({
      csrfHash: await sha256Hex(`${sessionSecret}:${csrfToken}`),
      recipientEmailHash: "a".repeat(64),
      listenerEmailHash: "b".repeat(64)
    });
    const response = await redeemPoolCode(
      redemptionRequest(csrfToken),
      redemptionEnv(
        fixture.db,
        sessionSecret,
        "pool_listener_email_pepper"
      )
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "redemption_code_not_available"
    });
    expect(fixture.batchCount).toBe(0);
  });
});

function bridgeEnv(db: D1Database): PodcastEnv {
  return {
    DB: db,
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    POOL_REDEMPTION_ENABLED: "true",
    POOL_PODCAST_BRIDGE_SECRET: "pool_bridge_secret_fixture",
    POOL_REDEMPTION_CODE_PEPPER: "pool_code_pepper_fixture",
    LISTENER_EMAIL_LOOKUP_PEPPER: "listener_email_pepper_fixture"
  } as unknown as PodcastEnv;
}

async function signedBridgeRequest(
  body: Record<string, unknown>,
  secret: string
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    secret,
    "hex"
  );
  return new Request(
    "https://feeds.dustwave.xyz/v1/internal/pool/grants",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pool-podcast-timestamp": String(timestamp),
        "x-pool-podcast-signature": signature
      },
      body: rawBody
    }
  );
}

function bridgeDatabase() {
  const events = new Map<string, {
    event_id: string;
    provider_grant_id: string;
    action: "grant" | "revoke";
    body_sha256: string;
    status: "received" | "processed" | "failed";
  }>();
  const codes: Array<Record<string, unknown>> = [];
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("FROM pool_grant_events") && query.includes(
            "WHERE event_id = ?"
          )) {
            return events.get(String(values[0])) ?? null;
          }
          if (query.includes("FROM shows")) {
            return { id: "show_opera_en_la_selva" };
          }
          if (
            query.includes("FROM pool_grant_events")
            && query.includes("action = 'revoke'")
          ) {
            return [...events.values()].find((event) =>
              event.provider_grant_id === values[0]
              && event.action === "revoke"
              && event.status === "processed"
            ) ?? null;
          }
          if (query.includes("FROM redemption_codes")) {
            return codes.find((code) =>
              code.provider_grant_id === values[0]
            ) ?? null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          if (query.includes("INSERT OR IGNORE INTO pool_grant_events")) {
            const eventId = String(values[0]);
            if (!events.has(eventId)) {
              events.set(eventId, {
                event_id: eventId,
                provider_grant_id: String(values[1]),
                action: values[2] as "grant" | "revoke",
                body_sha256: String(values[3]),
                status: "received"
              });
            }
          }
          if (query.includes("INSERT INTO redemption_codes")) {
            codes.push({
              id: values[0],
              code_hash: values[1],
              show_id: values[2],
              duration_days: values[3],
              expires_at: values[4],
              provider_grant_id: values[5],
              recipient_email_lookup_hash: values[6],
              status: "active"
            });
          }
          if (query.includes("UPDATE pool_grant_events")) {
            const eventId = String(values.at(-1));
            const event = events.get(eventId);
            if (event) {
              event.status = query.includes("status = 'processed'")
                ? "processed"
                : "failed";
            }
          }
          return { success: true };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
      return [];
    }
  } as unknown as D1Database;
  return { db, events, codes, writes };
}

function redemptionRequest(csrfToken: string): Request {
  return new Request(
    "https://feeds.dustwave.xyz/v1/member/redemptions/pool",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dustwave.xyz",
        cookie: `${LISTENER_SESSION_COOKIE}=pool_session_fixture`,
        "x-podcast-csrf": csrfToken
      },
      body: JSON.stringify({ code: POOL_CODE })
    }
  );
}

function redemptionEnv(
  db: D1Database,
  sessionSecret: string,
  emailPepper: string
): PodcastEnv {
  return {
    DB: db,
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    LISTENER_SESSION_SECRET: sessionSecret,
    LISTENER_EMAIL_LOOKUP_PEPPER: emailPepper,
    POOL_REDEMPTION_ENABLED: "true",
    POOL_PODCAST_BRIDGE_SECRET: "pool_bridge_secret_fixture",
    POOL_REDEMPTION_CODE_PEPPER: "pool_code_pepper_fixture"
  } as unknown as PodcastEnv;
}

function redemptionDatabase({
  csrfHash,
  recipientEmailHash,
  listenerEmailHash
}: {
  csrfHash: string;
  recipientEmailHash: string;
  listenerEmailHash: string;
}) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  let redemptionId = "";
  let source: {
    price_id: null;
    provider: "pool";
    provider_customer_id: null;
    provider_subscription_id: string;
    status: "active";
    current_period_end: string | null;
  } | null = null;
  let subscription: {
    status: string;
    current_period_end: string | null;
  } | null = null;
  let batchCount = 0;
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("FROM listener_sessions")) {
            return {
              listener_id: "listener_fixture",
              csrf_token_hash: csrfHash
            };
          }
          if (query.includes("RETURNING attempt_count")) {
            return { attempt_count: 1 };
          }
          if (
            query.includes("FROM redemption_codes c")
            && query.includes("JOIN listener_accounts")
          ) {
            return {
              id: "code_pool_fixture",
              show_id: "show_opera_en_la_selva",
              show_slug: "opera-en-la-selva",
              show_title: "Ópera en la Selva",
              provider_grant_id: "grant_pool_fixture_1",
              recipient_email_lookup_hash: recipientEmailHash,
              listener_email_lookup_hash: listenerEmailHash,
              duration_days: 365,
              status: "active",
              expires_at: "2027-07-24T00:00:00.000Z"
            };
          }
          if (query.includes("FROM redemptions")) {
            return redemptionId ? { id: redemptionId } : null;
          }
          if (query.includes("FROM subscription_entitlement_sources")) {
            return source;
          }
          if (query.includes("FROM subscriptions")) {
            return subscription;
          }
          return null;
        },
        async all() {
          if (
            query.includes("FROM subscriptions s")
            && query.includes("JOIN shows")
          ) {
            return { results: [] };
          }
          if (query.includes("FROM subscription_entitlement_sources")) {
            return { results: source ? [source] : [] };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ query, values });
          if (query.includes("INSERT INTO redemptions")) {
            redemptionId = String(values[0]);
          }
          if (query.includes("INSERT INTO subscription_entitlement_sources")) {
            source = {
              price_id: null,
              provider: "pool",
              provider_customer_id: null,
              provider_subscription_id: String(values[3]),
              status: "active",
              current_period_end: values[4] as string | null
            };
          }
          if (query.includes("INSERT INTO subscriptions")) {
            subscription = {
              status: String(values[7]),
              current_period_end: values[8] as string | null
            };
          }
          return { success: true };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      batchCount += 1;
      for (const statement of statements) await statement.run();
      return [];
    }
  } as unknown as D1Database;
  return {
    db,
    writes,
    get redemptionId() {
      return redemptionId;
    },
    get source() {
      return source;
    },
    get batchCount() {
      return batchCount;
    }
  };
}
