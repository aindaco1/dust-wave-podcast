import { describe, expect, it } from "vitest";

import {
  evaluateEpisodeStagingGate
} from "../scripts/check-episode-staging-gate.mjs";

describe("content-free staging episode gate", () => {
  it("orders a ready enhancement decision ahead of stale delivery work", () => {
    const report = evaluateEpisodeStagingGate(stagingFixture());

    expect(report.summary).toEqual({
      passCount: 4,
      failCount: 0,
      blockCount: 2,
      waitCount: 1,
      deferredCount: 3,
      safeToContinue: true,
      launchReady: false
    });
    expect(report.nextAction).toEqual({
      id: "enhancement_decision",
      label: "Enhancement decision",
      detail: expect.stringContaining("full listen")
    });
    expect(report.nodes).toContainEqual(expect.objectContaining({
      status: "WAIT",
      id: "delivery_audio"
    }));
  });

  it("passes an exact enhanced, reviewed, aligned launch candidate", () => {
    const fixture = stagingFixture();
    fixture.workingMaster.origin_kind = "enhanced_derivative";
    fixture.enhancementDerivatives = [{ status: "approved", count: 1 }];
    fixture.episode.media_status = "ready";
    fixture.episode.delivery_selected = 1;
    fixture.deliveryAudioJobs = [{
      status: "approved",
      count: 1,
      current_selected: 1
    }];
    fixture.productionReviews = [{
      target_type: "source_audio",
      status: "approved",
      count: 1
    }];
    fixture.openReviewBlockers = 0;
    fixture.transcripts[0].status = "approved";
    fixture.transcripts[0].approved_revision = 1;
    fixture.transcripts[0].speaker_labels_confirmed = 1;
    fixture.alignmentRevisions = [{ status: "passed", count: 1 }];
    fixture.chapters = {
      status: "approved",
      revision: 1,
      approved_revision: 1
    };
    fixture.chapterCount = 4;

    const report = evaluateEpisodeStagingGate(fixture);

    expect(report.summary).toEqual({
      passCount: 10,
      failCount: 0,
      blockCount: 0,
      waitCount: 0,
      deferredCount: 0,
      safeToContinue: true,
      launchReady: true
    });
    expect(report.nextAction).toBeNull();
  });

  it("fails closed if a supposedly read-only query reports a write", () => {
    const fixture = stagingFixture();
    fixture.queryMeta[0] = {
      changes: 1,
      rows_written: 1,
      changed_db: true
    };

    const report = evaluateEpisodeStagingGate(fixture);

    expect(report.summary.safeToContinue).toBe(false);
    expect(report.nodes).toContainEqual({
      status: "FAIL",
      id: "read_only",
      label: "Read-only boundary",
      detail: "a remote statement reported database mutation"
    });
  });

  it("keeps deferred editorial enhancements outside launch readiness", () => {
    const fixture = stagingFixture();
    fixture.workingMaster.origin_kind = "enhanced_derivative";
    fixture.enhancementDerivatives = [{ status: "approved", count: 1 }];
    fixture.episode.media_status = "ready";
    fixture.episode.delivery_selected = 1;
    fixture.deliveryAudioJobs = [{
      status: "approved",
      count: 1,
      current_selected: 1
    }];
    fixture.productionReviews = [{
      target_type: "source_audio",
      status: "approved",
      count: 1
    }];
    fixture.openReviewBlockers = 0;

    const report = evaluateEpisodeStagingGate(fixture);

    expect(report.summary).toEqual({
      passCount: 7,
      failCount: 0,
      blockCount: 0,
      waitCount: 0,
      deferredCount: 3,
      safeToContinue: true,
      launchReady: true
    });
    expect(report.nextAction).toBeNull();
    expect(report.nodes.filter(({ status }) => status === "DEFER"))
      .toHaveLength(3);
  });

  it("fails closed when D1 statement metadata is incomplete", () => {
    const fixture = stagingFixture();
    fixture.queryMeta.pop();

    const report = evaluateEpisodeStagingGate(fixture);

    expect(report.summary.safeToContinue).toBe(false);
    expect(report.nodes).toContainEqual(expect.objectContaining({
      status: "FAIL",
      id: "read_only"
    }));
  });

  it("rejects a published or already-dispatched staging fixture", () => {
    const fixture = stagingFixture();
    fixture.episode.status = "published";
    fixture.episode.publication_revision = 2;
    fixture.distributionJobs = [{
      destination: "rss",
      status: "succeeded",
      count: 1
    }];

    const report = evaluateEpisodeStagingGate(fixture);

    expect(report.summary.safeToContinue).toBe(false);
    expect(report.nodes).toContainEqual(expect.objectContaining({
      status: "FAIL",
      id: "episode"
    }));
  });
});

function stagingFixture() {
  return {
    episode: {
      status: "draft",
      access: "public",
      media_status: "processing",
      source_language: "en",
      publication_revision: 0,
      publication_evidence_version: 7,
      delivery_selected: 0
    },
    workingMaster: {
      selected: 1,
      master_revision: 1,
      origin_kind: "source_original",
      qc_status: "succeeded",
      blocker_count: 0
    },
    enhancementDerivatives: [{ status: "ready", count: 1 }],
    deliveryAudioJobs: [],
    transcripts: [{
      language: "en",
      status: "needs_review",
      revision: 1,
      approved_revision: null,
      speaker_labels_confirmed: 0
    }],
    alignmentRevisions: [],
    alignmentJobs: [],
    chapters: null,
    chapterCount: 0,
    productionReviews: [{
      target_type: "source_audio",
      status: "draft",
      count: 1
    }],
    openReviewBlockers: 1,
    clips: [],
    adPlans: [],
    distributionJobs: [],
    directoryPublications: [],
    sitePublications: [],
    youtubePublications: [],
    youtubeAudioRenditions: [],
    clipPublications: [],
    feedValidation: null,
    foreignKeyViolations: 0,
    queryMeta: Array.from({ length: 21 }, () => ({
      changes: 0,
      rows_written: 0,
      changed_db: false
    }))
  };
}
