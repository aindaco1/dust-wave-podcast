import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import {
  ALIGNMENT_RUNNER_DIGEST,
  ALIGNMENT_RUNNER_REPOSITORY,
  ALIGNMENT_RUNNER_REVISION
} from "../src/alignment-config";
import { handleRequest } from "../src/app";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const siteOrigin = "https://dustwave.xyz";
const apiOrigin = "https://feeds.dustwave.xyz";
const sessionSecret = "benchmark-session-secret";
const sessionToken = "benchmark-session-token";
const csrfToken = "benchmark-csrf-token";
const adminId = "admin_benchmark_fixture";
const lexicalSentinel = "confidencial";

describe("alignment benchmark evidence import", () => {
  it("records one private, content-addressed passing benchmark and replays safely", async () => {
    const harness = await createHarness();
    try {
      const submission = passingSubmission();
      const response = await handleRequest(
        benchmarkRequest(submission),
        harness.env
      );
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload).toMatchObject({
        idempotent: false,
        benchmark: {
          status: "passed",
          passed: true,
          corpusVersion: "rights-cleared-bilingual-v1",
          cleanEnvironmentReproduced: true,
          benchmarkIntegrityGatePassed: true,
          resourceGatePassed: true,
          idempotencyGatePassed: true,
          languages: {
            en: {
              passed: true,
              fixtureCount: 12,
              goldWordCount: 408
            },
            es: {
              passed: true,
              fixtureCount: 12,
              goldWordCount: 408
            }
          },
          previews: {
            passed: true,
            total: 100,
            accepted: 100
          }
        }
      });
      expect(payload.benchmark).not.toHaveProperty("inputObjectKey");
      expect(payload.benchmark).not.toHaveProperty("report");
      expect(harness.objects.size).toBe(1);

      const row = harness.database.prepare(`
        SELECT
          id, evidence_schema_version, submission_id, input_object_key,
          input_bytes, input_sha256, runner_revision, status,
          submitted_by_admin_user_id, report_json
        FROM alignment_benchmark_runs
      `).get();
      expect(row).toMatchObject({
        evidence_schema_version: "alignment-benchmark-evidence-v1",
        submission_id: "benchmark_submission_fixture",
        runner_revision: ALIGNMENT_RUNNER_REVISION,
        status: "passed",
        submitted_by_admin_user_id: adminId
      });
      expect(row.id).toBe(
        `alignment_benchmark_${row.input_sha256}`
      );
      expect(row.input_object_key).toBe(
        `podcasts/alignment-benchmarks/${row.id}/input.json`
      );
      expect(row.input_bytes).toBeGreaterThan(1);
      expect(row.input_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row.report_json).not.toContain(lexicalSentinel);
      expect(row.report_json).not.toContain("fixtureReports");

      const stored = harness.objects.get(row.input_object_key);
      expect(stored.body).toContain(lexicalSentinel);
      expect(stored.customMetadata).toMatchObject({
        sha256: row.input_sha256,
        "benchmark-id": row.id,
        "runner-revision": ALIGNMENT_RUNNER_REVISION
      });
      const audit = harness.database.prepare(`
        SELECT metadata_json
        FROM admin_audit_events
        WHERE action = 'alignment_benchmark.recorded'
      `).get();
      expect(audit.metadata_json).not.toContain(lexicalSentinel);
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        corpusVersion: "rights-cleared-bilingual-v1",
        status: "passed",
        fixtureCount: 24,
        englishFixtureCount: 12,
        spanishFixtureCount: 12,
        previewCount: 100,
        runnerRevision: ALIGNMENT_RUNNER_REVISION
      });

      const replay = await handleRequest(
        benchmarkRequest(submission),
        harness.env
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        idempotent: true,
        benchmark: { id: row.id, status: "passed" }
      });
      expect(harness.objects.size).toBe(1);
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count FROM alignment_benchmark_runs
      `).get()).toEqual({ count: 1 });
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count
        FROM alignment_passing_benchmark_evidence
      `).get()).toEqual({ count: 1 });
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count
        FROM admin_audit_events
        WHERE action = 'alignment_benchmark.recorded'
      `).get()).toEqual({ count: 1 });

      const listing = await handleRequest(
        benchmarkRequest(undefined, { method: "GET" }),
        harness.env
      );
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        benchmarks: [{ id: row.id, passed: true }],
        requiredRunner: {
          repository: ALIGNMENT_RUNNER_REPOSITORY,
          revision: ALIGNMENT_RUNNER_REVISION
        },
        limits: {
          maximumInputBytes: 8 * 1024 * 1024,
          maximumFixtures: 64,
          maximumTotalWords: 25_000
        }
      });
      expect(
        harness.database.prepare("PRAGMA foreign_key_check").all()
      ).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("rejects a reused submission ID with changed evidence", async () => {
    const harness = await createHarness();
    try {
      const initial = passingSubmission();
      expect(
        (await handleRequest(benchmarkRequest(initial), harness.env)).status
      ).toBe(201);
      const changed = passingSubmission();
      changed.benchmark.fixtures[0].resultManifestSha256 = "9".repeat(64);

      const response = await handleRequest(
        benchmarkRequest(changed),
        harness.env
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "alignment_benchmark_submission_conflict"
      });
      expect(harness.objects.size).toBe(1);
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count FROM alignment_benchmark_runs
      `).get()).toEqual({ count: 1 });
    } finally {
      harness.database.close();
    }
  });

  it("retains failed evidence privately without making it approval-eligible", async () => {
    const harness = await createHarness();
    try {
      const submission = passingSubmission();
      submission.submissionId = "benchmark_submission_failed_fixture";
      submission.benchmark.fixtures[0].candidateWords[0].text =
        "differentword";

      const response = await handleRequest(
        benchmarkRequest(submission),
        harness.env
      );
      const payload = await response.json();
      expect(response.status).toBe(201);
      expect(payload).toMatchObject({
        idempotent: false,
        benchmark: {
          status: "failed",
          passed: false,
          benchmarkIntegrityGatePassed: true,
          languages: { en: { passed: false } }
        }
      });
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count
        FROM alignment_passing_benchmark_evidence
      `).get()).toEqual({ count: 0 });
      const row = harness.database.prepare(`
        SELECT report_json, input_object_key
        FROM alignment_benchmark_runs
      `).get();
      expect(row.report_json).not.toContain("differentword");
      expect(row.report_json).not.toContain(lexicalSentinel);
      expect(row.report_json).not.toContain("fixtureReports");
      expect(harness.objects.get(row.input_object_key).body).toContain(
        "differentword"
      );
    } finally {
      harness.database.close();
    }
  });

  it("enforces pinned identities, closed schemas, CSRF, role, and recent auth", async () => {
    const harness = await createHarness();
    try {
      const unpinned = passingSubmission();
      unpinned.runner.revision = "0".repeat(40);
      const unpinnedResponse = await handleRequest(
        benchmarkRequest(unpinned),
        harness.env
      );
      expect(unpinnedResponse.status).toBe(400);
      expect(await unpinnedResponse.json()).toMatchObject({
        error: "invalid_request"
      });

      const unknownField = passingSubmission();
      unknownField.benchmark.fixtures[0].candidateWords[0].rawText =
        "must-not-pass";
      const unknownResponse = await handleRequest(
        benchmarkRequest(unknownField),
        harness.env
      );
      expect(unknownResponse.status).toBe(400);

      const missingCsrf = await handleRequest(
        benchmarkRequest(passingSubmission(), { csrf: false }),
        harness.env
      );
      expect(missingCsrf.status).toBe(403);
      expect(await missingCsrf.json()).toEqual({
        error: "invalid_csrf_token"
      });

      harness.database.exec(`
        UPDATE admin_user_roles
        SET role = 'producer', show_id = 'show_opera_en_la_selva'
        WHERE admin_user_id = '${adminId}';
      `);
      const producer = await handleRequest(
        benchmarkRequest(passingSubmission()),
        harness.env
      );
      expect(producer.status).toBe(403);
      expect(await producer.json()).toEqual({ error: "forbidden" });

      harness.database.exec(`
        UPDATE admin_user_roles
        SET role = 'super_admin', show_id = NULL
        WHERE admin_user_id = '${adminId}';
        UPDATE admin_users
        SET last_authenticated_at = datetime('now', '-16 minutes')
        WHERE id = '${adminId}';
      `);
      const stale = await handleRequest(
        benchmarkRequest(passingSubmission()),
        harness.env
      );
      expect(stale.status).toBe(403);
      expect(await stale.json()).toEqual({
        error: "recent_authentication_required"
      });
      expect(harness.objects.size).toBe(0);
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS count FROM alignment_benchmark_runs
      `).get()).toEqual({ count: 0 });
    } finally {
      harness.database.close();
    }
  });

  it("routes the benchmark collection before the method fallback", async () => {
    const response = await handleRequest(
      new Request(
        `${apiOrigin}/v1/admin/alignment-benchmarks`
      ),
      { ALLOWED_ORIGINS: siteOrigin }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

function passingSubmission() {
  const fixtures = [];
  for (const language of ["en", "es"]) {
    for (let fixtureNumber = 0; fixtureNumber < 12; fixtureNumber += 1) {
      const fixtureId = `${language}_fixture_${fixtureNumber}`;
      const goldWords = [];
      const candidateWords = [];
      for (let wordNumber = 0; wordNumber < 34; wordNumber += 1) {
        const wordId = `${fixtureId}_word_${wordNumber}`;
        const startsAtMs = 1_000 + wordNumber * 2_000;
        const endsAtMs = startsAtMs + 500;
        const text = wordNumber === 0
          ? lexicalSentinel
          : `${language}word${wordNumber}`;
        goldWords.push({
          wordId,
          cueId: `${fixtureId}_cue`,
          text,
          startsAtMs,
          endsAtMs
        });
        candidateWords.push({
          wordId,
          cueId: `${fixtureId}_cue`,
          text,
          startsAtMs,
          endsAtMs,
          confidence: 0.99,
          timingOrigin: "forced_alignment",
          unalignedReason: null
        });
      }
      fixtures.push({
        fixtureId,
        language,
        audioDurationMs: 120_000,
        sourceAudioSha256: digestFor(
          language === "en" ? 1 : 2,
          fixtureNumber
        ),
        transcriptRevisionSha256: digestFor(
          language === "en" ? 3 : 4,
          fixtureNumber
        ),
        resultManifestSha256: digestFor(
          language === "en" ? 5 : 6,
          fixtureNumber
        ),
        goldWords,
        candidateWords
      });
    }
  }
  const previewReviews = fixtures
    .flatMap((fixture) => fixture.goldWords.slice(0, 5).map((word) => ({
      fixtureId: fixture.fixtureId,
      wordId: word.wordId,
      acceptedWithoutClipping: true
    })))
    .slice(0, 100);
  return {
    schemaVersion: "alignment-benchmark-submission-v1",
    submissionId: "benchmark_submission_fixture",
    runner: {
      repository: ALIGNMENT_RUNNER_REPOSITORY,
      revision: ALIGNMENT_RUNNER_REVISION
    },
    benchmark: {
      corpusVersion: "rights-cleared-bilingual-v1",
      adapter: {
        name: "whisperx",
        version: "3.8.6",
        model: "default",
        modelVersion: "default-en-es-v1",
        settingsVersion: "whisperx-align-v1",
        runnerDigest: ALIGNMENT_RUNNER_DIGEST
      },
      fixtures,
      previewReviews,
      resourceRuns: [
        {
          language: "en",
          inputDurationMinutes: 60,
          wallClockMinutes: 12,
          peakMemoryMb: 4096,
          peakDiskMb: 2048,
          runner: "ubuntu-24.04-python-3.12"
        },
        {
          language: "es",
          inputDurationMinutes: 60,
          wallClockMinutes: 13,
          peakMemoryMb: 4096,
          peakDiskMb: 2048,
          runner: "ubuntu-24.04-python-3.12"
        }
      ],
      idempotencyChecks: fixtures.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        semanticOutputStable: true,
        maximumTimingDeltaMs: 0,
        duplicateBillableJobCreated: false
      })),
      cleanEnvironmentReproduced: true
    }
  };
}

function digestFor(prefix, value) {
  return `${String(prefix)}${value.toString(16).padStart(63, "0")}`;
}

async function createHarness() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const sessionTokenHash = await sha256Hex(
    `${sessionSecret}:${sessionToken}`
  );
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  database.prepare(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at, last_authenticated_at
    ) VALUES (?, ?, 'active', datetime('now'), datetime('now'))
  `).run(adminId, "benchmark-email-hash");
  database.prepare(`
    INSERT INTO admin_user_roles (
      id, admin_user_id, role, show_id
    ) VALUES (?, ?, 'super_admin', NULL)
  `).run("benchmark-role-fixture", adminId);
  database.prepare(`
    INSERT INTO admin_sessions (
      token_hash, admin_user_id, csrf_token_hash, expires_at
    ) VALUES (?, ?, ?, datetime('now', '+1 hour'))
  `).run(sessionTokenHash, adminId, csrfTokenHash);
  const objects = new Map();
  const mediaBucket = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async put(key, body, options) {
      if (objects.has(key)) return null;
      const storedBody = typeof body === "string"
        ? body
        : new TextDecoder().decode(body);
      const stored = {
        key,
        body: storedBody,
        size: new TextEncoder().encode(storedBody).byteLength,
        etag: `etag-${objects.size + 1}`,
        httpEtag: `"etag-${objects.size + 1}"`,
        customMetadata: options.customMetadata,
        checksums: {
          toJSON() {
            return { sha256: options.sha256 };
          }
        }
      };
      objects.set(key, stored);
      return stored;
    }
  };
  return {
    database,
    objects,
    env: {
      ENVIRONMENT: "staging",
      SITE_ORIGIN: siteOrigin,
      ALLOWED_ORIGINS: siteOrigin,
      ADMIN_SESSION_SECRET: sessionSecret,
      DB: d1Database(database),
      MEDIA_BUCKET: mediaBucket
    }
  };
}

function benchmarkRequest(
  submission,
  {
    method = "POST",
    csrf = true
  } = {}
) {
  const headers = new Headers({
    cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
    origin: siteOrigin
  });
  if (csrf) headers.set("x-podcast-csrf", csrfToken);
  if (submission !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(
    `${apiOrigin}/v1/admin/alignment-benchmarks`,
    {
      method,
      headers,
      ...(submission === undefined
        ? {}
        : { body: JSON.stringify(submission) })
    }
  );
}

function d1Database(database) {
  const prepare = (query) => {
    let values = [];
    const statement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first() {
        return database.prepare(query).get(...values) ?? null;
      },
      async all() {
        return { results: database.prepare(query).all(...values) };
      },
      async run() {
        return statement.executeRun();
      },
      executeRun() {
        const result = database.prepare(query).run(...values);
        return {
          success: true,
          meta: { changes: Number(result.changes) },
          results: []
        };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) =>
          statement.executeRun()
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}
