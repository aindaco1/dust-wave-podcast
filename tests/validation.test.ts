import { describe, expect, it } from "vitest";

import { readJsonObject } from "../src/validation";

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
});
