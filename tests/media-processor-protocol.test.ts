import { describe, expect, it, vi } from "vitest";

import {
  MINIMUM_MULTIPART_PART_BYTES,
  invalidMediaProcessorSignature,
  mediaProcessorAuthError,
  parseMediaProcessorMultipartEvidence,
  parseMediaProcessorPartPayload,
  readMediaProcessorSignedJson,
  validateMediaProcessorMultipartParts
} from "../src/media-processor-protocol";
import { RequestValidationError } from "../src/validation";

const DIGEST = "a".repeat(64);

function encodePayload(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

describe("media processor protocol", () => {
  it("normalizes feature-specific multipart part identities", () => {
    const payload = parseMediaProcessorPartPayload(encodePayload({
      derivativeId: "derivative_123",
      partNumber: 2,
      objectBytes: 32,
      sha256: DIGEST,
      manifestSha256: DIGEST
    }), {
      idField: "derivativeId",
      idLabel: "derivativeId",
      invalidPayloadMessage: "invalid derivative payload"
    });

    expect(payload).toEqual({
      id: "derivative_123",
      partNumber: 2,
      objectBytes: 32,
      sha256: DIGEST,
      manifestSha256: DIGEST
    });
  });

  it("preserves a feature-specific malformed-payload error", () => {
    expect(() => parseMediaProcessorPartPayload("not-base64-json", {
      idField: "jobId",
      idLabel: "jobId",
      invalidPayloadMessage: "invalid delivery payload"
    })).toThrowError("invalid delivery payload");
  });

  it("requires completion evidence to match the URL identity", () => {
    expect(() => parseMediaProcessorMultipartEvidence({
      jobId: "job_other",
      action: "upload-complete",
      objectBytes: 10,
      outputSha256: DIGEST,
      partCount: 1,
      manifestSha256: DIGEST
    }, "job_expected", { idField: "jobId" })).toThrowError(
      "The multipart evidence does not match its URL"
    );
  });

  it("accepts contiguous multipart evidence with an undersized final part", () => {
    expect(() => validateMediaProcessorMultipartParts([
      {
        part_number: 1,
        uploaded_bytes: MINIMUM_MULTIPART_PART_BYTES
      },
      { part_number: 2, uploaded_bytes: 17 }
    ], {
      partCount: 2,
      objectBytes: MINIMUM_MULTIPART_PART_BYTES + 17
    })).not.toThrow();
  });

  it("rejects gaps, undersized non-final parts, and byte-total drift", () => {
    expect(() => validateMediaProcessorMultipartParts([
      { part_number: 2, uploaded_bytes: 17 }
    ], { partCount: 1, objectBytes: 17 })).toThrowError(
      "The multipart parts must be contiguous"
    );
    expect(() => validateMediaProcessorMultipartParts([
      { part_number: 1, uploaded_bytes: 17 },
      { part_number: 2, uploaded_bytes: 17 }
    ], { partCount: 2, objectBytes: 34 })).toThrowError(
      "Every non-final multipart part must be at least 5 MiB"
    );
    expect(() => validateMediaProcessorMultipartParts([
      { part_number: 1, uploaded_bytes: 17 }
    ], { partCount: 1, objectBytes: 18 })).toThrowError(
      "The multipart byte total does not match the output"
    );
  });

  it("maps unavailable and invalid signed callbacks without leaking details", async () => {
    const unavailableResponse = vi.fn(() => new Response(null, { status: 404 }));
    const invalidSignatureResponse = vi.fn(
      () => new Response(null, { status: 401 })
    );
    const unavailable = await readMediaProcessorSignedJson(
      new Request("https://example.test/processor", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" }
      }),
      {
        available: false,
        secret: "test-secret",
        bodyName: "Processor request",
        invalidBodyCode: "invalid_processor_body",
        unavailableResponse,
        invalidSignatureResponse
      }
    );
    expect(unavailable).toBeInstanceOf(Response);
    expect((unavailable as Response).status).toBe(404);
    expect(invalidSignatureResponse).not.toHaveBeenCalled();

    const invalid = await readMediaProcessorSignedJson(
      new Request("https://example.test/processor", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-podcast-processor-timestamp": "1",
          "x-podcast-processor-signature": DIGEST
        }
      }),
      {
        available: true,
        secret: "test-secret",
        bodyName: "Processor request",
        invalidBodyCode: "invalid_processor_body",
        unavailableResponse,
        invalidSignatureResponse
      }
    );
    expect(invalid).toBeInstanceOf(Response);
    expect((invalid as Response).status).toBe(401);
  });

  it("shares the private processor authentication response contract", async () => {
    const request = new Request("https://example.test/processor", {
      headers: { origin: "https://admin.example.test" }
    });
    const allowedOrigins = "https://admin.example.test";
    const missing = mediaProcessorAuthError(
      request,
      allowedOrigins,
      "secret_missing"
    );
    const invalid = mediaProcessorAuthError(
      request,
      allowedOrigins,
      "invalid_signature"
    );

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({
      error: "invalid_processor_signature"
    });
    expect(invalid.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(invalid.headers.get("access-control-allow-origin")).toBe(
      "https://admin.example.test"
    );
    expect(invalidMediaProcessorSignature(
      request,
      { ALLOWED_ORIGINS: allowedOrigins } as never
    ).status).toBe(401);
  });

  it("uses the shared validation error type", () => {
    try {
      validateMediaProcessorMultipartParts([], {
        partCount: 0,
        objectBytes: 0
      });
      throw new Error("expected multipart validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
    }
  });
});
