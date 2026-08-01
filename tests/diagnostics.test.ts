import { describe, expect, it } from "vitest";
import { hmacSha256 } from "@dustwave/worker-core/crypto";

import syntheticFixture from "../config/virtual-audio-synthetic-fixture.json";
import type { PodcastEnv } from "../src/env";
import {
  issueStagingVirtualAudioCapability,
  manageStagingVirtualAudioGate,
  manageStagingVirtualAudioFixtureObject,
  serveStagingVirtualAudioDiagnostic,
  serveStagingVirtualAudioPlayer
} from "../src/diagnostics";

const TEST_SIGNING_SECRET = "diagnostic-test-signing-secret";
const TEST_PROCESSOR_SECRET = "diagnostic-test-processor-secret";

describe("staging virtual-audio diagnostic", () => {
  it("is unavailable outside staging even with a matching token", async () => {
    const capability = await testCapability();
    const response = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture"),
      {
        ENVIRONMENT: "production",
        AD_DECISION_MODE: "staging_validate",
        AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET
      } as unknown as PodcastEnv,
      capability
    );

    expect(response.status).toBe(404);
    expect(
      serveStagingVirtualAudioPlayer({
        ENVIRONMENT: "production"
      } as unknown as PodcastEnv).status
    ).toBe(404);
    expect(
      serveStagingVirtualAudioPlayer({
        ENVIRONMENT: "staging"
      } as PodcastEnv).status
    ).toBe(404);
  });

  it("serves a no-store, staging-only player without embedding a token", async () => {
    const response = serveStagingVirtualAudioPlayer({
      ENVIRONMENT: "staging",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET
    } as unknown as PodcastEnv);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "media-src 'self'"
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('type="password"');
    expect(html).not.toContain(TEST_SIGNING_SECRET);
    expect(html).not.toContain("AD_DECISION_SIGNING_SECRET");
  });

  it("streams only when a constant-time staging capability matches", async () => {
    const capability = await testCapability();
    const bytesByKey: Record<string, Uint8Array> = Object.fromEntries([
      ...syntheticFixture.sources.map((source) => [
        source.objectKey,
        new Uint8Array(source.bytes)
      ]),
      [
        syntheticFixture.assemblies.virtual.objectKey,
        new Uint8Array(syntheticFixture.assemblies.virtual.bytes)
      ]
    ]);
    const reads: Array<{ key: string; offset: number; length: number }> = [];
    const bucket = {
      async get(key: string, options: R2GetOptions) {
        const source = bytesByKey[key];
        if (!source) return null;
        const range = options.range as { offset: number; length: number };
        reads.push({ key, ...range });
        return {
          body: new Response(
            source.slice(range.offset, range.offset + range.length)
          ).body,
          size: source.byteLength,
          httpEtag: `"${key}"`,
          range,
          writeHttpMetadata() {}
        };
      }
    } as unknown as R2Bucket;
    const env = {
      ENVIRONMENT: "staging",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
      MEDIA_BUCKET: bucket
    } as PodcastEnv;

    const hidden = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture"),
      env,
      `invalid.${Math.floor(Date.now() / 1_000) + 600}.${"a".repeat(64)}`
    );
    expect(hidden.status).toBe(404);

    const response = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture", {
        headers: { range: "bytes=80664-80668" }
      }),
      env,
      capability
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 80664-80668/${syntheticFixture.assemblies.virtual.bytes}`
    );
    expect((await response.arrayBuffer()).byteLength).toBe(5);

    const baseline = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture", {
        headers: { range: "bytes=80664-80668" }
      }),
      env,
      capability,
      "baseline"
    );
    expect(baseline.status).toBe(206);
    expect(baseline.headers.get("content-range")).toBe(
      `bytes 80664-80668/${syntheticFixture.assemblies.virtual.bytes}`
    );
    expect(reads.at(-1)).toEqual({
      key: syntheticFixture.assemblies.virtual.objectKey,
      offset: 80_664,
      length: 5
    });
  });

  it("bounds fixture setup and requires an active staging lease", async () => {
    const capability = await testCapability();
    const fixture = syntheticFixture.sources[0];
    const objects = new Map<string, Uint8Array>([
      [fixture.objectKey, new Uint8Array(fixture.bytes)]
    ]);
    let puts = 0;
    const bucket = {
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            );
          }
        };
      },
      async put() {
        puts += 1;
        throw new Error("Mismatched bytes must not be stored.");
      },
      async delete(key: string) {
        objects.delete(key);
      }
    } as unknown as R2Bucket;
    const env = {
      ENVIRONMENT: "staging",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
      DB: activeLeaseDb(),
      MEDIA_BUCKET: bucket
    } as PodcastEnv;
    const objectUrl =
      `https://example.test/v1/diagnostics/virtual-audio/${capability}`
      + `/objects/${fixture.filename}`;

    const hidden = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl),
      env,
      `invalid.${Math.floor(Date.now() / 1_000) + 600}.${"a".repeat(64)}`,
      fixture.filename
    );
    expect(hidden.status).toBe(404);

    const revoked = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl),
      {
        ...env,
        DB: activeLeaseDb(false)
      },
      capability,
      fixture.filename
    );
    expect(revoked.status).toBe(404);

    const mismatched = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, {
        method: "GET"
      }),
      env,
      capability,
      fixture.filename
    );
    expect(mismatched.status).toBe(200);
    expect(await mismatched.json()).toMatchObject({
      filename: fixture.filename,
      bytes: fixture.bytes,
      matches: false
    });

    const rejected = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, {
        method: "PUT",
        headers: {
          "content-length": String(fixture.bytes),
          "content-type": "audio/mpeg"
        },
        body: new Uint8Array(fixture.bytes)
      }),
      env,
      capability,
      fixture.filename
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "fixture_contract_mismatch"
    });
    expect(puts).toBe(0);

    const deleted = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, { method: "DELETE" }),
      env,
      capability,
      fixture.filename
    );
    expect(deleted.status).toBe(204);
    expect(objects.has(fixture.objectKey)).toBe(false);
  });

  it("exchanges a one-time hashed lease for a bounded signed capability", async () => {
    const leaseId = "lease_diagnostic_test_01";
    const leaseToken = "t".repeat(48);
    const expiresAt = new Date(Date.now() + 10 * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const bindings: unknown[][] = [];
    let exchangeAvailable = true;
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values);
            return {
              async first() {
                if (!exchangeAvailable) return null;
                exchangeAvailable = false;
                return { expires_at: expiresAt };
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const response = await issueStagingVirtualAudioCapability(
      new Request("https://example.test/capability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId, token: leaseToken })
      }),
      {
        ENVIRONMENT: "staging",
        AD_DECISION_MODE: "staging_validate",
        AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
        DB: db
      } as PodcastEnv
    );
    const payload = await response.json<{
      capability: string;
      expiresAt: string;
    }>();

    expect(response.status).toBe(201);
    expect(payload.capability).toMatch(
      new RegExp(`^${leaseId}\\.[0-9]{10}\\.[a-f0-9]{64}$`)
    );
    expect(JSON.stringify(payload)).not.toContain(leaseToken);
    expect(bindings).toHaveLength(1);
    expect(bindings[0][0]).toBe(leaseId);
    expect(bindings[0][1]).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings[0][1]).not.toBe(leaseToken);

    const replay = await issueStagingVirtualAudioCapability(
      new Request("https://example.test/capability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId, token: leaseToken })
      }),
      {
        ENVIRONMENT: "staging",
        AD_DECISION_MODE: "staging_validate",
        AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
        DB: db
      } as PodcastEnv
    );
    expect(replay.status).toBe(404);
    expect(bindings).toHaveLength(2);
  });

  it("hides signed gate management outside isolated staging and before D1", async () => {
    let prepares = 0;
    const db = {
      prepare() {
        prepares += 1;
        throw new Error("D1 must remain untouched");
      }
    } as unknown as D1Database;
    const request = await signedGateRequest({
      action: "create_lease",
      leaseId: "lease_diagnostic_test_02",
      tokenHash: "a".repeat(64)
    });
    const production = await manageStagingVirtualAudioGate(request, {
      ENVIRONMENT: "production",
      AD_DECISION_MODE: "staging_validate",
      AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
      MEDIA_PROCESSOR_CALLBACK_SECRET: TEST_PROCESSOR_SECRET,
      DB: db
    } as unknown as PodcastEnv);
    expect(production.status).toBe(404);

    const invalidSignature = await manageStagingVirtualAudioGate(
      new Request("https://example.test/v1/diagnostics/virtual-audio/gate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-podcast-processor-timestamp": String(
            Math.floor(Date.now() / 1_000)
          ),
          "x-podcast-processor-signature": "0".repeat(64)
        },
        body: JSON.stringify({ action: "delete_lease", leaseId: "x".repeat(20) })
      }),
      stagingGateEnv(db)
    );
    expect(invalidSignature.status).toBe(404);
    expect(prepares).toBe(0);
  });

  it("creates and removes only an exact signed diagnostic lease", async () => {
    const leaseId = "lease_diagnostic_test_03";
    const tokenHash = "b".repeat(64);
    let leasePresent = false;
    const bindings: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values);
            return {
              async run() {
                if (sql.includes("INSERT OR IGNORE")) leasePresent = true;
                if (sql.startsWith("DELETE FROM virtual_audio_diagnostic_leases WHERE id")) {
                  leasePresent = false;
                }
                return { meta: { changes: 1 } };
              },
              async first() {
                if (sql.includes("SELECT id, expires_at")) {
                  return leasePresent
                    ? { id: leaseId, expires_at: "2099-01-01 00:00:00" }
                    : null;
                }
                if (sql.includes("SELECT COUNT(*) AS count")) {
                  return { count: leasePresent ? 1 : 0 };
                }
                return null;
              }
            };
          },
          async run() {
            return { meta: { changes: 0 } };
          }
        };
      }
    } as unknown as D1Database;
    const created = await manageStagingVirtualAudioGate(
      await signedGateRequest({ action: "create_lease", leaseId, tokenHash }),
      stagingGateEnv(db)
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ leaseId });
    expect(bindings.some((values) => values.includes(tokenHash))).toBe(true);

    const removed = await manageStagingVirtualAudioGate(
      await signedGateRequest({ action: "delete_lease", leaseId }),
      stagingGateEnv(db)
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      leaseId,
      removed: true,
      changed: true
    });
    expect(leasePresent).toBe(false);
  });

  it("records immutable aggregate gate evidence idempotently", async () => {
    let stored: unknown[] | null = null;
    let insertChanges = 1;
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.includes("INSERT OR IGNORE INTO virtual_audio_gate_runs")) {
                  if (!stored) stored = values;
                  const changes = insertChanges;
                  insertChanges = 0;
                  return { meta: { changes } };
                }
                return { meta: { changes: 0 } };
              },
              async first() {
                if (!stored) return null;
                return gateRow(stored);
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const body = {
      action: "record_gate",
      sourceCommit: "c".repeat(40),
      generatedAt: new Date().toISOString(),
      pairedRequests: 5_000,
      totalMeasuredRequests: 10_000,
      protocolProbeCount: 24,
      protocolFailedCount: 0,
      failedRequests: 3,
      contentMismatches: 0,
      p95AddedMs: 58.28,
      protocolPassed: true,
      loadPassed: true,
      cleanupComplete: true,
      diagnosticLeaseRemoved: true,
      uploadedObjectsRemoved: true,
      failureCode: null,
      githubRepository: "aindaco1/dust-wave-podcast",
      githubRunId: "123456789",
      githubRunAttempt: 1
    };
    const created = await manageStagingVirtualAudioGate(
      await signedGateRequest(body),
      stagingGateEnv(db)
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: "virtual_audio_gate_123456789_1",
      recorded: true,
      created: true
    });

    const replay = await manageStagingVirtualAudioGate(
      await signedGateRequest(body),
      stagingGateEnv(db)
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      recorded: true,
      created: false
    });
  });
});

async function signedGateRequest(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    TEST_PROCESSOR_SECRET,
    "hex"
  );
  return new Request(
    "https://example.test/v1/diagnostics/virtual-audio/gate",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podcast-processor-timestamp": String(timestamp),
        "x-podcast-processor-signature": signature
      },
      body: rawBody
    }
  );
}

function stagingGateEnv(db: D1Database): PodcastEnv {
  return {
    ENVIRONMENT: "staging",
    AD_DECISION_MODE: "staging_validate",
    AD_DECISION_SIGNING_SECRET: TEST_SIGNING_SECRET,
    MEDIA_PROCESSOR_CALLBACK_SECRET: TEST_PROCESSOR_SECRET,
    DB: db
  } as PodcastEnv;
}

function gateRow(values: unknown[]) {
  return {
    id: values[0],
    source_commit: values[1],
    generated_at: values[2],
    paired_requests: values[3],
    total_measured_requests: values[4],
    protocol_probe_count: values[5],
    protocol_failed_count: values[6],
    failed_requests: values[7],
    content_mismatches: values[9],
    p95_added_ms: values[10],
    protocol_passed: values[11],
    load_passed: values[12],
    cleanup_complete: values[13],
    diagnostic_lease_removed: values[14],
    uploaded_objects_removed: values[15],
    failure_code: values[16],
    github_repository: values[17],
    github_run_id: values[18],
    github_run_attempt: values[19]
  };
}

async function testCapability(): Promise<string> {
  const leaseId = "lease_diagnostic_test_01";
  const expires = Math.floor(Date.now() / 1_000) + 10 * 60;
  const signature = await hmacSha256(
    [
      "dust-wave-virtual-audio-capability-v1",
      leaseId,
      String(expires)
    ].join("\n"),
    TEST_SIGNING_SECRET,
    "hex"
  );
  return `${leaseId}.${expires}.${signature}`;
}

function activeLeaseDb(active = true): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return active ? { id: "lease_diagnostic_test_01" } : null;
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}
