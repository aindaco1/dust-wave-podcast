import {
  canonicalAlignmentJson
} from "@dustwave/timed-text/alignment";
import { sha256Hex } from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import {
  ALIGNMENT_RUNNER_REPOSITORY,
  ALIGNMENT_RUNNER_REVISION,
  configuredAlignmentAdapter
} from "./alignment-config";
import {
  evaluateAlignmentBenchmark,
  normalizeLexicalWord,
  type AlignmentBenchmark,
  type AlignmentBenchmarkReport,
  type AlignmentTimingOrigin
} from "./alignment-quality";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { putImmutablePrivateArtifact } from "./private-artifacts";
import {
  readJsonObject,
  RequestValidationError
} from "./validation";

const BENCHMARK_EVIDENCE_SCHEMA = "alignment-benchmark-evidence-v1";
const BENCHMARK_SUBMISSION_SCHEMA = "alignment-benchmark-submission-v1";
const BENCHMARK_INPUT_SCHEMA = "alignment-benchmark-input-v1";
const MAXIMUM_BENCHMARK_INPUT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_FIXTURES = 64;
const MAXIMUM_TOTAL_WORDS = 25_000;
const MAXIMUM_WORDS_PER_FIXTURE = 2_000;
const MAXIMUM_PREVIEW_REVIEWS = 2_000;
const MAXIMUM_RESOURCE_RUNS = 20;
const MAXIMUM_IDEMPOTENCY_CHECKS = 128;
const SHA256 = /^[a-f0-9]{64}$/;
const PLAIN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNALIGNED_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]+$/u;
const TIMING_ORIGINS = new Set<AlignmentTimingOrigin>([
  "forced_alignment",
  "model",
  "editor",
  "interpolated"
]);

type BenchmarkRow = {
  id: string;
  corpus_version: string;
  adapter: string;
  adapter_version: string;
  model: string;
  model_version: string;
  settings_version: string;
  runner_digest: string;
  runner_revision: string | null;
  status: "passed" | "failed" | "processing";
  report_json: string;
  report_sha256: string;
  input_sha256: string | null;
  input_bytes: number | null;
  submission_id: string | null;
  clean_environment_reproduced: number;
  created_at: string;
  completed_at: string | null;
};

type StoredBenchmarkReport = Omit<
  AlignmentBenchmarkReport,
  "fixtureReports"
>;

export async function listAdminAlignmentBenchmarks(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin", "admin", "producer", "analyst"]
  });
  if (!auth.ok) return auth.response;
  const rows = await env.DB.prepare(
    `${benchmarkSelect()}
     WHERE evidence_schema_version = ?
     ORDER BY completed_at DESC, id DESC
     LIMIT 20`
  ).bind(BENCHMARK_EVIDENCE_SCHEMA).all<BenchmarkRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    benchmarks: rows.results.map(presentBenchmark),
    requiredRunner: {
      repository: ALIGNMENT_RUNNER_REPOSITORY,
      revision: ALIGNMENT_RUNNER_REVISION
    },
    limits: {
      maximumInputBytes: MAXIMUM_BENCHMARK_INPUT_BYTES,
      maximumFixtures: MAXIMUM_FIXTURES,
      maximumTotalWords: MAXIMUM_TOTAL_WORDS
    }
  });
}

export async function submitAdminAlignmentBenchmark(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;

  const body = await readJsonObject(
    request,
    MAXIMUM_BENCHMARK_INPUT_BYTES
  );
  exactKeys(
    body,
    ["schemaVersion", "submissionId", "runner", "benchmark"],
    "benchmark submission"
  );
  if (body.schemaVersion !== BENCHMARK_SUBMISSION_SCHEMA) {
    throw new RequestValidationError(
      `schemaVersion must be ${BENCHMARK_SUBMISSION_SCHEMA}`
    );
  }
  const submissionId = plainIdentifier(body.submissionId, "submissionId");
  const runner = record(body.runner, "runner");
  exactKeys(runner, ["repository", "revision"], "runner");
  if (
    runner.repository !== ALIGNMENT_RUNNER_REPOSITORY
    || runner.revision !== ALIGNMENT_RUNNER_REVISION
  ) {
    throw new RequestValidationError(
      "The benchmark runner repository or revision is not pinned"
    );
  }
  const benchmark = parseBenchmark(body.benchmark);
  const input = {
    schemaVersion: BENCHMARK_INPUT_SCHEMA,
    runner: {
      repository: ALIGNMENT_RUNNER_REPOSITORY,
      revision: ALIGNMENT_RUNNER_REVISION
    },
    benchmark
  };
  const inputJson = canonicalAlignmentJson(input);
  const inputBytes = new TextEncoder().encode(inputJson).byteLength;
  if (
    inputBytes < 1
    || inputBytes > MAXIMUM_BENCHMARK_INPUT_BYTES
  ) {
    throw new RequestValidationError(
      "The canonical benchmark input exceeds its byte contract"
    );
  }
  const inputSha256 = await sha256Hex(inputJson);
  const existing = await loadBenchmarkBySubmissionOrInput(
    env.DB,
    submissionId,
    inputSha256
  );
  if (existing) {
    if (
      existing.submission_id === submissionId
      && existing.input_sha256 !== inputSha256
    ) {
      return benchmarkConflict(
        request,
        env,
        "alignment_benchmark_submission_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      benchmark: presentBenchmark(existing),
      idempotent: true
    });
  }

  const report = evaluateAlignmentBenchmark(benchmark);
  const reportJson = canonicalAlignmentJson(storedBenchmarkReport(report));
  const reportSha256 = await sha256Hex(reportJson);
  const benchmarkId = `alignment_benchmark_${inputSha256}`;
  const objectKey =
    `podcasts/alignment-benchmarks/${benchmarkId}/input.json`;
  await putImmutablePrivateArtifact(
    env.MEDIA_BUCKET,
    objectKey,
    inputJson,
    {
      sha256: inputSha256,
      maximumBytes: MAXIMUM_BENCHMARK_INPUT_BYTES,
      contentType: "application/json; charset=utf-8",
      metadata: {
        "benchmark-id": benchmarkId,
        "report-sha256": reportSha256,
        "runner-revision": ALIGNMENT_RUNNER_REVISION
      }
    }
  );

  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const status = report.passed ? "passed" : "failed";
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO alignment_benchmark_runs (
         id, corpus_version, adapter, adapter_version, model, model_version,
         settings_version, runner_digest, status, report_json, report_sha256,
         clean_environment_reproduced, completed_at,
         evidence_schema_version, submission_id, input_object_key,
         input_bytes, input_sha256, runner_revision,
         submitted_by_admin_user_id
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
         ?, ?, ?, ?, ?, ?, ?
       )`
    ).bind(
      benchmarkId,
      benchmark.corpusVersion,
      benchmark.adapter.name,
      benchmark.adapter.version,
      benchmark.adapter.model,
      benchmark.adapter.modelVersion,
      benchmark.adapter.settingsVersion,
      benchmark.adapter.runnerDigest,
      status,
      reportJson,
      reportSha256,
      report.cleanEnvironmentGatePassed ? 1 : 0,
      BENCHMARK_EVIDENCE_SCHEMA,
      submissionId,
      objectKey,
      inputBytes,
      inputSha256,
      ALIGNMENT_RUNNER_REVISION,
      auth.authorization.identity.id
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'alignment_benchmark.recorded',
              'alignment_benchmark_run', id, ?
       FROM alignment_benchmark_runs
       WHERE id = ? AND changes() = 1`
    ).bind(
      auditId,
      auth.authorization.identity.id,
      JSON.stringify({
        corpusVersion: benchmark.corpusVersion,
        adapter: benchmark.adapter.name,
        adapterVersion: benchmark.adapter.version,
        modelVersion: benchmark.adapter.modelVersion,
        settingsVersion: benchmark.adapter.settingsVersion,
        runnerRevision: ALIGNMENT_RUNNER_REVISION,
        runnerDigest: benchmark.adapter.runnerDigest,
        inputSha256,
        reportSha256,
        status,
        fixtureCount: benchmark.fixtures.length,
        englishFixtureCount: report.languages.en.fixtureCount,
        spanishFixtureCount: report.languages.es.fixtureCount,
        previewCount: report.previews.total,
        resourceGatePassed: report.resourceGatePassed,
        idempotencyGatePassed: report.idempotencyGatePassed,
        cleanEnvironmentGatePassed: report.cleanEnvironmentGatePassed
      }),
      benchmarkId
    )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const raced = await loadBenchmarkBySubmissionOrInput(
      env.DB,
      submissionId,
      inputSha256
    );
    if (!raced) {
      return benchmarkConflict(
        request,
        env,
        "alignment_benchmark_record_conflict"
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      benchmark: presentBenchmark(raced),
      idempotent: true
    });
  }
  const created = await loadBenchmark(env.DB, benchmarkId);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      benchmark: created ? presentBenchmark(created) : null,
      idempotent: false
    },
    { status: 201 }
  );
}

function parseBenchmark(value: unknown): AlignmentBenchmark {
  const input = record(value, "benchmark");
  exactKeys(
    input,
    [
      "corpusVersion",
      "adapter",
      "fixtures",
      "previewReviews",
      "resourceRuns",
      "idempotencyChecks",
      "cleanEnvironmentReproduced"
    ],
    "benchmark"
  );
  const corpusVersion = plainIdentifier(
    input.corpusVersion,
    "benchmark.corpusVersion"
  );
  const adapterInput = record(input.adapter, "benchmark.adapter");
  exactKeys(
    adapterInput,
    [
      "name",
      "version",
      "model",
      "modelVersion",
      "settingsVersion",
      "runnerDigest"
    ],
    "benchmark.adapter"
  );
  const adapter = configuredAlignmentAdapter(adapterInput.name);
  if (
    !adapter
    || adapter.version !== adapterInput.version
    || adapter.model !== adapterInput.model
    || adapter.modelVersion !== adapterInput.modelVersion
    || adapter.settingsVersion !== adapterInput.settingsVersion
    || adapter.runnerDigest !== adapterInput.runnerDigest
  ) {
    throw new RequestValidationError(
      "The benchmark adapter identity is not pinned"
    );
  }
  const fixturesInput = array(
    input.fixtures,
    "benchmark.fixtures",
    MAXIMUM_FIXTURES
  );
  if (fixturesInput.length < 1) {
    throw new RequestValidationError(
      "benchmark.fixtures must contain at least one fixture"
    );
  }
  let totalWords = 0;
  const fixtures = fixturesInput.map((fixture, fixtureIndex) => {
    const parsed = parseFixture(fixture, fixtureIndex);
    totalWords += parsed.goldWords.length + parsed.candidateWords.length;
    if (totalWords > MAXIMUM_TOTAL_WORDS) {
      throw new RequestValidationError(
        "The benchmark exceeds its total word cap"
      );
    }
    return parsed;
  });
  const previewReviews = array(
    input.previewReviews,
    "benchmark.previewReviews",
    MAXIMUM_PREVIEW_REVIEWS
  ).map((review, index) => {
    const item = record(review, `benchmark.previewReviews[${index}]`);
    exactKeys(
      item,
      ["fixtureId", "wordId", "acceptedWithoutClipping"],
      `benchmark.previewReviews[${index}]`
    );
    return {
      fixtureId: plainIdentifier(
        item.fixtureId,
        `benchmark.previewReviews[${index}].fixtureId`
      ),
      wordId: plainIdentifier(
        item.wordId,
        `benchmark.previewReviews[${index}].wordId`
      ),
      acceptedWithoutClipping: boolean(
        item.acceptedWithoutClipping,
        `benchmark.previewReviews[${index}].acceptedWithoutClipping`
      )
    };
  });
  const resourceRuns = array(
    input.resourceRuns,
    "benchmark.resourceRuns",
    MAXIMUM_RESOURCE_RUNS
  ).map((run, index) => {
    const item = record(run, `benchmark.resourceRuns[${index}]`);
    exactKeys(
      item,
      [
        "language",
        "inputDurationMinutes",
        "wallClockMinutes",
        "peakMemoryMb",
        "peakDiskMb",
        "runner"
      ],
      `benchmark.resourceRuns[${index}]`
    );
    return {
      language: language(
        item.language,
        `benchmark.resourceRuns[${index}].language`
      ),
      inputDurationMinutes: finiteNumber(
        item.inputDurationMinutes,
        0,
        10_000,
        `benchmark.resourceRuns[${index}].inputDurationMinutes`
      ),
      wallClockMinutes: finiteNumber(
        item.wallClockMinutes,
        0,
        10_000,
        `benchmark.resourceRuns[${index}].wallClockMinutes`
      ),
      peakMemoryMb: finiteNumber(
        item.peakMemoryMb,
        0,
        1_000_000,
        `benchmark.resourceRuns[${index}].peakMemoryMb`
      ),
      peakDiskMb: finiteNumber(
        item.peakDiskMb,
        0,
        1_000_000,
        `benchmark.resourceRuns[${index}].peakDiskMb`
      ),
      runner: safeText(
        item.runner,
        200,
        `benchmark.resourceRuns[${index}].runner`
      )
    };
  });
  const idempotencyChecks = array(
    input.idempotencyChecks,
    "benchmark.idempotencyChecks",
    MAXIMUM_IDEMPOTENCY_CHECKS
  ).map((check, index) => {
    const item = record(
      check,
      `benchmark.idempotencyChecks[${index}]`
    );
    exactKeys(
      item,
      [
        "fixtureId",
        "semanticOutputStable",
        "maximumTimingDeltaMs",
        "duplicateBillableJobCreated"
      ],
      `benchmark.idempotencyChecks[${index}]`
    );
    return {
      fixtureId: plainIdentifier(
        item.fixtureId,
        `benchmark.idempotencyChecks[${index}].fixtureId`
      ),
      semanticOutputStable: boolean(
        item.semanticOutputStable,
        `benchmark.idempotencyChecks[${index}].semanticOutputStable`
      ),
      maximumTimingDeltaMs: finiteNumber(
        item.maximumTimingDeltaMs,
        0,
        60_000,
        `benchmark.idempotencyChecks[${index}].maximumTimingDeltaMs`
      ),
      duplicateBillableJobCreated: boolean(
        item.duplicateBillableJobCreated,
        `benchmark.idempotencyChecks[${index}].duplicateBillableJobCreated`
      )
    };
  });
  return {
    corpusVersion,
    adapter,
    fixtures,
    previewReviews,
    resourceRuns,
    idempotencyChecks,
    cleanEnvironmentReproduced: boolean(
      input.cleanEnvironmentReproduced,
      "benchmark.cleanEnvironmentReproduced"
    )
  };
}

function parseFixture(
  value: unknown,
  fixtureIndex: number
): AlignmentBenchmark["fixtures"][number] {
  const field = `benchmark.fixtures[${fixtureIndex}]`;
  const input = record(value, field);
  exactKeys(
    input,
    [
      "fixtureId",
      "language",
      "audioDurationMs",
      "sourceAudioSha256",
      "transcriptRevisionSha256",
      "resultManifestSha256",
      "goldWords",
      "candidateWords"
    ],
    field
  );
  const audioDurationMs = integer(
    input.audioDurationMs,
    120_000,
    300_000,
    `${field}.audioDurationMs`
  );
  const goldWords = array(
    input.goldWords,
    `${field}.goldWords`,
    MAXIMUM_WORDS_PER_FIXTURE
  ).map((word, index) => {
    const wordField = `${field}.goldWords[${index}]`;
    const item = record(word, wordField);
    exactKeys(
      item,
      ["wordId", "cueId", "text", "startsAtMs", "endsAtMs"],
      wordField,
      ["scorable"]
    );
    const startsAtMs = integer(
      item.startsAtMs,
      0,
      audioDurationMs - 1,
      `${wordField}.startsAtMs`
    );
    const endsAtMs = integer(
      item.endsAtMs,
      startsAtMs + 1,
      audioDurationMs,
      `${wordField}.endsAtMs`
    );
    const text = lexicalText(item.text, `${wordField}.text`);
    return {
      wordId: plainIdentifier(item.wordId, `${wordField}.wordId`),
      cueId: plainIdentifier(item.cueId, `${wordField}.cueId`),
      text,
      startsAtMs,
      endsAtMs,
      ...(item.scorable === undefined
        ? {}
        : { scorable: boolean(item.scorable, `${wordField}.scorable`) })
    };
  });
  if (goldWords.length < 1) {
    throw new RequestValidationError(
      `${field}.goldWords must contain at least one word`
    );
  }
  const candidateWords = array(
    input.candidateWords,
    `${field}.candidateWords`,
    MAXIMUM_WORDS_PER_FIXTURE
  ).map((word, index) => {
    const wordField = `${field}.candidateWords[${index}]`;
    const item = record(word, wordField);
    exactKeys(
      item,
      [
        "wordId",
        "cueId",
        "text",
        "startsAtMs",
        "endsAtMs"
      ],
      wordField,
      ["confidence", "timingOrigin", "unalignedReason"]
    );
    return {
      wordId: plainIdentifier(item.wordId, `${wordField}.wordId`),
      cueId: plainIdentifier(item.cueId, `${wordField}.cueId`),
      text: lexicalText(item.text, `${wordField}.text`),
      startsAtMs: nullableInteger(
        item.startsAtMs,
        -audioDurationMs,
        audioDurationMs * 2,
        `${wordField}.startsAtMs`
      ),
      endsAtMs: nullableInteger(
        item.endsAtMs,
        -audioDurationMs,
        audioDurationMs * 2,
        `${wordField}.endsAtMs`
      ),
      confidence: item.confidence === undefined
        ? null
        : nullableNumber(
            item.confidence,
            -1,
            2,
            `${wordField}.confidence`
          ),
      timingOrigin: timingOrigin(
        item.timingOrigin,
        `${wordField}.timingOrigin`
      ),
      unalignedReason: unalignedReason(
        item.unalignedReason,
        `${wordField}.unalignedReason`
      )
    };
  });
  return {
    fixtureId: plainIdentifier(input.fixtureId, `${field}.fixtureId`),
    language: language(input.language, `${field}.language`),
    audioDurationMs,
    sourceAudioSha256: sha256(
      input.sourceAudioSha256,
      `${field}.sourceAudioSha256`
    ),
    transcriptRevisionSha256: sha256(
      input.transcriptRevisionSha256,
      `${field}.transcriptRevisionSha256`
    ),
    resultManifestSha256: sha256(
      input.resultManifestSha256,
      `${field}.resultManifestSha256`
    ),
    goldWords,
    candidateWords
  };
}

function benchmarkSelect(): string {
  return `SELECT
      id, corpus_version, adapter, adapter_version, model, model_version,
      settings_version, runner_digest, runner_revision, status, report_json,
      report_sha256, input_sha256, input_bytes, submission_id,
      clean_environment_reproduced, created_at, completed_at
    FROM alignment_benchmark_runs`;
}

async function loadBenchmark(
  db: D1Database,
  benchmarkId: string
): Promise<BenchmarkRow | null> {
  return db.prepare(
    `${benchmarkSelect()} WHERE id = ?`
  ).bind(benchmarkId).first<BenchmarkRow>();
}

async function loadBenchmarkBySubmissionOrInput(
  db: D1Database,
  submissionId: string,
  inputSha256: string
): Promise<BenchmarkRow | null> {
  return db.prepare(
    `${benchmarkSelect()}
     WHERE submission_id = ? OR input_sha256 = ?
     ORDER BY CASE WHEN submission_id = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(
    submissionId,
    inputSha256,
    submissionId
  ).first<BenchmarkRow>();
}

function presentBenchmark(row: BenchmarkRow): Record<string, unknown> {
  const report = parseReport(row.report_json);
  return {
    id: row.id,
    corpusVersion: row.corpus_version,
    adapter: {
      name: row.adapter,
      version: row.adapter_version,
      model: row.model,
      modelVersion: row.model_version,
      settingsVersion: row.settings_version
    },
    runner: {
      repository: ALIGNMENT_RUNNER_REPOSITORY,
      revision: row.runner_revision,
      digest: row.runner_digest
    },
    status: row.status,
    passed: row.status === "passed" && report?.passed === true,
    reportSha256: row.report_sha256,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    submissionId: row.submission_id,
    cleanEnvironmentReproduced:
      row.clean_environment_reproduced === 1,
    languages: report?.languages ?? null,
    previews: report?.previews ?? null,
    benchmarkIntegrityGatePassed:
      report?.benchmarkIntegrityGatePassed ?? false,
    resourceGatePassed: report?.resourceGatePassed ?? false,
    idempotencyGatePassed: report?.idempotencyGatePassed ?? false,
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

function parseReport(value: string): StoredBenchmarkReport | null {
  try {
    const report = JSON.parse(value) as StoredBenchmarkReport;
    return report?.schemaVersion === "1" ? report : null;
  } catch {
    return null;
  }
}

function storedBenchmarkReport(
  report: AlignmentBenchmarkReport
): StoredBenchmarkReport {
  const { fixtureReports: _privateFixtureReports, ...summary } = report;
  return summary;
}

function benchmarkConflict(
  request: Request,
  env: PodcastEnv,
  code: string
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: code },
    { status: 409 }
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new RequestValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  field: string,
  optional: string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new RequestValidationError(
      `${field} has missing or unknown fields`
    );
  }
}

function array(
  value: unknown,
  field: string,
  maximumLength: number
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new RequestValidationError(
      `${field} must be an array of at most ${maximumLength} items`
    );
  }
  return value;
}

function plainIdentifier(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!PLAIN_IDENTIFIER.test(parsed)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return parsed;
}

function safeText(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !SAFE_TEXT.test(value)
  ) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return value;
}

function lexicalText(value: unknown, field: string): string {
  const parsed = safeText(value, 500, field);
  if (!normalizeLexicalWord(parsed)) {
    throw new RequestValidationError(`${field} is not a lexical word`);
  }
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!SHA256.test(parsed)) {
    throw new RequestValidationError(`${field} must be lowercase SHA-256`);
  }
  return parsed;
}

function language(value: unknown, field: string): "en" | "es" {
  if (value !== "en" && value !== "es") {
    throw new RequestValidationError(`${field} must be en or es`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${field} must be boolean`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    throw new RequestValidationError(
      `${field} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return Number(value);
}

function nullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number | null {
  return value === null
    ? null
    : integer(value, minimum, maximum, field);
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new RequestValidationError(
      `${field} must be a finite number from ${minimum} to ${maximum}`
    );
  }
  return value;
}

function nullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number | null {
  return value === null
    ? null
    : finiteNumber(value, minimum, maximum, field);
}

function timingOrigin(
  value: unknown,
  field: string
): AlignmentTimingOrigin | null {
  if (value === undefined || value === null) return null;
  if (!TIMING_ORIGINS.has(value as AlignmentTimingOrigin)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return value as AlignmentTimingOrigin;
}

function unalignedReason(
  value: unknown,
  field: string
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UNALIGNED_REASON.test(value)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return value;
}
