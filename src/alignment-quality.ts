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
  sourceAudioSha256: string;
  transcriptRevisionSha256: string;
  resultManifestSha256: string;
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
    | "fixture_provenance_invalid"
    | "gold_word_duplicated"
    | "invalid_confidence"
    | "interpolated_timing"
    | "invalid_interval"
    | "invalid_timing_origin"
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
  duplicateGoldWordCount: number;
  provenanceValid: boolean;
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
    submitted: number;
    acceptanceRatio: number;
    integrityIssueCount: number;
    passed: boolean;
  };
  benchmarkIntegrityGatePassed: boolean;
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
  const provenanceValid = [
    fixture.sourceAudioSha256,
    fixture.transcriptRevisionSha256,
    fixture.resultManifestSha256
  ].every((value) => SHA256.test(value));
  if (!provenanceValid) {
    issues.push({
      code: "fixture_provenance_invalid",
      wordId: "*",
      detail: "Fixture audio, transcript, and runner-result digests must be lowercase SHA-256."
    });
  }
  const knownGoldWordIds = new Set<string>();
  const scorable: GoldWordBoundary[] = [];
  let duplicateGoldWordCount = 0;
  for (const gold of fixture.goldWords) {
    if (knownGoldWordIds.has(gold.wordId)) {
      duplicateGoldWordCount += 1;
      issues.push({
        code: "gold_word_duplicated",
        wordId: gold.wordId,
        detail: "More than one gold record uses this stable word ID."
      });
      continue;
    }
    knownGoldWordIds.add(gold.wordId);
    if (gold.scorable ?? true) scorable.push(gold);
  }
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
      if (!UNALIGNED_REASON.test(String(candidate.unalignedReason ?? ""))) {
        unexplainedOmissionCount += 1;
        issues.push({
          code: "omission_without_reason",
          wordId: gold.wordId,
          detail: "An unaligned word must retain an explicit bounded machine reason."
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

    if (
      candidate.confidence !== null
      && candidate.confidence !== undefined
      && (
        !Number.isFinite(candidate.confidence)
        || candidate.confidence < 0
        || candidate.confidence > 1
      )
    ) {
      invalidIntervalCount += 1;
      issues.push({
        code: "invalid_confidence",
        wordId: gold.wordId,
        detail: "Alignment confidence must be absent or a finite value from zero to one."
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

    const timingOrigin = candidate.timingOrigin;
    if (!timingOrigin || !PASSING_TIMING_ORIGINS.has(timingOrigin)) {
      invalidIntervalCount += 1;
      issues.push({
        code: "invalid_timing_origin",
        wordId: gold.wordId,
        detail: "Aligned timing requires a passing, recognized provenance."
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
    uniqueGoldWordIds: duplicateGoldWordCount === 0,
    fixtureProvenance: provenanceValid,
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
    duplicateGoldWordCount,
    provenanceValid,
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
  const fixtureIdCounts = countBy(benchmark.fixtures.map(({ fixtureId }) => fixtureId));
  const duplicateFixtureIds = new Set(
    [...fixtureIdCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([fixtureId]) => fixtureId)
  );
  const buildLanguageReport = (
    language: AlignmentLanguage
  ): AlignmentLanguageReport => {
    const seenFixtureIds = new Set<string>();
    const reports = fixtureReports.filter((report) => {
      if (report.language !== language || seenFixtureIds.has(report.fixtureId)) {
        return false;
      }
      seenFixtureIds.add(report.fixtureId);
      return true;
    });
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
        || code === "fixture_provenance_invalid"
        || code === "gold_word_duplicated"
        || code === "invalid_confidence"
        || code === "invalid_timing_origin"
        || code === "lexical_mismatch"
      ).length
    )) + reports.filter(({ fixtureId }) =>
      duplicateFixtureIds.has(fixtureId)
    ).length;
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
      uniqueFixtureIds: !reports.some(({ fixtureId }) =>
        duplicateFixtureIds.has(fixtureId)
      ),
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

  const eligiblePreviewKeys = new Set(
    benchmark.fixtures.flatMap((fixture) =>
      fixture.goldWords
        .filter(({ scorable = true }) => scorable)
        .map(({ wordId }) => previewKey(fixture.fixtureId, wordId))
    )
  );
  const seenPreviewKeys = new Set<string>();
  let previewIntegrityIssueCount = 0;
  const validPreviewReviews = benchmark.previewReviews.filter((review) => {
    const key = previewKey(review.fixtureId, review.wordId);
    if (!eligiblePreviewKeys.has(key) || seenPreviewKeys.has(key)) {
      previewIntegrityIssueCount += 1;
      return false;
    }
    seenPreviewKeys.add(key);
    return true;
  });
  const acceptedPreviews = validPreviewReviews.filter(
    ({ acceptedWithoutClipping }) => acceptedWithoutClipping
  ).length;
  const previewAcceptanceRatio = ratio(
    acceptedPreviews,
    validPreviewReviews.length
  );
  const previews = {
    accepted: acceptedPreviews,
    total: validPreviewReviews.length,
    submitted: benchmark.previewReviews.length,
    acceptanceRatio: previewAcceptanceRatio,
    integrityIssueCount: previewIntegrityIssueCount,
    passed:
      validPreviewReviews.length >= thresholds.minimumPreviewSamples
      && previewAcceptanceRatio >= thresholds.minimumPreviewAcceptanceRatio
      && previewIntegrityIssueCount === 0
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
  const expectedFixtureIds = new Set(
    benchmark.fixtures.map(({ fixtureId }) => fixtureId)
  );
  const checkedFixtures = new Set<string>();
  let idempotencyIntegrityIssueCount = 0;
  for (const check of benchmark.idempotencyChecks) {
    if (
      !expectedFixtureIds.has(check.fixtureId)
      || checkedFixtures.has(check.fixtureId)
    ) {
      idempotencyIntegrityIssueCount += 1;
    }
    checkedFixtures.add(check.fixtureId);
  }
  const idempotencyGatePassed =
    duplicateFixtureIds.size === 0
    && idempotencyIntegrityIssueCount === 0
    && expectedFixtureIds.size === checkedFixtures.size
    && [...expectedFixtureIds].every((fixtureId) => checkedFixtures.has(fixtureId))
    && benchmark.idempotencyChecks.every((check) =>
      check.semanticOutputStable
      && check.maximumTimingDeltaMs <= thresholds.maximumIdempotentTimingDeltaMs
      && !check.duplicateBillableJobCreated
    );
  const cleanEnvironmentGatePassed = benchmark.cleanEnvironmentReproduced;
  const benchmarkIntegrityGatePassed =
    boundedText(benchmark.corpusVersion)
    && Object.values(benchmark.adapter).every(boundedText)
    && SHA256_WITH_PREFIX.test(benchmark.adapter.runnerDigest)
    && duplicateFixtureIds.size === 0
    && fixtureReports.every(({ provenanceValid }) => provenanceValid)
    && previewIntegrityIssueCount === 0
    && idempotencyIntegrityIssueCount === 0;
  const passed =
    languages.en.passed
    && languages.es.passed
    && previews.passed
    && resourceGatePassed
    && idempotencyGatePassed
    && cleanEnvironmentGatePassed
    && benchmarkIntegrityGatePassed;

  return {
    schemaVersion: "1",
    corpusVersion: benchmark.corpusVersion,
    adapter: benchmark.adapter,
    passed,
    languages,
    previews,
    benchmarkIntegrityGatePassed,
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

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_WITH_PREFIX = /^sha256:[a-f0-9]{64}$/;
const UNALIGNED_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const PASSING_TIMING_ORIGINS = new Set<AlignmentTimingOrigin>([
  "forced_alignment",
  "model",
  "editor"
]);

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function previewKey(fixtureId: string, wordId: string): string {
  return `${fixtureId}\u0000${wordId}`;
}

function boundedText(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
