import { describe, expect, it } from "vitest";

import {
  evaluateAlignmentBenchmark,
  evaluateAlignmentFixture,
  normalizeLexicalWord,
  type AlignmentBenchmark,
  type AlignmentFixture,
  type AlignmentLanguage
} from "../src/alignment-quality";

describe("alignment quality gate", () => {
  it("normalizes English and Spanish lexical punctuation without losing numbers", () => {
    expect(normalizeLexicalWord("¡Ópera!")).toBe("opera");
    expect(normalizeLexicalWord("Dust-Wave’s")).toBe("dustwaves");
    expect(normalizeLexicalWord("2026.")).toBe("2026");
  });

  it("passes bounded, monotonic, non-interpolated word timings", () => {
    const report = evaluateAlignmentFixture(createFixture("en", 0, 34));

    expect(report.passed).toBe(true);
    expect(report.alignedWordRatio).toBe(1);
    expect(report.medianBoundaryErrorMs).toBeLessThanOrEqual(60);
    expect(report.p95BoundaryErrorMs).toBeLessThanOrEqual(60);
    expect(report.issues).toEqual([]);
  });

  it("rejects interpolated, invalid, cross-cue, and unexplained timings", () => {
    const fixture = createFixture("es", 0, 6);
    fixture.candidateWords[1].timingOrigin = "interpolated";
    fixture.candidateWords[2].startsAtMs = -10;
    fixture.candidateWords[3].cueId = "other-cue";
    fixture.candidateWords[4].startsAtMs = null;
    fixture.candidateWords[4].endsAtMs = null;
    fixture.candidateWords[4].unalignedReason = "";
    fixture.candidateWords.splice(5, 1);
    fixture.candidateWords.push({
      wordId: "unknown-word",
      cueId: "other-cue",
      text: "extra",
      startsAtMs: 10,
      endsAtMs: 20,
      timingOrigin: "forced_alignment"
    });

    const report = evaluateAlignmentFixture(fixture);

    expect(report.passed).toBe(false);
    expect(report.invalidIntervalCount).toBe(3);
    expect(report.unexplainedOmissionCount).toBe(2);
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "interpolated_timing",
      "invalid_interval",
      "cue_mismatch",
      "omission_without_reason",
      "candidate_word_missing",
      "candidate_word_unknown"
    ]));
  });

  it("requires both languages, corpus depth, preview review, resources, and idempotency", () => {
    const passing = createBenchmark();
    const report = evaluateAlignmentBenchmark(passing);

    expect(report.passed).toBe(true);
    expect(report.languages.en.fixtureCount).toBe(12);
    expect(report.languages.es.fixtureCount).toBe(12);
    expect(report.languages.en.goldWordCount).toBeGreaterThanOrEqual(400);
    expect(report.languages.es.goldWordCount).toBeGreaterThanOrEqual(400);
    expect(report.previews).toMatchObject({
      total: 100,
      accepted: 96,
      passed: true
    });

    passing.resourceRuns = passing.resourceRuns.filter(({ language }) => language === "en");
    passing.idempotencyChecks[0].duplicateBillableJobCreated = true;
    const failed = evaluateAlignmentBenchmark(passing);

    expect(failed.passed).toBe(false);
    expect(failed.resourceGatePassed).toBe(false);
    expect(failed.idempotencyGatePassed).toBe(false);
  });
});

function createBenchmark(): AlignmentBenchmark {
  const fixtures = (["en", "es"] as const).flatMap((language) =>
    Array.from({ length: 12 }, (_, index) => createFixture(language, index, 34))
  );
  return {
    corpusVersion: "fixture-corpus-v1",
    adapter: {
      name: "fixture-aligner",
      version: "1.0.0",
      model: "fixture-model",
      modelVersion: "1",
      settingsVersion: "1",
      runnerDigest: "sha256:fixture"
    },
    fixtures,
    previewReviews: Array.from({ length: 100 }, (_, index) => ({
      fixtureId: fixtures[index % fixtures.length].fixtureId,
      wordId: `word-${index}`,
      acceptedWithoutClipping: index < 96
    })),
    resourceRuns: (["en", "es"] as const).map((language) => ({
      language,
      inputDurationMinutes: 60,
      wallClockMinutes: 18,
      peakMemoryMb: 4096,
      peakDiskMb: 2048,
      runner: "ubuntu-24.04"
    })),
    idempotencyChecks: fixtures.map(({ fixtureId }) => ({
      fixtureId,
      semanticOutputStable: true,
      maximumTimingDeltaMs: 0,
      duplicateBillableJobCreated: false
    })),
    cleanEnvironmentReproduced: true
  };
}

function createFixture(
  language: AlignmentLanguage,
  fixtureIndex: number,
  wordCount: number
): AlignmentFixture {
  const fixtureId = `${language}-fixture-${fixtureIndex}`;
  const cueId = `${fixtureId}-cue`;
  const goldWords = Array.from({ length: wordCount }, (_, index) => ({
    wordId: `${fixtureId}-word-${index}`,
    cueId,
    text: index % 2 === 0 ? "Ópera," : "wave",
    startsAtMs: 500 + index * 450,
    endsAtMs: 800 + index * 450
  }));
  return {
    fixtureId,
    language,
    audioDurationMs: wordCount * 450 + 1_000,
    goldWords,
    candidateWords: goldWords.map((word) => ({
      wordId: word.wordId,
      cueId: word.cueId,
      text: word.text,
      startsAtMs: word.startsAtMs + 40,
      endsAtMs: word.endsAtMs + 60,
      confidence: 0.98,
      timingOrigin: "forced_alignment"
    }))
  };
}
