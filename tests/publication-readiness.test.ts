import { describe, expect, it } from "vitest";

import {
  evaluatePublicationReadiness
} from "../src/publication-readiness";
import {
  publicationPrerequisiteFailures
} from "../src/publication-contract";
import {
  summarizeProductionReviewReadiness
} from "../src/production-reviews";

type ReadinessInput = Parameters<typeof evaluatePublicationReadiness>[0];

describe("publication readiness graph", () => {
  it("keeps the existing publish prerequisites DRY and ordered", () => {
    expect(publicationPrerequisiteFailures({
      title: "",
      summary: "",
      guid: null,
      audioKey: null,
      audioMimeType: null,
      audioBytes: 0,
      durationSeconds: null,
      mediaStatus: "processing"
    })).toEqual([
      "title",
      "summary",
      "guid",
      "delivery audio",
      "audio MIME type",
      "audio byte length",
      "duration",
      "ready media"
    ]);
  });

  it("reports a strict candidate without enforcing it", () => {
    const result = evaluatePublicationReadiness(readyInput());

    expect(result.legacyGate).toEqual({ ready: true, missing: [] });
    expect(result.candidateGate).toEqual({
      ready: true,
      blockerCount: 0,
      warningCount: 0,
      publishingEnforced: false,
      overrideAvailable: false
    });
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "editorial.word_alignment",
        status: "ready",
        severity: "blocker"
      }),
      expect.objectContaining({
        id: "core.working_master",
        status: "ready",
        severity: "blocker"
      }),
      expect.objectContaining({
        id: "distribution.youtube",
        status: "not_applicable"
      }),
      expect.objectContaining({
        id: "distribution.directories",
        status: "ready",
        evidence: expect.objectContaining({ enabled: 11, setupComplete: 11 })
      })
    ]));
  });

  it("fails closed on stale ads and failed release evidence without inventing bonus media", () => {
    const input = readyInput();
    input.episode.access = "premium_bonus";
    input.episode.public_at = "2026-08-01T12:00:00.000Z";
    input.episode.premium_at = "2026-07-31T12:00:00.000Z";
    input.episode.show_premium_enabled = 1;
    input.publicationFingerprintCurrent = false;
    input.episode.dynamic_ads_enabled = 1;
    input.episode.show_dynamic_ads_enabled = 1;
    input.episode.video_source_key = "podcasts/source/video.mp4";
    input.adPlan = {
      id: "adplan_1",
      revision: 2,
      status: "approved",
      source_object_key: "podcasts/stale.mp3",
      source_object_bytes: 1_000,
      source_object_etag: "stale-etag",
      processor_manifest_sha256: "a".repeat(64),
      approved_marker_count: 1,
      segment_count: 3,
      ready_segment_count: 3
    };
    input.jobs = [{
      destination: "rss",
      status: "failed",
      publication_revision: 2,
      site_status: null
    }];

    const result = evaluatePublicationReadiness(input);
    expect(result.candidateGate.ready).toBe(false);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "core.metadata",
        status: "stale"
      }),
      expect.objectContaining({
        id: "monetization.dynamic_ads",
        status: "stale"
      }),
      expect.objectContaining({
        id: "distribution.news",
        status: "ready",
        evidence: expect.objectContaining({ pageMode: "premium_teaser" })
      }),
      expect.objectContaining({
        id: "distribution.rss",
        status: "failed"
      }),
      expect.objectContaining({
        id: "distribution.youtube",
        status: "not_applicable"
      })
    ]));
  });
});

describe("production review readiness semantics", () => {
  it("requires a review for every exact current target", () => {
    const targets = [
      {
        type: "source_audio" as const,
        id: "episode_1",
        revision: 1,
        digest: "etag"
      },
      {
        type: "transcript" as const,
        id: "transcript_1",
        revision: 2,
        digest: "a".repeat(64)
      }
    ];
    expect(summarizeProductionReviewReadiness(
      targets,
      [{ id: "review_audio", status: "approved" }],
      []
    )).toMatchObject({
      currentTargetCount: 2,
      currentReviewCount: 1,
      approvedCurrentReviewCount: 1,
      unreviewedCurrentTargetCount: 1,
      reviewReady: false
    });
    expect(summarizeProductionReviewReadiness(
      targets,
      [
        { id: "review_audio", status: "approved" },
        { id: "review_transcript", status: "approved" }
      ],
      []
    )).toMatchObject({
      currentTargetCount: 2,
      unreviewedCurrentTargetCount: 0,
      reviewReady: true
    });
  });

  it("fails closed when blockers are open or bounded evidence truncates", () => {
    const targets = [{
      type: "source_audio" as const,
      id: "episode_1",
      revision: 1,
      digest: "etag"
    }];
    const reviews = [{ id: "review_audio", status: "approved" }];
    expect(summarizeProductionReviewReadiness(
      targets,
      reviews,
      [{
        reviewId: "review_audio",
        blocker: true,
        resolutionStatus: "open"
      }]
    )).toMatchObject({
      openBlockerCount: 1,
      reviewReady: false
    });
    expect(summarizeProductionReviewReadiness(
      targets,
      reviews,
      [],
      true
    )).toMatchObject({
      evidenceTruncated: true,
      reviewReady: false
    });
  });
});

function readyInput(): ReadinessInput {
  return {
    episode: {
      id: "episode_1",
      show_id: "show_1",
      status: "draft",
      access: "public",
      explicit: 0,
      title: "Episode one",
      summary: "A complete summary.",
      content_html: "<p>Notes</p>",
      guid: "urn:uuid:episode-1",
      canonical_url:
        "https://dustwave.xyz/news/podcasts/opera/episode-one/",
      public_at: null,
      premium_at: null,
      audio_key: "podcasts/episode-1.mp3",
      audio_mime_type: "audio/mpeg",
      audio_bytes: 1_000,
      audio_etag: "audio-etag",
      duration_seconds: 60,
      media_status: "ready",
      video_source_key: null,
      publication_revision: 1,
      publication_fingerprint: null,
      publication_evidence_version: 7,
      show_evidence_version: 3,
      global_evidence_version: 2,
      dynamic_ads_enabled: 0,
      show_status: "active",
      show_slug: "opera",
      show_language: "es",
      show_rss_slug: "opera",
      show_youtube_channel_url:
        "https://www.youtube.com/@dustwavecollective",
      show_premium_enabled: 1,
      show_dynamic_ads_enabled: 0,
      working_master_revision: 1,
      current_master_id: "master_episode_1",
      working_master_origin_kind: "source_original",
      working_master_source_sha256: "d".repeat(64),
      working_master_qc_report_sha256: "e".repeat(64)
    },
    publicationFingerprintCurrent: null,
    transcripts: [
      {
        id: "transcript_es",
        language: "es",
        status: "approved",
        revision: 2,
        approved_revision: 2,
        content_sha256: "a".repeat(64),
        alignment_status: "passed",
        alignment_transcript_sha256: "a".repeat(64)
      },
      {
        id: "transcript_en",
        language: "en",
        status: "approved",
        revision: 1,
        approved_revision: 1,
        content_sha256: "b".repeat(64),
        alignment_status: "passed",
        alignment_transcript_sha256: "b".repeat(64)
      }
    ],
    chapters: {
      status: "approved",
      revision: 1,
      approved_revision: 1,
      content_sha256: "c".repeat(64)
    },
    clips: {
      total: 1,
      current_count: 1,
      ready_render_count: 1
    },
    adPlan: null,
    directories: {
      total: 11,
      enabled: 11,
      setup_complete: 11
    },
    jobs: [],
    reviews: {
      currentTargetCount: 5,
      currentReviewCount: 5,
      approvedCurrentReviewCount: 5,
      unreviewedCurrentTargetCount: 0,
      openBlockerCount: 0,
      evidenceTruncated: false,
      reviewReady: true,
      publishingEnforced: false
    },
    githubPublishMode: "dry_run",
    youtubePublishMode: "dry_run"
  };
}
