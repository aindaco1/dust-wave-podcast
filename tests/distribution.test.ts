import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  listDistributionDestinations,
  retryDistributionJob,
  updateEpisodeDistributionObservation,
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
        ingestionObserved: number;
        failureRecoveryVerified: number;
        certified: number;
      };
      launchClaim: {
        ready: boolean;
        requiredDestinations: number;
        certifiedDestinations: number;
        remainingDestinations: number;
        feedValidation: Record<string, unknown>;
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
        observed: 0,
        ingestionObserved: 1,
        failureRecoveryVerified: 1,
        certified: 1
      },
      launchClaim: {
        ready: false,
        requiredDestinations: 10,
        certifiedDestinations: 1,
        remainingDestinations: 9,
        feedValidation: {
          status: "valid",
          itemCount: 1
        }
      }
    });
    expect(payload.destinations).toEqual([
      expect.objectContaining({
        id: "spotify",
        enabled: true,
        ownerSetupStatus: "verified",
        submissionUrl: "https://podcasters.spotify.com/",
        ownerAccountLabel: "Dust Wave operations",
        submissionDate: "2026-07-24",
        submissionEvidenceUrl:
          "https://podcasters.spotify.com/show/dust-wave-fixture",
        setupNotes: "Ownership verified without storing credentials.",
        publicationStatus: null,
        certification: {
          ownerVerified: true,
          feedValidated: true,
          ingestionObserved: true,
          failureRecoveryVerified: true,
          certified: true
        }
      }),
      expect.objectContaining({
        id: "apple_podcasts",
        enabled: true,
        ownerSetupStatus: "not_started",
        certification: expect.objectContaining({
          ownerVerified: false,
          certified: false
        })
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

  it("reports the latest root release channels without hiding failures", async () => {
    const fixture = await distributionFixture({ role: "analyst" });
    const response = await listDistributionDestinations(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution"
      ),
      fixture.env,
      "episode_opera"
    );
    const payload = await response.json() as {
      release: {
        publicationRevision: number;
        status: string;
        succeeded: number;
        failed: number;
        channels: Array<Record<string, unknown>>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.release).toMatchObject({
      publicationRevision: 3,
      status: "needs_attention",
      succeeded: 2,
      failed: 1
    });
    expect(payload.release.channels).toEqual([
      expect.objectContaining({
        id: "rss",
        name: "Canonical RSS",
        status: "succeeded",
        providerEvidence: "dynamic-feed"
      }),
      expect.objectContaining({
        id: "news",
        name: "Canonical News page",
        status: "succeeded",
        siteStatus: "succeeded",
        siteCommitSha: "abc123"
      }),
      expect.objectContaining({
        id: "youtube",
        name: "YouTube",
        status: "failed",
        retryable: false,
        error: "controlled test is not configured",
        youtubePublication: expect.objectContaining({
          id: "episode_youtube_fixture",
          status: "reconciliation_required",
          privacyStatus: "unlisted",
          failureCode: "youtube_worker_interrupted"
        })
      })
    ]);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("FROM distribution_jobs")
        && query.includes("MAX(latest.publication_revision)")
        && values.join(",") === "episode_opera,episode_opera"
      )
    ).toBe(true);
  });

  it("retries one failed current-revision root job with audit and queue evidence", async () => {
    const fixture = await distributionFixture({ role: "producer" });
    const response = await retryDistributionJob(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution/youtube/retry",
        {
          method: "POST",
          body: { publicationRevision: 3 }
        }
      ),
      fixture.env,
      "episode_opera",
      "youtube"
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      queued: true,
      idempotent: false,
      delivery: "immediate",
      episodeId: "episode_opera",
      destination: "youtube",
      publicationRevision: 3
    });
    expect(fixture.sentJobs).toEqual([
      expect.objectContaining({
        id: "job_youtube_revision_3",
        type: "publish-youtube",
        episodeId: "episode_opera",
        publicationRevision: 3
      })
    ]);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("distribution.job_retried")
        || (
          query.includes("INSERT INTO admin_audit_events")
          && values.includes("distribution.job_retried")
        )
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("status = 'queued'")
        && query.includes("status = 'failed'")
        && values.join(",") === "job_youtube_revision_3,3"
      )
    ).toBe(true);
  });

  it("rejects a stale release retry without mutating or queueing", async () => {
    const fixture = await distributionFixture({
      role: "producer",
      currentPublicationRevision: 4
    });
    const response = await retryDistributionJob(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution/news/retry",
        {
          method: "POST",
          body: { publicationRevision: 3 }
        }
      ),
      fixture.env,
      "episode_opera",
      "news"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "stale_publication_revision",
      currentPublicationRevision: 4
    });
    expect(fixture.sentJobs).toEqual([]);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(false);
  });

  it("records current-revision directory observation with bounded HTTPS evidence", async () => {
    const fixture = await distributionFixture({ role: "producer" });
    const response = await updateEpisodeDistributionObservation(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution/spotify",
        {
          method: "PATCH",
          body: {
            publicationRevision: 3,
            status: "observed",
            evidenceUrl:
              "https://open.spotify.com/episode/dust-wave-fixture",
            error: ""
          }
        }
      ),
      fixture.env,
      "episode_opera",
      "spotify"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: true,
      idempotent: false,
      episodeId: "episode_opera",
      destinationId: "spotify",
      publicationRevision: 3,
      status: "observed",
      evidenceUrl:
        "https://open.spotify.com/episode/dust-wave-fixture"
    });
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("distribution.directory_observed")
        || (
          query.includes("INSERT INTO admin_audit_events")
          && values.includes("distribution.directory_observed")
        )
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("UPDATE episode_publications")
        && query.includes("evidence_source = 'manual_review'")
        && values.includes(
          "https://open.spotify.com/episode/dust-wave-fixture"
        )
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("INSERT INTO distribution_observation_events")
        && values.includes("show_opera_en_la_selva")
        && values.includes("spotify")
        && values.includes("observed")
      )
    ).toBe(true);
  });

  it("requires evidence for an observed directory before any state mutation", async () => {
    const fixture = await distributionFixture({ role: "producer" });
    await expect(
      updateEpisodeDistributionObservation(
        fixture.request(
          "/v1/admin/episodes/episode_opera/distribution/spotify",
          {
            method: "PATCH",
            body: {
              publicationRevision: 3,
              status: "observed",
              evidenceUrl: "",
              error: ""
            }
          }
        ),
        fixture.env,
        "episode_opera",
        "spotify"
      )
    ).rejects.toThrow(/evidenceUrl is required/);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("UPDATE episode_publications")
      )
    ).toBe(false);
  });

  it("rejects observation while owner setup is incomplete", async () => {
    const fixture = await distributionFixture({
      role: "producer",
      observationOwnerSetupStatus: "pending"
    });
    const response = await updateEpisodeDistributionObservation(
      fixture.request(
        "/v1/admin/episodes/episode_opera/distribution/spotify",
        {
          method: "PATCH",
          body: {
            publicationRevision: 3,
            status: "failed",
            evidenceUrl: "",
            error: "The provider dashboard still shows setup pending."
          }
        }
      ),
      fixture.env,
      "episode_opera",
      "spotify"
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "directory_not_ready_for_observation",
      ownerSetupStatus: "pending"
    });
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("UPDATE episode_publications")
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
              "https://open.spotify.com/show/dust-wave-fixture",
            ownerAccountLabel: "Dust Wave operations",
            submissionDate: "2026-07-24",
            submissionEvidenceUrl:
              "https://podcasters.spotify.com/show/dust-wave-fixture",
            setupNotes:
              "Ownership verified. Do not store passwords or codes."
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
        "https://open.spotify.com/show/dust-wave-fixture",
      ownerAccountLabel: "Dust Wave operations",
      submissionDate: "2026-07-24",
      submissionEvidenceUrl:
        "https://podcasters.spotify.com/show/dust-wave-fixture",
      setupNotes: "Ownership verified. Do not store passwords or codes.",
      reconciledPublications: 1
    });
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("INSERT INTO show_distribution_destinations")
        && values.includes("verified")
        && values.includes("https://open.spotify.com/show/dust-wave-fixture")
        && values.includes("Dust Wave operations")
        && values.includes("2026-07-24")
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("INSERT INTO admin_audit_events")
      )
    ).toBe(true);
    expect(
      fixture.queries.some(({ query, values }) =>
        query.includes("UPDATE episode_publications")
        && query.includes("e.publication_revision")
        && values.join(",")
          === "1,verified,spotify,show_opera_en_la_selva"
      )
    ).toBe(true);
  });

  it("keeps the owner checklist read-only for producers", async () => {
    const fixture = await distributionFixture({ role: "producer" });
    const response = await updateShowDistributionDestination(
      fixture.request(
        "/v1/admin/shows/show_opera_en_la_selva/distribution/spotify",
        {
          method: "PATCH",
          body: {
            ownerAccountLabel: "Dust Wave operations",
            submissionDate: "2026-07-24"
          }
        }
      ),
      fixture.env,
      "show_opera_en_la_selva",
      "spotify"
    );

    expect(response.status).toBe(403);
    expect(
      fixture.queries.some(({ query }) =>
        query.includes("INSERT INTO show_distribution_destinations")
      )
    ).toBe(false);
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

  it("rejects credential-like checklist fields and invalid submission evidence", async () => {
    const fixture = await distributionFixture({ role: "admin" });
    for (const [body, message] of [
      [
        { ownerAccountLabel: "Dust Wave\noperations" },
        /unsupported control characters/
      ],
      [{ submissionDate: "2026-02-30" }, /ISO date/],
      [
        { submissionEvidenceUrl: "https://user:pass@example.com/" },
        /HTTPS URL/
      ],
      [
        { setupNotes: "verification code: 123456" },
        /must not contain provider credentials or verification codes/
      ],
      [
        { providerPassword: "secret" },
        /Only enabled, ownerSetupStatus/
      ]
    ] as const) {
      await expect(
        updateShowDistributionDestination(
          fixture.request(
            "/v1/admin/shows/show_opera_en_la_selva/distribution/spotify",
            { method: "PATCH", body }
          ),
          fixture.env,
          "show_opera_en_la_selva",
          "spotify"
        )
      ).rejects.toThrow(message);
    }
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
  episodeShowId = "show_opera_en_la_selva",
  currentPublicationRevision = 3,
  observationOwnerSetupStatus = "verified"
}: {
  role: "admin" | "producer" | "analyst";
  roleShowId?: string;
  episodeShowId?: string;
  currentPublicationRevision?: number;
  observationOwnerSetupStatus?: string;
}) {
  const sessionSecret = "distribution-session-secret";
  const csrfToken = "distribution-csrf-token";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const sentJobs: Array<Record<string, unknown>> = [];
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
          if (
            query.includes("LEFT JOIN distribution_jobs j")
            && query.includes("current_publication_revision")
          ) {
            return {
              id: "job_youtube_revision_3",
              status: "failed",
              attempt_count: 3,
              current_publication_revision: currentPublicationRevision
            };
          }
          if (
            query.includes("LEFT JOIN episode_publications p")
            && query.includes("current_publication_revision")
          ) {
            return {
              id: "publication_spotify_revision_3",
              status: "waiting_for_feed",
              last_error: null,
              evidence_url: null,
              evidence_source: null,
              current_publication_revision: currentPublicationRevision,
              destination_id: "spotify",
              enabled: 1,
              owner_setup_status: observationOwnerSetupStatus
            };
          }
          if (query.includes("SELECT id, title, rss_slug")) {
            return {
              id: "show_opera_en_la_selva",
              title: "Ópera en la Selva",
              rss_slug: "opera-en-la-selva"
            };
          }
          if (query.includes("FROM show_feed_validations")) {
            return {
              status: "valid",
              feed_url:
                "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml",
              validator_version: "dustwave-rss-launch-v1",
              feed_sha256: "a".repeat(64),
              item_count: 1,
              failure_code: null,
              checked_at: "2026-07-25 00:00:00",
              validated_at: "2026-07-25 00:00:00"
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
              listing_url: null,
              owner_account_label: null,
              submission_date: null,
              submission_evidence_url: null,
              setup_notes: null
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
          if (query.includes("distribution_observation_events")) {
            return {
              results: [
                {
                  destination_id: "spotify",
                  enabled: 1,
                  owner_setup_status: "verified",
                  ingestion_observed: 1,
                  failure_recovery_verified: 1
                },
                {
                  destination_id: "apple_podcasts",
                  enabled: 1,
                  owner_setup_status: "not_started",
                  ingestion_observed: 0,
                  failure_recovery_verified: 0
                }
              ]
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
          if (query.includes("FROM distribution_jobs")) {
            return {
              results: [
                releaseChannelRow({
                  destination: "rss",
                  provider_id: "dynamic-feed"
                }),
                releaseChannelRow({
                  destination: "news",
                  site_status: "succeeded",
                  github_commit_sha: "abc123"
                }),
                releaseChannelRow({
                  destination: "youtube",
                  status: "failed",
                  provider_id: null,
                  last_error: "controlled test is not configured",
                  youtube_publication_id: "episode_youtube_fixture",
                  youtube_publication_status: "reconciliation_required",
                  youtube_privacy_status: "unlisted",
                  youtube_failure_code: "youtube_worker_interrupted",
                  youtube_channel_url:
                    "https://youtube.com/@dustwavecollective",
                  youtube_title: "Episode fixture",
                  youtube_description: "Description fixture",
                  youtube_video_object_bytes: 4,
                  youtube_requested_at: "2026-07-25 00:00:00",
                  youtube_approved_at: "2026-07-25 00:00:01"
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
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    ADMIN_SESSION_SECRET: sessionSecret,
    JOBS: {
      async send(job: Record<string, unknown>) {
        sentJobs.push(job);
      }
    }
  } as unknown as PodcastEnv;
  return {
    env,
    queries,
    sentJobs,
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
    owner_account_label: "Dust Wave operations",
    submission_date: "2026-07-24",
    submission_evidence_url:
      "https://podcasters.spotify.com/show/dust-wave-fixture",
    setup_notes: "Ownership verified without storing credentials.",
    owner_verified_at: null,
    last_checked_at: null,
    setup_error: null,
    publication_status: null,
    last_observed_at: null,
    publication_error: null,
    evidence_url: null,
    evidence_source: null,
    publication_revision: null,
    ...overrides
  };
}

function releaseChannelRow(
  overrides: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    destination: "rss",
    status: "succeeded",
    scheduled_at: "2026-07-25 00:00:00",
    started_at: "2026-07-25 00:00:01",
    completed_at: "2026-07-25 00:00:02",
    provider_id: "fixture",
    attempt_count: 1,
    last_error: null,
    publication_revision: 3,
    site_status: null,
    github_commit_sha: null,
    github_run_id: null,
    site_error: null,
    youtube_publication_id: null,
    youtube_publication_status: null,
    youtube_privacy_status: null,
    youtube_provider_video_id: null,
    youtube_failure_code: null,
    youtube_channel_url: null,
    youtube_title: null,
    youtube_description: null,
    youtube_video_object_bytes: null,
    youtube_requested_at: null,
    youtube_approved_at: null,
    ...overrides
  };
}
