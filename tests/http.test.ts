import { describe, expect, it } from "vitest";

import {
  json,
  options,
  privateCorsHeaders,
  privateJson,
  trustedAllowedOrigin
} from "../src/http";

const ORIGINS = "https://admin.dustwave.xyz, https://dustwave.xyz";

function request(origin?: string): Request {
  return new Request("https://feeds.dustwave.xyz/v1/test", {
    headers: origin ? { origin } : undefined
  });
}

describe("Podcast HTTP responses", () => {
  it("reflects only exact allow-listed origins", () => {
    expect(trustedAllowedOrigin(request("https://dustwave.xyz"), ORIGINS)).toBe(
      "https://dustwave.xyz"
    );
    expect(trustedAllowedOrigin(request("https://evil.example"), ORIGINS)).toBeNull();
    expect(trustedAllowedOrigin(request(), ORIGINS)).toBeNull();
  });

  it("provides credentialed private CORS headers for trusted origins", () => {
    const headers = new Headers(
      privateCorsHeaders(request("https://admin.dustwave.xyz"), ORIGINS)
    );

    expect(Object.fromEntries(headers)).toEqual({
      "access-control-allow-credentials": "true",
      "access-control-allow-headers":
        "content-type,if-none-match,if-range,range,x-podcast-csrf,x-podcast-upload-bytes,x-turnstile-token",
      "access-control-allow-methods": "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-origin": "https://admin.dustwave.xyz",
      "access-control-max-age": "86400",
      vary: "Origin"
    });
    expect(Object.fromEntries(new Headers(privateCorsHeaders(request(), ORIGINS)))).toEqual({});
  });

  it("builds JSON responses with secure defaults and caller overrides", async () => {
    const response = json(
      request("https://dustwave.xyz"),
      ORIGINS,
      { ok: true },
      { status: 201, headers: { "cache-control": "public, max-age=60", etag: "abc" } }
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://dustwave.xyz"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("etag")).toBe("abc");
  });

  it("forces private no-store and no-index policy after caller headers", async () => {
    const response = privateJson(
      request("https://admin.dustwave.xyz"),
      ORIGINS,
      { secret: false },
      { headers: { "cache-control": "public", "x-robots-tag": "index" } }
    );

    expect(await response.json()).toEqual({ secret: false });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("returns empty preflight responses with configurable credentials", async () => {
    const credentialed = options(request("https://admin.dustwave.xyz"), ORIGINS);
    const publicResponse = options(
      request("https://admin.dustwave.xyz"),
      ORIGINS,
      { credentials: false }
    );

    expect(credentialed.status).toBe(204);
    expect(await credentialed.text()).toBe("");
    expect(credentialed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(publicResponse.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
