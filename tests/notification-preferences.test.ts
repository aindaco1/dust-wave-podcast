import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { LISTENER_SESSION_COOKIE } from "../src/listener-auth";
import {
  updateListenerNotificationPreference
} from "../src/notification-preferences";

describe("listener show notification consent", () => {
  it("records an explicit bilingual opt-in behind member CSRF", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const csrfToken = "csrf_notification_fixture";
    const sessionSecret = "listener_session_fixture";
    const csrfHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
    const db = {
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
                  has_private_feed: 0,
                  has_stripe_billing: 1,
                  announcement_notifications_enabled: 0,
                  notification_language: "es"
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
    const request = new Request(
      "https://feeds.dustwave.xyz/v1/member/shows/opera-en-la-selva/notifications",
      {
        method: "PUT",
        headers: {
          origin: "https://dustwave.xyz",
          "content-type": "application/json",
          "x-podcast-csrf": csrfToken,
          cookie: `${LISTENER_SESSION_COOKIE}=session_token_fixture`
        },
        body: JSON.stringify({ enabled: true, language: "es" })
      }
    );
    const response = await updateListenerNotificationPreference(
      request,
      {
        SITE_ORIGIN: "https://dustwave.xyz",
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        LISTENER_SESSION_SECRET: sessionSecret,
        DB: db
      } as unknown as PodcastEnv,
      "opera-en-la-selva"
    );
    const preferenceWrite = writes.find(({ query }) =>
      query.includes("INSERT INTO show_notification_preferences")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      preference: {
        announcementsEnabled: true,
        language: "es",
        consentSource: "member_account"
      }
    });
    expect(preferenceWrite?.values).toEqual([
      "listener_fixture",
      "show_opera_en_la_selva",
      1,
      "es",
      1,
      1
    ]);
  });

  it("rejects preferences for a show not linked to the member", async () => {
    const csrfToken = "csrf_notification_fixture";
    const sessionSecret = "listener_session_fixture";
    const csrfHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
    const db = {
      prepare(query: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            return query.includes("FROM listener_sessions")
              ? {
                  listener_id: "listener_fixture",
                  csrf_token_hash: csrfHash
                }
              : null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true };
          }
        };
      }
    } as unknown as D1Database;
    const response = await updateListenerNotificationPreference(
      new Request(
        "https://feeds.dustwave.xyz/v1/member/shows/unknown/notifications",
        {
          method: "PUT",
          headers: {
            origin: "https://dustwave.xyz",
            "content-type": "application/json",
            "x-podcast-csrf": csrfToken,
            cookie: `${LISTENER_SESSION_COOKIE}=session_token_fixture`
          },
          body: JSON.stringify({ enabled: true, language: "en" })
        }
      ),
      {
        SITE_ORIGIN: "https://dustwave.xyz",
        ALLOWED_ORIGINS: "https://dustwave.xyz",
        LISTENER_SESSION_SECRET: sessionSecret,
        DB: db
      } as unknown as PodcastEnv,
      "unknown"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "show_subscription_not_found"
    });
  });
});
