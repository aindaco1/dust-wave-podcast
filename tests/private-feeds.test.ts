import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { LISTENER_SESSION_COOKIE } from "../src/listener-auth";
import {
  createListenerPrivateFeed,
  privateFeedTokenNeedsTouch
} from "../src/private-feeds";

describe("listener private-feed management", () => {
  it("returns a bearer URL once while persisting only its HMAC", async () => {
    const csrfToken = "csrf_fixture";
    const sessionSecret = "listener_session_fixture";
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const db = privateFeedDatabase(
      await sha256Hex(`${sessionSecret}:${csrfToken}`),
      writes
    );
    const response = await createListenerPrivateFeed(
      new Request(
        "https://feeds.dustwave.xyz/v1/member/shows/opera-en-la-selva/feed",
        {
          method: "POST",
          headers: {
            origin: "https://dustwave.xyz",
            cookie: `${LISTENER_SESSION_COOKIE}=session_fixture`,
            "x-podcast-csrf": csrfToken
          }
        }
      ),
      {
        ENVIRONMENT: "staging",
        SITE_ORIGIN: "https://dustwave.xyz",
        FEED_ORIGIN: "https://feeds.dustwave.xyz",
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        DB: db,
        LISTENER_SESSION_SECRET: sessionSecret,
        FEED_TOKEN_PEPPER: "private_feed_pepper_fixture"
      } as unknown as PodcastEnv,
      "opera-en-la-selva"
    );
    const payload = await response.json() as {
      feed: { url: string; shownOnce: boolean };
    };
    const rawToken = new URL(payload.feed.url).pathname.split("/")[3];
    const insert = writes.find(({ query }) =>
      query.includes("INSERT INTO private_feed_tokens")
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.feed.shownOnce).toBe(true);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(insert?.values).not.toContain(rawToken);
    expect(insert?.values[3]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("touches inactive usage metadata only once per hour", () => {
    const now = Date.parse("2026-07-24T18:00:00Z");

    expect(privateFeedTokenNeedsTouch(null, now)).toBe(true);
    expect(
      privateFeedTokenNeedsTouch("2026-07-24 17:00:00", now)
    ).toBe(true);
    expect(
      privateFeedTokenNeedsTouch("2026-07-24T17:30:00Z", now)
    ).toBe(false);
    expect(privateFeedTokenNeedsTouch("not-a-date", now)).toBe(true);
  });
});

function privateFeedDatabase(
  csrfHash: string,
  writes: Array<{ query: string; values: unknown[] }>
): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("FROM listener_sessions")) {
            return {
              listener_id: "listener_fixture",
              csrf_token_hash: csrfHash
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
                has_private_feed: 0
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
    }
  } as unknown as D1Database;
}
