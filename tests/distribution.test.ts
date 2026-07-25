import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  listDistributionDestinations,
  updateShowDistributionDestination
} from "../src/distribution";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";

describe("streamlined publishing directory registry", () => {
  it("returns one role-scoped show feed and normalized directory readiness", async () => {
    const fixture = await distributionFixture({ role: "analyst" });
    const response = await listDistributionDestinations(
      fixture.request(
        "/v1/admin/distribution?showId=show_opera_en_la_selva"
      ),
      fixture.env
    );
    const payload = await response.json() as {
      showId: string;
      feedUrl: string;
      semantics: string;
      summary: {
        total: number;
        setupComplete: number;
        setupRequired: number;
        observed: number;
      };
      destinations: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      showId: "show_opera_en_la_selva",
      feedUrl:
        "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml",
      semantics: "rss-follow-after-one-time-owner-setup",
      summary: {
        total: 2,
        setupComplete: 1,
        setupRequired: 1,
        observed: 0
      }
    });
    expect(payload.destinations).toEqual([
      expect.objectContaining({
        id: "spotify",
        enabled: true,
        ownerSetupStatus: "verified",
        submissionUrl: "https://podcasters.spotify.com/",
        publicationStatus: null
      }),
      expect.objectContaining({
        id: "apple_podcasts",
        enabled: true,
        ownerSetupStatus: "not_started"
      })
    ]);
    expect(JSON.stringify(payload.destinations)).not.toContain(
      "owner_setup_status"
    );
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("show_distribution_destinations")
        && values[0] === "show_opera_en_la_selva"
      )
    ).toBe(true);
  });

  it("hides an episode in a different role scope", async () => {
    const fixture = await distributionFixture({
      role: "analyst",
      roleShowId: "show_other",
      episodeShowId: "show_opera_en_la_selva"
    });
    const response = await listDistributionDestinations(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution"
      ),
      fixture.env,
      "episode_opera"
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "episode_not_found" });
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("FROM distribution_destinations")
      )
    ).toBe(false);
  });

  it("lets a show-scoped admin record owner setup without provider secrets", async () => {
    const fixture = await distributionFixture({ role: "admin" });
    const response = await updateShowDistributionDestination(
      fixture.request(
        "/v1/admin/shows/show_opera_en_la_selva/distribution/spotify",
        {
          method: "PATCH",
          body: {
            enabled: true,
            ownerSetupStatus: "verified",
            listingUrl:
              "https://open.spotify.com/show/dust-wave-fixture"
          }
        }
      ),
      fixture.env,
      "show_opera_en_la_selva",
      "spotify"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: true,
      showId: "show_opera_en_la_selva",
      destinationId: "spotify",
      enabled: true,
      ownerSetupStatus: "verified",
      listingUrl:
        "https://open.spotify.com/show/dust-wave-fixture"
    });
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("INSERT INTO show_distribution_destinations")
        && values.includes("verified")
        && values.includes("https://open.spotify.com/show/dust-wave-fixture")
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(true);
  });

  it("rejects unsafe listing URLs before changing setup state", async () => {
    const fixture = await distributionFixture({ role: "admin" });
    await expect(
      updateShowDistributionDestination(
        fixture.request(
          "/v1/admin/shows/show_opera_en_la_selva/distribution/spotify",
          {
            method: "PATCH",
            body: {
              ownerSetupStatus: "verified",
              listingUrl: "javascript:alert(1)"
            }
          }
        ),
        fixture.env,
        "show_opera_en_la_selva",
        "spotify"
      )
    ).rejects.toThrow(/HTTPS URL/);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("INSERT INTO show_distribution_destinations")
      )
    ).toBe(false);
  });
});

async function distributionFixture({
  role,
  roleShowId = "show_opera_en_la_selva",
  episodeShowId = "show_opera_en_la_selva"
}: {
  role: "admin" | "analyst";
  roleShowId?: string;
  episodeShowId?: string;
}) {
  const sessionSecret = "distribution-session-secret";
  const csrfToken = "distribution-csrf-token";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          queries.push({ query, values });
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_distribution_fixture",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (
            query.includes("duration_seconds")
            && query.includes("FROM episodes")
          ) {
            return {
              id: "episode_opera",
              show_id: episodeShowId,
              duration_seconds: 600,
              audio_key: "podcasts/episode.mp3",
              audio_bytes: 1_000,
              audio_etag: "etag",
              audio_mime_type: "audio/mpeg",
              media_status: "ready"
            };
          }
          if (query.includes("SELECT id, title, rss_slug")) {
            return {
              id: "show_opera_en_la_selva",
              title: "Ópera en la Selva",
              rss_slug: "opera-en-la-selva"
            };
          }
          if (
            query.includes("FROM shows s")
            && query.includes("JOIN distribution_destinations")
          ) {
            return {
              id: "spotify",
              enabled: 1,
              owner_setup_status: "not_started",
              listing_url: null
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role, show_id: roleShowId }]
            };
          }
          if (query.includes("FROM distribution_destinations")) {
            return {
              results: [
                destinationRow({
                  id: "spotify",
                  name: "Spotify",
                  owner_setup_status: "verified",
                  owner_verified_at: "2026-07-25 00:00:00"
                }),
                destinationRow({
                  id: "apple_podcasts",
                  name: "Apple Podcasts",
                  submission_url:
                    "https://podcastsconnect.apple.com/"
                })
              ]
            };
          }
          return { results: [] };
        },
        async run() {
          queries.push({ query, values });
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret
  } as unknown as PodcastEnv;
  return {
    env,
    queries,
    request(
      path: string,
      {
        method = "GET",
        body
      }: {
        method?: string;
        body?: Record<string, unknown>;
      } = {}
    ) {
      return new Request(`https://feeds.dustwave.xyz${path}`, {
        method,
        headers: {
          cookie:
            `${ADMIN_SESSION_COOKIE}=distribution-session-token`,
          origin: "https://dustwave.xyz",
          "content-type": "application/json",
          "x-podcast-csrf": csrfToken
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    }
  };
}

function destinationRow(
  overrides: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    id: "destination_fixture",
    name: "Directory",
    mode: "rss_directory",
    enabled: 1,
    owner_setup_status: "not_started",
    submission_url: "https://podcasters.spotify.com/",
    listing_url: null,
    owner_verified_at: null,
    last_checked_at: null,
    setup_error: null,
    publication_status: null,
    last_observed_at: null,
    publication_error: null,
    publication_revision: null,
    ...overrides
  };
}
