import { hmacSha256 } from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  readSignedJsonBody,
  verifySignedText
} from "../src/signed-callback";

describe("processor signed text", () => {
  it("binds a signature to its exact message and timestamp window", async () => {
    const secret = "processor-secret-fixture";
    const timestamp = 1_800_000_000;
    const message = "signed-upload-payload";
    const signature = await hmacSha256(
      `${timestamp}.${message}`,
      secret,
      "hex"
    );
    const request = new Request("https://podcast.example/output", {
      headers: {
        "x-podcast-processor-timestamp": String(timestamp),
        "x-podcast-processor-signature": signature
      }
    });
    const options = {
      secret,
      timestampHeader: "x-podcast-processor-timestamp",
      signatureHeader: "x-podcast-processor-signature",
      message,
      now: new Date(timestamp * 1_000)
    };

    await expect(verifySignedText(request, options))
      .resolves.toEqual({ ok: true });
    await expect(verifySignedText(request, {
      ...options,
      message: `${message}-changed`
    })).resolves.toEqual({
      ok: false,
      reason: "invalid_signature"
    });
    await expect(verifySignedText(request, {
      ...options,
      now: new Date((timestamp + 301) * 1_000)
    })).resolves.toEqual({
      ok: false,
      reason: "invalid_signature"
    });
  });

  it("rejects an oversized chunked callback before signature work", async () => {
    const request = new Request("https://podcast.example/output", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podcast-processor-timestamp": "1800000000",
        "x-podcast-processor-signature": "a".repeat(64)
      },
      body: `{"value":"${"x".repeat(100)}"}`
    });
    request.headers.delete("content-length");

    await expect(readSignedJsonBody(request, {
      secret: "processor-secret-fixture",
      timestampHeader: "x-podcast-processor-timestamp",
      signatureHeader: "x-podcast-processor-signature",
      maximumBytes: 20,
      bodyName: "Processor callback",
      invalidBodyCode: "invalid_processor_callback",
      now: new Date(1_800_000_000_000)
    })).rejects.toMatchObject({
      code: "body_too_large",
      status: 413
    });
  });
});
