import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";

describe("show settings mutations", () => {
  it("persists canonical HTTPS artwork and YouTube channel destinations", async () => {
    const fixture = await showSettingsFixture();
    const response = await handleRequest(fixture.request({
      title: "Ópera en la Selva",
      artworkUrl:
        "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png",
      youtubeChannelUrl:
        "https://www.youtube.com/@dustwavecollective",
      earlyAccessDays: 7,
      explicit: false
    }), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: true,
      showId: "show_opera_en_la_selva"
    });
    const update = fixture.writes.find(({ query }) =>
      query.includes("UPDATE shows")
    );
    expect(update?.values).toEqual(expect.arrayContaining([
      "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png",
      "https://www.youtube.com/@dustwavecollective",
      7,
      0,
      "show_opera_en_la_selva"
    ]));
    expect(
      fixture.writes.some(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(true);
  });

  it.each([
    [
      { artworkUrl: "http://dustwave.xyz/artwork.png" },
      "artworkUrl must be an HTTPS URL"
    ],
    [
      { artworkUrl: "https://user@dustwave.xyz/artwork.png" },
      "artworkUrl must be an HTTPS URL"
    ],
    [
      { youtubeChannelUrl: "https://example.com/@dustwavecollective" },
      "youtubeChannelUrl must be a canonical YouTube channel URL"
    ],
    [
      {
        youtubeChannelUrl:
          "https://www.youtube.com/watch?v=Kh90GnJJoH8"
      },
      "youtubeChannelUrl must be a canonical YouTube channel URL"
    ]
  ])("rejects unsafe show URL metadata %#", async (body, errorPrefix) => {
    const fixture = await showSettingsFixture();
    const response = await handleRequest(fixture.request(body), fixture.env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: expect.stringContaining(errorPrefix)
    });
    expect(
      fixture.writes.some(({ query }) => query.includes("UPDATE shows"))
    ).toBe(false);
  });

  it("stores cleared optional destinations as null", async () => {
    const fixture = await showSettingsFixture();
    const response = await handleRequest(fixture.request({
      artworkUrl: "",
      youtubeChannelUrl: ""
    }), fixture.env);

    expect(response.status).toBe(200);
    const update = fixture.writes.find(({ query }) =>
      query.includes("UPDATE shows")
    );
    expect(update?.values.slice(0, 2)).toEqual([null, null]);
  });
});

async function showSettingsFixture() {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
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
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("UPDATE shows")) {
            writes.push({ query, values });
            return { id: "show_opera_en_la_selva" };
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
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret
    } as unknown as PodcastEnv,
    writes,
    request(body: Record<string, unknown>) {
      return new Request(
        "https://feeds.dustwave.xyz/v1/admin/shows/show_opera_en_la_selva",
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
