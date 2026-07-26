import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  sendAdminMagicLink,
  sendPodcastAnnouncementEmail
} from "../src/resend";

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

  it("follows one same-origin permanent redirect without dropping evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { location: "https://api.resend.com/emails/" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email_redirected" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    await expect(deliver()).resolves.toEqual({
      sent: true,
      providerId: "email_redirected"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.resend.com/emails/"
    );
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      authorization: "Bearer resend_fixture"
    });
  });

  it("never forwards the credential to an off-origin redirect", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" }
      })
    );

    await expect(deliver()).resolves.toEqual({
      sent: false,
      providerStatus: 307,
      failureCode: "provider_rejected",
      diagnosticCode: "fetch_redirect_rejected"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("classifies fetch exceptions without returning exception text", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Invalid authorization header Bearer secret_fixture")
    );

    const result = await deliver();

    expect(result).toEqual({
      sent: false,
      failureCode: "provider_unavailable",
      diagnosticCode: "fetch_header_invalid"
    });
    expect(JSON.stringify(result)).not.toContain("secret_fixture");
    expect(JSON.stringify(result)).not.toContain("authorization");
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

  it("sends announcements with one-click unsubscribe and pseudonymous tags", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_announcement" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const deliveryId = `delivery_${"a".repeat(32)}`;
    const result = await sendPodcastAnnouncementEmail(
      {
        RESEND_API_KEY: "resend_fixture",
        PODCAST_EMAIL_FROM:
          "Dust Wave Podcasts <podcasts@dustwave.xyz>"
      } as PodcastEnv,
      {
        bodyMarkdown: "Listen to <script>alert('no')</script> **now**.",
        ctaLabel: "Listen",
        ctaUrl: "https://dustwave.xyz/podcasts/show/episode/",
        deliveryId,
        deliveryKey: deliveryId,
        email: "listener@example.com",
        heading: "New episode",
        subject: "Episode 1",
        unsubscribeUrl:
          `https://feeds.dustwave.xyz/v1/notifications/unsubscribe/${
            "b".repeat(43)
          }`
      }
    );
    const payload = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body)
    ) as Record<string, unknown>;

    expect(result).toEqual({
      sent: true,
      providerId: "email_announcement"
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "idempotency-key": `podcast-announcement/${deliveryId}`
    });
    expect(payload).toMatchObject({
      to: ["listener@example.com"],
      headers: {
        "List-Unsubscribe":
          `<https://feeds.dustwave.xyz/v1/notifications/unsubscribe/${
            "b".repeat(43)
          }>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      },
      tags: [
        { name: "podcast_delivery", value: deliveryId },
        { name: "category", value: "announcement" }
      ]
    });
    expect(String(payload.html)).not.toContain("<script>");
    expect(String(payload.html)).toContain("&lt;script");
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
