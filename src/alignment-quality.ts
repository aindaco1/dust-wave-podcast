export type AlignmentLanguage = "en" | "es";
export type AlignmentTimingOrigin =
  | "forced_alignment"
  | "model"
  | "editor"
  | "interpolated";

export interface GoldWordBoundary {
  wordId: string;
  cueId: string;
  text: string;
  startsAtMs: number;
  endsAtMs: number;
  scorable?: boolean;
}

export interface CandidateWordBoundary {
  wordId: string;
  cueId: string;
  text: string;
  startsAtMs: number | null;
  endsAtMs: number | null;
  confidence?: number | null;
  timingOrigin?: AlignmentTimingOrigin | null;
  unalignedReason?: string | null;
}

export interface AlignmentFixture {
  fixtureId: string;
  language: AlignmentLanguage;
  audioDurationMs: number;
  goldWords: GoldWordBoundary[];
  candidateWords: CandidateWordBoundary[];
}

export interface AlignmentGateThresholds {
  minimumAlignedWordRatio: number;
  maximumMedianBoundaryErrorMs: number;
  maximumP95BoundaryErrorMs: number;
  minimumFixturesPerLanguage: number;
  minimumGoldWordsPerLanguage: number;
  minimumPreviewSamples: number;
  minimumPreviewAcceptanceRatio: number;
  maximumIdempotentTimingDeltaMs: number;
}

export const ALIGNMENT_GATE_THRESHOLDS: Readonly<AlignmentGateThresholds> = {
  minimumAlignedWordRatio: 0.98,
  maximumMedianBoundaryErrorMs: 120,
  maximumP95BoundaryErrorMs: 300,
  minimumFixturesPerLanguage: 12,
  minimumGoldWordsPerLanguage: 400,
  minimumPreviewSamples: 100,
  minimumPreviewAcceptanceRatio: 0.95,
  maximumIdempotentTimingDeltaMs: 1
};

export interface AlignmentIssue {
  code:
    | "candidate_word_duplicated"
    | "candidate_word_missing"
    | "candidate_word_unknown"
    | "cue_mismatch"
    | "interpolated_timing"
    | "invalid_interval"
    | "lexical_mismatch"
    | "non_monotonic_interval"
    | "omission_without_reason";
  wordId: string;
  detail: string;
}

export interface AlignmentFixtureReport {
  fixtureId: string;
  language: AlignmentLanguage;
  passed: boolean;
  goldWordCount: number;
  alignedWordCount: number;
  alignedWordRatio: number;
  medianBoundaryErrorMs: number | null;
  p95BoundaryErrorMs: number | null;
  invalidIntervalCount: number;
  unexplainedOmissionCount: number;
  duplicateWordCount: number;
  boundaryErrorSamplesMs: number[];
  issues: AlignmentIssue[];
  criteria: Record<string, boolean>;
}

export interface PreviewReview {
  fixtureId: string;
  wordId: string;
  acceptedWithoutClipping: boolean;
}

export interface AlignmentResourceRun {
  language: AlignmentLanguage;
  inputDurationMinutes: number;
  wallClockMinutes: number;
  peakMemoryMb: number;
  peakDiskMb: number;
  runner: string;
}

export interface AlignmentIdempotencyCheck {
  fixtureId: string;
  semanticOutputStable: boolean;
  maximumTimingDeltaMs: number;
  duplicateBillableJobCreated: boolean;
}

export interface AlignmentBenchmark {
  corpusVersion: string;
  adapter: {
    name: string;
    version: string;
    model: string;
    modelVersion: string;
    settingsVersion: string;
    runnerDigest: string;
  };
  fixtures: AlignmentFixture[];
  previewReviews: PreviewReview[];
  resourceRuns: AlignmentResourceRun[];
  idempotencyChecks: AlignmentIdempotencyCheck[];
  cleanEnvironmentReproduced: boolean;
}

export interface AlignmentLanguageReport {
  language: AlignmentLanguage;
  passed: boolean;
  fixtureCount: number;
  goldWordCount: number;
  alignedWordCount: number;
  alignedWordRatio: number;
  medianBoundaryErrorMs: number | null;
  p95BoundaryErrorMs: number | null;
  invalidIntervalCount: number;
  unexplainedOmissionCount: number;
  integrityIssueCount: number;
  criteria: Record<string, boolean>;
}

export interface AlignmentBenchmarkReport {
  schemaVersion: "1";
  corpusVersion: string;
  adapter: AlignmentBenchmark["adapter"];
  passed: boolean;
  languages: Record<AlignmentLanguage, AlignmentLanguageReport>;
  previews: {
    accepted: number;
    total: number;
    acceptanceRatio: number;
    passed: boolean;
  };
  resourceGatePassed: boolean;
  idempotencyGatePassed: boolean;
  cleanEnvironmentGatePassed: boolean;
  fixtureReports: AlignmentFixtureReport[];
}

export function normalizeLexicalWord(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[\p{Punctuation}\p{Symbol}\s]+/gu, "");
}

export function evaluateAlignmentFixture(
  fixture: AlignmentFixture,
  thresholds: AlignmentGateThresholds = ALIGNMENT_GATE_THRESHOLDS
): AlignmentFixtureReport {
  const issues: AlignmentIssue[] = [];
  const scorable = fixture.goldWords.filter(({ scorable: value = true }) => value);
  const knownGoldWordIds = new Set(fixture.goldWords.map(({ wordId }) => wordId));
  const candidates = new Map<string, CandidateWordBoundary>();
  let duplicateWordCount = 0;

  for (const candidate of fixture.candidateWords) {
    if (candidates.has(candidate.wordId)) {
      duplicateWordCount += 1;
      issues.push({
        code: "candidate_word_duplicated",
        wordId: candidate.wordId,
        detail: "More than one candidate record uses this stable word ID."
      });
      continue;
    }
    candidates.set(candidate.wordId, candidate);
    if (!knownGoldWordIds.has(candidate.wordId)) {
      issues.push({
        code: "candidate_word_unknown",
        wordId: candidate.wordId,
        detail: "The candidate record is not part of the stable gold transcript projection."
      });
    }
  }

  const boundaryErrors: number[] = [];
  let alignedWordCount = 0;
  let invalidIntervalCount = 0;
  let unexplainedOmissionCount = 0;
  let previousStartsAtMs = -1;
  let previousEndsAtMs = -1;

  for (const gold of scorable) {
    const candidate = candidates.get(gold.wordId);
    if (!candidate) {
      unexplainedOmissionCount += 1;
      issues.push({
        code: "candidate_word_missing",
        wordId: gold.wordId,
        detail: "The adapter omitted the stable word record and therefore supplied no reason."
      });
      continue;
    }

    if (normalizeLexicalWord(candidate.text) !== normalizeLexicalWord(gold.text)) {
      issues.push({
        code: "lexical_mismatch",
        wordId: gold.wordId,
        detail: `Candidate text "${candidate.text}" does not match gold text "${gold.text}".`
      });
      continue;
    }

    const hasStart = Number.isFinite(candidate.startsAtMs);
    const hasEnd = Number.isFinite(candidate.endsAtMs);
    if (!hasStart && !hasEnd) {
      if (!String(candidate.unalignedReason ?? "").trim()) {
        unexplainedOmissionCount += 1;
        issues.push({
          code: "omission_without_reason",
          wordId: gold.wordId,
          detail: "An unaligned word must retain an explicit bounded reason."
        });
      }
      continue;
    }

    const startsAtMs = Number(candidate.startsAtMs);
    const endsAtMs = Number(candidate.endsAtMs);
    if (
      !hasStart
      || !hasEnd
      || startsAtMs < 0
      || endsAtMs <= startsAtMs
      || endsAtMs > fixture.audioDurationMs
    ) {
      invalidIntervalCount += 1;
      issues.push({
        code: "invalid_interval",
        wordId: gold.wordId,
        detail: "Word timing must be finite, positive-duration, and inside the source audio."
      });
      continue;
    }

    if (candidate.timingOrigin === "interpolated") {
      invalidIntervalCount += 1;
      issues.push({
        code: "interpolated_timing",
        wordId: gold.wordId,
        detail: "Interpolated timing is retained for diagnosis but cannot pass the word-edit gate."
      });
      continue;
    }

    if (candidate.cueId !== gold.cueId) {
      invalidIntervalCount += 1;
      issues.push({
        code: "cue_mismatch",
        wordId: gold.wordId,
        detail: `Candidate cue "${candidate.cueId}" crosses gold cue "${gold.cueId}".`
      });
      continue;
    }

    if (startsAtMs < previousStartsAtMs || endsAtMs < previousEndsAtMs) {
      invalidIntervalCount += 1;
      issues.push({
        code: "non_monotonic_interval",
        wordId: gold.wordId,
        detail: "Word intervals move backward relative to the preceding scorable word."
      });
      continue;
    }

    previousStartsAtMs = startsAtMs;
    previousEndsAtMs = endsAtMs;
    alignedWordCount += 1;
    boundaryErrors.push(
      Math.abs(startsAtMs - gold.startsAtMs),
      Math.abs(endsAtMs - gold.endsAtMs)
    );
  }

  const alignedWordRatio = ratio(alignedWordCount, scorable.length);
  const medianBoundaryErrorMs = percentile(boundaryErrors, 0.5);
  const p95BoundaryErrorMs = percentile(boundaryErrors, 0.95);
  const criteria = {
    alignedWordRatio: alignedWordRatio >= thresholds.minimumAlignedWordRatio,
    medianBoundaryError:
      medianBoundaryErrorMs !== null
      && medianBoundaryErrorMs <= thresholds.maximumMedianBoundaryErrorMs,
    p95BoundaryError:
      p95BoundaryErrorMs !== null
      && p95BoundaryErrorMs <= thresholds.maximumP95BoundaryErrorMs,
    validIntervals: invalidIntervalCount === 0,
    explainedOmissions: unexplainedOmissionCount === 0,
    uniqueStableWordIds: duplicateWordCount === 0,
    stableTranscriptProjection: !issues.some(({ code }) =>
      code === "candidate_word_unknown" || code === "lexical_mismatch"
    )
  };

  return {
    fixtureId: fixture.fixtureId,
    language: fixture.language,
    passed: Object.values(criteria).every(Boolean),
    goldWordCount: scorable.length,
    alignedWordCount,
    alignedWordRatio,
    medianBoundaryErrorMs,
    p95BoundaryErrorMs,
    invalidIntervalCount,
    unexplainedOmissionCount,
    duplicateWordCount,
    boundaryErrorSamplesMs: boundaryErrors,
    issues,
    criteria
  };
}

export function evaluateAlignmentBenchmark(
  benchmark: AlignmentBenchmark,
  thresholds: AlignmentGateThresholds = ALIGNMENT_GATE_THRESHOLDS
): AlignmentBenchmarkReport {
  const fixtureReports = benchmark.fixtures.map((fixture) =>
    evaluateAlignmentFixture(fixture, thresholds)
  );
  const buildLanguageReport = (
    language: AlignmentLanguage
  ): AlignmentLanguageReport => {
    const reports = fixtureReports.filter((report) => report.language === language);
    const goldWordCount = sum(reports.map(({ goldWordCount: value }) => value));
    const alignedWordCount = sum(reports.map(({ alignedWordCount: value }) => value));
    const boundaryErrors = reports.flatMap(({ boundaryErrorSamplesMs }) =>
      boundaryErrorSamplesMs
    );
    const invalidIntervalCount = sum(
      reports.map(({ invalidIntervalCount: value }) => value)
    );
    const unexplainedOmissionCount = sum(
      reports.map(({ unexplainedOmissionCount: value }) => value)
    );
    const integrityIssueCount = sum(reports.map((report) =>
      report.issues.filter(({ code }) =>
        code === "candidate_word_duplicated"
        || code === "candidate_word_unknown"
        || code === "lexical_mismatch"
      ).length
    ));
    const alignedWordRatio = ratio(alignedWordCount, goldWordCount);
    const medianBoundaryErrorMs = percentile(boundaryErrors, 0.5);
    const p95BoundaryErrorMs = percentile(boundaryErrors, 0.95);
    const criteria = {
      fixtureCount: reports.length >= thresholds.minimumFixturesPerLanguage,
      goldWordCount: goldWordCount >= thresholds.minimumGoldWordsPerLanguage,
      alignedWordRatio: alignedWordRatio >= thresholds.minimumAlignedWordRatio,
      medianBoundaryError:
        medianBoundaryErrorMs !== null
        && medianBoundaryErrorMs <= thresholds.maximumMedianBoundaryErrorMs,
      p95BoundaryError:
        p95BoundaryErrorMs !== null
        && p95BoundaryErrorMs <= thresholds.maximumP95BoundaryErrorMs,
      validIntervals: invalidIntervalCount === 0,
      explainedOmissions: unexplainedOmissionCount === 0,
      stableTranscriptProjection: integrityIssueCount === 0
    };
    return {
      language,
      passed: Object.values(criteria).every(Boolean),
      fixtureCount: reports.length,
      goldWordCount,
      alignedWordCount,
      alignedWordRatio,
      medianBoundaryErrorMs,
      p95BoundaryErrorMs,
      invalidIntervalCount,
      unexplainedOmissionCount,
      integrityIssueCount,
      criteria
    };
  };
  const languages: Record<AlignmentLanguage, AlignmentLanguageReport> = {
    en: buildLanguageReport("en"),
    es: buildLanguageReport("es")
  };

  const acceptedPreviews = benchmark.previewReviews.filter(
    ({ acceptedWithoutClipping }) => acceptedWithoutClipping
  ).length;
  const previewAcceptanceRatio = ratio(
    acceptedPreviews,
    benchmark.previewReviews.length
  );
  const previews = {
    accepted: acceptedPreviews,
    total: benchmark.previewReviews.length,
    acceptanceRatio: previewAcceptanceRatio,
    passed:
      benchmark.previewReviews.length >= thresholds.minimumPreviewSamples
      && previewAcceptanceRatio >= thresholds.minimumPreviewAcceptanceRatio
  };
  const resourceGatePassed = (["en", "es"] as const).every((language) =>
    benchmark.resourceRuns.some((run) =>
      run.language === language
      && run.inputDurationMinutes >= 60
      && run.wallClockMinutes > 0
      && run.peakMemoryMb > 0
      && run.peakDiskMb > 0
      && Boolean(run.runner.trim())
    )
  );
  const checkedFixtures = new Set(
    benchmark.idempotencyChecks.map(({ fixtureId }) => fixtureId)
  );
  const idempotencyGatePassed =
    benchmark.fixtures.every(({ fixtureId }) => checkedFixtures.has(fixtureId))
    && benchmark.idempotencyChecks.every((check) =>
      check.semanticOutputStable
      && check.maximumTimingDeltaMs <= thresholds.maximumIdempotentTimingDeltaMs
      && !check.duplicateBillableJobCreated
    );
  const cleanEnvironmentGatePassed = benchmark.cleanEnvironmentReproduced;
  const passed =
    languages.en.passed
    && languages.es.passed
    && previews.passed
    && resourceGatePassed
    && idempotencyGatePassed
    && cleanEnvironmentGatePassed;

  return {
    schemaVersion: "1",
    corpusVersion: benchmark.corpusVersion,
    adapter: benchmark.adapter,
    passed,
    languages,
    previews,
    resourceGatePassed,
    idempotencyGatePassed,
    cleanEnvironmentGatePassed,
    fixtureReports
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
