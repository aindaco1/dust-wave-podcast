import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  dispatchPodcastProcessors,
  validateClaimResponse,
  validateLedgerSummary
} from "../scripts/dispatch-podcast-processors.mjs";

const environment = {
  GH_TOKEN: "github_token_fixture",
  GITHUB_REPOSITORY: "aindaco1/dust-wave-podcast",
  MEDIA_PROCESSOR_CALLBACK_SECRET: "processor_callback_secret_fixture",
  PROCESSOR_WORKFLOW_REF: "main"
};
const emptyLedger = {
  total: 0,
  queued: 0,
  leased: 0,
  dispatched: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0
};

describe("GitHub processor dispatcher", () => {
  it("claims, dispatches, and acknowledges one exact registered processor", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/processor/dispatches/claim")) {
        expectSignedWorkerRequest(init, environment.MEDIA_PROCESSOR_CALLBACK_SECRET);
        return Response.json({
          schemaVersion: 1,
          ledger: {
            ...emptyLedger,
            total: 1,
            leased: 1
          },
          dispatches: [{
            id: "processor_dispatch_delivery_fixture",
            processorType: "delivery_audio",
            targetId: "delivery_fixture",
            processorManifestSha256: "a".repeat(64),
            leaseId: "processor_lease_1234567890abcdef",
            attempt: 1
          }]
        });
      }
      if (url.includes("api.github.com")) {
        expect(init.headers.authorization).toBe("Bearer github_token_fixture");
        expect(JSON.parse(init.body)).toEqual({
          ref: "main",
          inputs: { job_id: "delivery_fixture" }
        });
        return Response.json({ workflow_run_id: 987654321 });
      }
      if (url.endsWith("/dispatched")) {
        expectSignedWorkerRequest(init, environment.MEDIA_PROCESSOR_CALLBACK_SECRET);
        expect(JSON.parse(init.body)).toMatchObject({
          action: "dispatched",
          dispatchId: "processor_dispatch_delivery_fixture",
          githubRunId: "987654321"
        });
        return Response.json({ dispatch: { status: "dispatched" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await dispatchPodcastProcessors({ fetchImpl, environment });
    expect(result).toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
      ledger: {
        ...emptyLedger,
        total: 1,
        leased: 1
      }
    });
    expect(requests).toHaveLength(3);
  });

  it("records a bounded dispatch failure without leaking a provider body", async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/processor/dispatches/claim")) {
        return Response.json({
          schemaVersion: 1,
          ledger: {
            ...emptyLedger,
            total: 1,
            leased: 1
          },
          dispatches: [{
            id: "processor_dispatch_clip_fixture",
            processorType: "clip_render",
            targetId: "clip_fixture",
            processorManifestSha256: "b".repeat(64),
            leaseId: "processor_lease_abcdef1234567890",
            attempt: 2
          }]
        });
      }
      if (url.includes("api.github.com")) {
        return new Response("provider payload must not be forwarded", {
          status: 503
        });
      }
      if (url.endsWith("/failed")) {
        expectSignedWorkerRequest(init, environment.MEDIA_PROCESSOR_CALLBACK_SECRET);
        expect(JSON.parse(init.body)).toEqual({
          action: "dispatch_failed",
          dispatchId: "processor_dispatch_clip_fixture",
          leaseId: "processor_lease_abcdef1234567890",
          failureCode: "github_dispatch_http_503"
        });
        return Response.json({ dispatch: { status: "retry_scheduled" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(dispatchPodcastProcessors({ fetchImpl, environment }))
      .rejects.toThrow("Processor dispatch failed for 1 claimed job(s)");
  });

  it("never rejects a lease after GitHub accepted the workflow", async () => {
    const urls = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v1/processor/dispatches/claim")) {
        return Response.json({
          schemaVersion: 1,
          ledger: {
            ...emptyLedger,
            total: 1,
            leased: 1
          },
          dispatches: [{
            id: "processor_dispatch_alignment_fixture",
            processorType: "alignment",
            targetId: "alignment_fixture",
            processorManifestSha256: "d".repeat(64),
            leaseId: "processor_lease_1234567890abcdef",
            attempt: 1
          }]
        });
      }
      if (url.includes("api.github.com")) {
        return Response.json({ workflow_run_id: 123456789 });
      }
      if (url.endsWith("/dispatched")) {
        return new Response("temporary worker failure", { status: 503 });
      }
      if (url.endsWith("/failed")) {
        throw new Error("accepted workflows must not be rejected");
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(dispatchPodcastProcessors({ fetchImpl, environment }))
      .rejects.toThrow("Processor dispatch failed for 1 claimed job(s)");
    expect(urls.filter((url) => url.endsWith("/dispatched"))).toHaveLength(3);
    expect(urls.some((url) => url.endsWith("/failed"))).toBe(false);
  });

  it("rejects unregistered or malformed claim data before GitHub access", () => {
    expect(() => validateClaimResponse({
      schemaVersion: 1,
      ledger: emptyLedger,
      dispatches: [{
        id: "processor_dispatch_fixture",
        processorType: "unknown_processor",
        targetId: "target_fixture",
        processorManifestSha256: "c".repeat(64),
        leaseId: "processor_lease_abcdef1234567890",
        attempt: 1
      }]
    })).toThrow("processor_claim_response_invalid");
  });

  it("accepts the prior additive response during a rolling Worker deploy", () => {
    expect(validateClaimResponse({
      schemaVersion: 1,
      dispatches: []
    })).toEqual([]);
  });

  it("rejects incomplete or internally inconsistent ledger evidence", () => {
    expect(() => validateLedgerSummary({
      ...emptyLedger,
      total: 2,
      failed: 1
    })).toThrow("processor_claim_response_invalid");
    expect(() => validateLedgerSummary({
      ...emptyLedger,
      queued: -1
    })).toThrow("processor_claim_response_invalid");
  });
});

function expectSignedWorkerRequest(init, secret) {
  const timestamp = init.headers["x-podcast-processor-timestamp"];
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${init.body}`)
    .digest("hex");
  expect(init.headers["x-podcast-processor-signature"]).toBe(expected);
}
