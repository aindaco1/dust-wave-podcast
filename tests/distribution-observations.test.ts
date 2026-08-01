import { describe, expect, it, vi } from "vitest";

import {
  probeDistributionListing,
  scheduleAutomaticDistributionObservations
} from "../src/distribution-observations";
import type { PodcastEnv } from "../src/env";

describe("automatic directory observation", () => {
  it("confirms an allowlisted listing using bounded provider identity", async () => {
    const fetcher = vi.fn(async () => new Response(
      "<html><title>Opera en la Selva | Spotify</title></html>",
      { status: 200, headers: { "content-type": "text/html" } }
    ));

    await expect(probeDistributionListing({
      destinationId: "spotify",
      listingUrl: "https://open.spotify.com/show/dust-wave-fixture",
      expectedLabels: ["Ópera en la Selva"],
      fetcher: fetcher as typeof fetch
    })).resolves.toEqual({
      status: "observed",
      evidenceUrl: "https://open.spotify.com/show/dust-wave-fixture",
      error: null
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://open.spotify.com/show/dust-wave-fixture",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
  });

  it("allows bounded redirects only inside the destination host registry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://www.youtube.com/playlist?list=fixture" }
      }))
      .mockResolvedValueOnce(new Response(
        "<title>Ópera en la Selva - YouTube Music</title>",
        { status: 200, headers: { "content-type": "text/html" } }
      ));

    await expect(probeDistributionListing({
      destinationId: "youtube_music",
      listingUrl: "https://music.youtube.com/playlist?list=fixture",
      expectedLabels: ["Ópera en la Selva"],
      fetcher: fetcher as typeof fetch
    })).resolves.toMatchObject({
      status: "observed",
      evidenceUrl: "https://www.youtube.com/playlist?list=fixture"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "unregistered destination host",
      "spotify",
      "https://example.com/show/fixture",
      "listing_url_not_allowlisted"
    ],
    [
      "lookalike destination host",
      "spotify",
      "https://open.spotify.com.attacker.example/show/fixture",
      "listing_url_not_allowlisted"
    ],
    [
      "embedded credentials",
      "spotify",
      "https://user:password@open.spotify.com/show/fixture",
      "listing_url_not_allowlisted"
    ]
  ])("rejects %s before network access", async (
    _label,
    destinationId,
    listingUrl,
    error
  ) => {
    const fetcher = vi.fn();
    await expect(probeDistributionListing({
      destinationId,
      listingUrl,
      expectedLabels: ["Ópera en la Selva"],
      fetcher: fetcher as typeof fetch
    })).resolves.toEqual({ status: "failed", evidenceUrl: null, error });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a private or arbitrary origin", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    }));
    await expect(probeDistributionListing({
      destinationId: "spotify",
      listingUrl: "https://open.spotify.com/show/fixture",
      expectedLabels: ["Ópera en la Selva"],
      fetcher: fetcher as typeof fetch
    })).resolves.toEqual({
      status: "failed",
      evidenceUrl: null,
      error: "listing_probe_redirect_not_allowlisted"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires a provider page to confirm the show or episode identity", async () => {
    const fetcher = vi.fn(async () => new Response(
      "<html><title>Sign in to continue</title></html>",
      { status: 200, headers: { "content-type": "text/html" } }
    ));
    await expect(probeDistributionListing({
      destinationId: "spotify",
      listingUrl: "https://open.spotify.com/show/fixture",
      expectedLabels: ["Ópera en la Selva", "Primer episodio"],
      fetcher: fetcher as typeof fetch
    })).resolves.toMatchObject({
      status: "failed",
      error: "listing_probe_identity_not_confirmed"
    });
  });

  it("rejects oversized listing responses before reading the body", async () => {
    const fetcher = vi.fn(async () => new Response("small fixture", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": String(512 * 1024 + 1)
      }
    }));
    await expect(probeDistributionListing({
      destinationId: "spotify",
      listingUrl: "https://open.spotify.com/show/fixture",
      expectedLabels: ["Ópera en la Selva"],
      fetcher: fetcher as typeof fetch
    })).resolves.toMatchObject({
      status: "failed",
      error: "listing_probe_response_too_large"
    });
  });

  it("records one due staging candidate and advances its probe clock", async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            values = bound;
            queries.push({ query, values });
            return statement;
          },
          async all() {
            return {
              results: [{
                publication_id: "publication_fixture",
                show_id: "show_opera_en_la_selva",
                show_title: "Ópera en la Selva",
                episode_id: "episode_fixture",
                episode_title: "El bosque escucha",
                destination_id: "spotify",
                publication_revision: 1,
                publication_status: "waiting_for_feed",
                evidence_url: null,
                evidence_source: null,
                last_error: null,
                listing_url: "https://open.spotify.com/show/fixture"
              }]
            };
          },
          async first() {
            return {
              status: "observed",
              evidence_url: "https://open.spotify.com/show/fixture",
              evidence_source: "automated_probe",
              last_error: null,
              event_id: values[0],
              audit_id: values[1]
            };
          },
          async run() {
            return { success: true };
          }
        };
        return statement;
      },
      async batch() {
        return [{ success: true }, { success: true }, { success: true }];
      }
    } as unknown as D1Database;
    const env = {
      ENVIRONMENT: "staging",
      DISTRIBUTION_OBSERVATION_MODE: "staging_probe",
      DB: db
    } as unknown as PodcastEnv;
    const fetcher = vi.fn(async () => new Response(
      "<title>Ópera en la Selva on Spotify</title>",
      { status: 200, headers: { "content-type": "text/html" } }
    ));

    await expect(scheduleAutomaticDistributionObservations(
      env,
      fetcher as typeof fetch
    )).resolves.toBe(1);
    expect(queries.some(({ query, values }) =>
      query.includes("FROM episode_publications publication")
      && values.includes("dustwave-rss-launch-v3")
      && values.includes(4)
    )).toBe(true);
    expect(queries.some(({ query, values }) =>
      query.includes("UPDATE show_distribution_destinations")
      && values.includes("show_opera_en_la_selva")
      && values.includes("spotify")
    )).toBe(true);
  });

  it("never reads production or a disabled staging database", async () => {
    const env = (environment: string, mode: string) => ({
      ENVIRONMENT: environment,
      DISTRIBUTION_OBSERVATION_MODE: mode,
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    }) as unknown as PodcastEnv;

    await expect(scheduleAutomaticDistributionObservations(
      env("production", "staging_probe")
    )).resolves.toBe(0);
    await expect(scheduleAutomaticDistributionObservations(
      env("staging", "disabled")
    )).resolves.toBe(0);
  });

  it("fails a staging candidate scan closed", async () => {
    const env = {
      ENVIRONMENT: "staging",
      DISTRIBUTION_OBSERVATION_MODE: "staging_probe",
      DB: {
        prepare() {
          throw new TypeError("schema unavailable");
        }
      }
    } as unknown as PodcastEnv;

    await expect(scheduleAutomaticDistributionObservations(env))
      .resolves.toBe(0);
  });
});
