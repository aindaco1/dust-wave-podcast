import { describe, expect, it } from "vitest";

import {
  boundedPageSize,
  isTruthy,
  optionalText,
  positiveInteger,
  readBoundedBytes,
  readOptionalJsonObject,
  readBoundedText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  safeFilename,
  validDateTime,
  validIdentifier,
  validSlug
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
      message: "A JSON object is required",
      code: "invalid_request",
      status: 400
    });
  });

  it("rejects an oversized declared content length before reading", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      }
    });
    const request = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      headers: { "content-length": "21" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedBytes(request, 20, "Upload")).rejects.toMatchObject({
      message: "Upload is too large",
      code: "body_too_large",
      status: 413
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("measures UTF-8 bytes instead of JavaScript characters", async () => {
    const request = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      body: "🌊"
    });
    request.headers.delete("content-length");

    await expect(readBoundedText(request, 3)).rejects.toMatchObject({
      code: "body_too_large",
      status: 413
    });
  });

  it("validates the byte limit", async () => {
    const request = new Request("https://feeds.dustwave.xyz/v1/test");

    await expect(readBoundedBytes(request, -1)).rejects.toThrow(
      new TypeError("maximumBytes must be a non-negative integer")
    );
  });

  it("accepts an empty optional object and rejects malformed JSON", async () => {
    const empty = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      body: "  \n"
    });
    const malformed = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "POST",
      body: "{"
    });

    await expect(readOptionalJsonObject(empty)).resolves.toEqual({});
    await expect(readOptionalJsonObject(malformed)).rejects.toMatchObject({
      message: "A JSON object is required",
      code: "invalid_request",
      status: 400
    });
  });

  it("returns exact bounded binary bytes without text conversion", async () => {
    const expected = new Uint8Array([0, 255, 1, 128]);
    const request = new Request("https://feeds.dustwave.xyz/v1/test", {
      method: "PUT",
      body: expected
    });

    expect(await readBoundedBytes(request, expected.byteLength)).toEqual(
      expected
    );
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

describe("scalar request validation", () => {
  it("preserves the public validation error contract", () => {
    const error = new RequestValidationError("Nope", "custom", 422);

    expect(error).toMatchObject({
      name: "RequestValidationError",
      message: "Nope",
      code: "custom",
      status: 422
    });
  });

  it("trims required and optional text and enforces length", () => {
    expect(requiredText("  title  ", "title", 5)).toBe("title");
    expect(optionalText(null, "summary")).toBe("");
    expect(() => requiredText(" ", "title")).toThrow("title is required");
    expect(() => optionalText("long", "summary", 3)).toThrow(
      "summary is too long"
    );
  });

  it("normalizes and validates slugs and identifiers", () => {
    expect(validSlug(" My-Episode ")).toBe("my-episode");
    expect(validIdentifier("Episode_12", "episodeId")).toBe("Episode_12");
    expect(() => validSlug("two words")).toThrow("slug must be URL-safe");
    expect(() => validIdentifier("-bad", "episodeId")).toThrow(
      "episodeId is invalid"
    );
  });

  it("normalizes date-times and permits missing optional values", () => {
    expect(validDateTime("2026-08-06T10:30:00-07:00", "publishAt")).toBe(
      "2026-08-06T17:30:00.000Z"
    );
    expect(validDateTime("", "publishAt")).toBeNull();
    expect(() => validDateTime("tomorrow-ish", "publishAt")).toThrow(
      "publishAt must be an ISO date-time"
    );
  });

  it("sanitizes Unicode filenames and rejects dot traversal names", () => {
    expect(safeFilename("Ｆoo / bar?.mp3")).toBe("Foo-bar-.mp3");
    expect(() => safeFilename("..")).toThrow("filename is invalid");
  });

  it("validates positive integers and bounded page sizes", () => {
    expect(positiveInteger("4", "count", 5)).toBe(4);
    expect(() => positiveInteger(6, "count", 5)).toThrow(
      "count must be a positive integer"
    );
    expect(boundedPageSize(null, 25, 100)).toBe(25);
    expect(boundedPageSize("100", 25, 100)).toBe(100);
    expect(() => boundedPageSize("101", 25, 100, "pageSize")).toThrow(
      "pageSize must be between 1 and 100"
    );
  });

  it("accepts only the documented truthy spellings", () => {
    expect(["1", "true", "TRUE", " yes ", "on"].map(isTruthy)).toEqual(
      [true, true, true, true, true]
    );
    expect([undefined, null, "0", "false", "off"].map(isTruthy)).toEqual(
      [false, false, false, false, false]
    );
  });
});
