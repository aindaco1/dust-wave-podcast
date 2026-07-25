import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import { sendAdminMagicLink } from "../src/resend";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Resend magic-link delivery evidence", () => {
  it("returns a provider ID without exposing the credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await deliver();

    expect(result).toEqual({
      sent: true,
      providerId: "email_fixture"
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: "Bearer resend_fixture",
      "idempotency-key": `podcast-admin-login/${"a".repeat(64)}`
    });
  });

  it("retains only a bounded provider status when Resend rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        name: "validation_error",
        message: "Rejected recipient admin@example.com"
      }), {
        status: 422,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await deliver();

    expect(result).toEqual({
      sent: false,
      providerStatus: 422,
      failureCode: "provider_rejected"
    });
    expect(JSON.stringify(result)).not.toContain("admin@example.com");
    expect(JSON.stringify(result)).not.toContain("Rejected recipient");
  });

  it("classifies timeouts without returning exception text", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("credential-shaped diagnostic", "TimeoutError")
    );

    const result = await deliver();

    expect(result).toEqual({
      sent: false,
      failureCode: "provider_timeout"
    });
    expect(JSON.stringify(result)).not.toContain("credential-shaped");
  });

  it("fails closed when no provider credential is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await sendAdminMagicLink(
      {} as PodcastEnv,
      deliveryInput()
    );

    expect(result).toEqual({
      sent: false,
      failureCode: "not_configured"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function deliver() {
  return sendAdminMagicLink(
    {
      RESEND_API_KEY: "resend_fixture",
      PODCAST_EMAIL_FROM:
        "Dust Wave Podcasts <podcasts@dustwave.xyz>"
    } as PodcastEnv,
    deliveryInput()
  );
}

function deliveryInput() {
  return {
    email: "admin@example.com",
    loginUrl:
      "https://dustwave.xyz/admin/podcasts/#magic-link=private_fixture",
    language: "es" as const,
    deliveryKey: "a".repeat(64)
  };
}
