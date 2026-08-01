import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeProcessorDispatch,
  claimProcessorDispatches,
  processorDispatchConfigured,
  rejectProcessorDispatchLease
} from "../src/processor-dispatches";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const callbackSecret = "processor_dispatch_callback_secret_fixture";
const manifestSha256 = "a".repeat(64);

describe("processor dispatch automation", () => {
  let sqlite;
  let env;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const filename of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
    }
    env = {
      ALLOWED_ORIGINS: "",
      DB: sqliteD1(sqlite),
      ENVIRONMENT: "staging",
      MEDIA_PROCESSOR_CALLBACK_SECRET: callbackSecret,
      PROCESSOR_DISPATCH_MODE: "github_actions_pull"
    };
    sqlite.prepare(
      `INSERT INTO processor_dispatches (
         id, processor_type, target_id, processor_manifest_sha256,
         source_requested_at
       ) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(
      "processor_dispatch_audio_qc_fixture",
      "audio_qc",
      "audio_qc_fixture",
      manifestSha256
    );
  });

  afterEach(() => sqlite.close());

  it("keeps dispatch unavailable outside the exact isolated staging mode", () => {
    expect(processorDispatchConfigured(env)).toBe(true);
    expect(processorDispatchConfigured({ ...env, ENVIRONMENT: "production" }))
      .toBe(false);
    expect(processorDispatchConfigured({
      ...env,
      PROCESSOR_DISPATCH_MODE: "disabled"
    })).toBe(false);
    expect(processorDispatchConfigured({
      ...env,
      MEDIA_PROCESSOR_CALLBACK_SECRET: undefined
    })).toBe(false);
  });

  it("leases exact queued work once and acknowledges a GitHub run idempotently", async () => {
    const claimResponse = await claimProcessorDispatches(
      signedRequest("/v1/processor/dispatches/claim", {
        action: "claim",
        dispatcher: "github-actions",
        maximum: 1
      }),
      env
    );
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json();
    expect(claim).toMatchObject({
      schemaVersion: 1,
      dispatches: [{
        id: "processor_dispatch_audio_qc_fixture",
        processorType: "audio_qc",
        targetId: "audio_qc_fixture",
        processorManifestSha256: manifestSha256,
        attempt: 1
      }]
    });
    expect(claim.dispatches[0].leaseId).toMatch(/^processor_lease_[a-f0-9-]+$/);

    const emptyClaimResponse = await claimProcessorDispatches(
      signedRequest("/v1/processor/dispatches/claim", {
        action: "claim",
        dispatcher: "github-actions",
        maximum: 1
      }),
      env
    );
    expect((await emptyClaimResponse.json()).dispatches).toEqual([]);

    const acknowledgementBody = {
      action: "dispatched",
      dispatchId: "processor_dispatch_audio_qc_fixture",
      leaseId: claim.dispatches[0].leaseId,
      githubRunId: "123456789"
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acknowledgement = await acknowledgeProcessorDispatch(
        signedRequest(
          "/v1/processor/dispatches/processor_dispatch_audio_qc_fixture/dispatched",
          acknowledgementBody
        ),
        env,
        "processor_dispatch_audio_qc_fixture"
      );
      expect(acknowledgement.status).toBe(200);
    }
    expect(sqlite.prepare(
      `SELECT status, attempt_count, github_run_id, lease_expires_at
       FROM processor_dispatches
       WHERE id = 'processor_dispatch_audio_qc_fixture'`
    ).get()).toEqual({
      status: "dispatched",
      attempt_count: 1,
      github_run_id: "123456789",
      lease_expires_at: null
    });
  });

  it("discovers pending source jobs through the normalized view", async () => {
    sqlite.exec(`
      DELETE FROM processor_dispatches;
      INSERT INTO shows (
        id, slug, title, canonical_url, rss_slug
      ) VALUES (
        'show_dispatch_fixture',
        'dispatch-fixture',
        'Dispatch fixture',
        'https://dustwave.xyz/podcasts/dispatch-fixture/',
        'dispatch-fixture'
      );
      INSERT INTO episodes (
        id, show_id, slug, title, canonical_url, source_language
      ) VALUES (
        'episode_dispatch_fixture',
        'show_dispatch_fixture',
        'queued-audio',
        'Queued audio',
        'https://dustwave.xyz/news/podcasts/dispatch-fixture/queued-audio/',
        'en'
      );
      INSERT INTO media_uploads (
        id, show_id, episode_id, kind, object_key, r2_upload_id,
        filename, content_type, expected_bytes, status, completed_bytes,
        object_etag
      ) VALUES (
        'upload_dispatch_fixture',
        'show_dispatch_fixture',
        'episode_dispatch_fixture',
        'source_audio',
        'staging/dispatch-fixture/source.wav',
        'r2-dispatch-fixture',
        'source.wav',
        'audio/wav',
        1024,
        'completed',
        1024,
        'source-etag'
      );
      INSERT INTO audio_qc_runs (
        id, episode_id, source_upload_id, source_object_key,
        source_object_bytes, source_object_etag, source_mime_type,
        policy_revision, policy_json, processor_manifest_sha256
      ) VALUES (
        'audio_qc_source_fixture',
        'episode_dispatch_fixture',
        'upload_dispatch_fixture',
        'staging/dispatch-fixture/source.wav',
        1024,
        'source-etag',
        'audio/wav',
        1,
        '{"schemaVersion":"audio-qc-policy-v1","revision":1}',
        '${"b".repeat(64)}'
      );
    `);

    const claimResponse = await claimProcessorDispatches(
      signedRequest("/v1/processor/dispatches/claim", {
        action: "claim",
        dispatcher: "github-actions",
        maximum: 1
      }),
      env
    );
    expect(await claimResponse.json()).toMatchObject({
      dispatches: [{
        id: "processor_dispatch_audio_qc_audio_qc_source_fixture",
        processorType: "audio_qc",
        targetId: "audio_qc_source_fixture",
        processorManifestSha256: "b".repeat(64),
        attempt: 1
      }]
    });
  });

  it("requeues a failed dispatch with bounded backoff and rejects a stale lease", async () => {
    const claim = await (await claimProcessorDispatches(
      signedRequest("/v1/processor/dispatches/claim", {
        action: "claim",
        dispatcher: "github-actions",
        maximum: 1
      }),
      env
    )).json();
    const failureBody = {
      action: "dispatch_failed",
      dispatchId: "processor_dispatch_audio_qc_fixture",
      leaseId: claim.dispatches[0].leaseId,
      failureCode: "github_dispatch_http_503"
    };
    const failureResponse = await rejectProcessorDispatchLease(
      signedRequest(
        "/v1/processor/dispatches/processor_dispatch_audio_qc_fixture/failed",
        failureBody
      ),
      env,
      "processor_dispatch_audio_qc_fixture"
    );
    expect(failureResponse.status).toBe(200);
    expect(sqlite.prepare(
      `SELECT status, attempt_count, lease_expires_at, last_error
       FROM processor_dispatches
       WHERE id = 'processor_dispatch_audio_qc_fixture'`
    ).get()).toEqual({
      status: "queued",
      attempt_count: 1,
      lease_expires_at: null,
      last_error: "github_dispatch_http_503"
    });

    const staleResponse = await rejectProcessorDispatchLease(
      signedRequest(
        "/v1/processor/dispatches/processor_dispatch_audio_qc_fixture/failed",
        failureBody
      ),
      env,
      "processor_dispatch_audio_qc_fixture"
    );
    expect(staleResponse.status).toBe(409);
  });

  it("rejects unsigned claims and hides the boundary when disabled", async () => {
    const unsigned = await claimProcessorDispatches(
      new Request("https://worker.example/v1/processor/dispatches/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "claim",
          dispatcher: "github-actions",
          maximum: 1
        })
      }),
      env
    );
    expect(unsigned.status).toBe(401);

    const disabled = await claimProcessorDispatches(
      signedRequest("/v1/processor/dispatches/claim", {
        action: "claim",
        dispatcher: "github-actions",
        maximum: 1
      }),
      { ...env, PROCESSOR_DISPATCH_MODE: "disabled" }
    );
    expect(disabled.status).toBe(404);
  });
});

function signedRequest(pathname, body) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", callbackSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return new Request(`https://worker.example${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-podcast-processor-timestamp": timestamp,
      "x-podcast-processor-signature": signature
    },
    body: rawBody
  });
}

function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      return {
        bind(...input) {
          values = input;
          return this;
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return {
            results: sqlite.prepare(query).all(...values),
            success: true,
            meta: { changes: 0 }
          };
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
