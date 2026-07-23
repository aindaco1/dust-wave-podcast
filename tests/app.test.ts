import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/app";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    ALLOWED_ORIGINS: "https://dustwave.xyz,http://localhost:8080",
    MEDIA_KEY_PREFIX: "podcasts/",
    YOUTUBE_CHANNEL_URL: "https://youtube.com/@dustwavecollective",
    ...overrides
  } as Env;
}

describe("podcast API", () => {
  it("reports service health without querying storage", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/health"),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "dust-wave-podcast",
      environment: "staging"
    });
  });

  it("reflects only an explicitly allowed CORS origin", async () => {
    const allowed = await handleRequest(
      new Request("https://podcast.example/health", {
        headers: { origin: "https://dustwave.xyz" }
      }),
      createEnv()
    );
    const denied = await handleRequest(
      new Request("https://podcast.example/health", {
        headers: { origin: "https://attacker.example" }
      }),
      createEnv()
    );

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://dustwave.xyz");
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("returns a structured 404 for unknown routes", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/unknown"),
      createEnv()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("rejects unsupported methods", async () => {
    const response = await handleRequest(
      new Request("https://podcast.example/health", { method: "POST" }),
      createEnv()
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });
});

