import { describe, expect, it } from "vitest";

import {
  readBoundedText,
  readJsonObject
} from "../src/validation";

describe("bounded JSON input", () => {
  it("measures the body even when content-length is absent", async () => {
    const request = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{}${" ".repeat(20)}`
    });
    request.headers.delete("content-length");

    await expect(readJsonObject(request, 10)).rejects.toMatchObject({
      code: "body_too_large",
      status: 413
    });
  });

  it("retains the required-object contract after byte validation", async () => {
    const request = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]"
    });

    await expect(readJsonObject(request, 10)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400
    });
  });

  it("cancels a chunked body as soon as it crosses the byte limit", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":"'));
        controller.enqueue(encoder.encode("x".repeat(100)));
        controller.enqueue(encoder.encode('"}'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      body,
      duplex: "half"
    };
    const request = new Request(
      "https://feeds.dustwave.xyz/v1/test",
      init
    );
    request.headers.delete("content-length");

    await expect(readBoundedText(request, 20)).rejects.toMatchObject({
      code: "body_too_large",
      status: 413
    });
    expect(cancelled).toBe(true);
  });
});
