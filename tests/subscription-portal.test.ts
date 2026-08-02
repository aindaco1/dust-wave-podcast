import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import { LISTENER_SESSION_COOKIE } from "../src/listener-auth";
import { createListenerBillingPortal } from "../src/subscription-checkout";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const siteOrigin = "https://dustwave.xyz";
const showId = "show_portal_fixture";
const showSlug = "portal-fixture";
const listenerId = "listener_portal_fixture";
const sessionToken = "portal_session_fixture";
const csrfToken = "portal_csrf_fixture";
const sessionSecret = "portal_listener_session_secret";
const customerId = "cus_portal_fixture";
const configurationId = "bpc_portal_fixture";
const portalUrl = "https://billing.stripe.com/p/session/test_portal_fixture";

describe("listener Stripe Billing Portal", () => {
  let fixture: Awaited<ReturnType<typeof portalFixture>> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fixture?.sqlite.close();
    fixture = undefined;
  });

  it("creates an exact hosted session for the authenticated Stripe customer", async () => {
    fixture = await portalFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    const response = await createListenerBillingPortal(
      portalRequest(),
      fixture.env,
      showSlug
    );
    const payload = await response.json() as { portal: { url: string } };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload).toEqual({ portal: { url: portalUrl } });
    expect(provider.params).toEqual({
      configuration: configurationId,
      customer: customerId,
      return_url: `${siteOrigin}/podcasts/account/`
    });
    expect(provider.idempotencyKeys).toHaveLength(1);
    expect(provider.idempotencyKeys[0]).toMatch(
      /^podcast-portal-listener_portal_fixture-portal-fixture-\d+$/
    );
    expect(fixture.sqlite.prepare(
      `SELECT action, attempt_count
       FROM subscription_billing_rate_limits`
    ).all()).toEqual([{ action: "portal_session", attempt_count: 1 }]);
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fails closed before Stripe for missing entitlement and invalid CSRF", async () => {
    fixture = await portalFixture({ includeStripeSource: false });
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    const missing = await createListenerBillingPortal(
      portalRequest(),
      fixture.env,
      showSlug
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "stripe_subscription_not_found"
    });

    const invalidCsrf = await createListenerBillingPortal(
      portalRequest({ csrf: "wrong_csrf" }),
      fixture.env,
      showSlug
    );
    expect(invalidCsrf.status).toBe(403);
    expect(await invalidCsrf.json()).toEqual({ error: "invalid_csrf_token" });
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("enforces the bounded per-session rate limit before provider I/O", async () => {
    fixture = await portalFixture();
    const provider = providerFixture();
    vi.stubGlobal("fetch", provider.fetch);

    for (let requestNumber = 1; requestNumber <= 10; requestNumber += 1) {
      const response = await createListenerBillingPortal(
        portalRequest(),
        fixture.env,
        showSlug
      );
      expect(response.status).toBe(200);
    }
    const limited = await createListenerBillingPortal(
      portalRequest(),
      fixture.env,
      showSlug
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(provider.fetch).toHaveBeenCalledTimes(10);
  });

  it("rejects a malformed provider destination without returning it", async () => {
    fixture = await portalFixture();
    const provider = providerFixture({
      url: "https://example.com/not-stripe"
    });
    vi.stubGlobal("fetch", provider.fetch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await createListenerBillingPortal(
      portalRequest(),
      fixture.env,
      showSlug
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "billing_portal_unavailable"
    });
  });
});

async function portalFixture({
  includeStripeSource = true
}: { includeStripeSource?: boolean } = {}) {
  const sqlite = migratedSqlite();
  const db = sqliteD1(sqlite);
  const priceId = "price_portal_fixture";
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, premium_enabled, billing_mode
     ) VALUES (?, ?, 'Portal fixture', ?, ?, 1, 'test')`
  ).run(
    showId,
    showSlug,
    `${siteOrigin}/podcasts/${showSlug}/`,
    showSlug
  );
  sqlite.prepare(
    `INSERT INTO show_prices (
       id, show_id, billing_period, amount_cents, currency,
       stripe_price_id, active
     ) VALUES (?, ?, 'month', 500, 'USD', 'price_provider_portal', 1)`
  ).run(priceId, showId);
  sqlite.prepare(
    `INSERT INTO listener_accounts (
       id, email_lookup_hash, email_ciphertext, email_verified_at
     ) VALUES (?, ?, 'not_retained:portal:v1', datetime('now'))`
  ).run(listenerId, "a".repeat(64));
  sqlite.prepare(
    `INSERT INTO listener_sessions (
       token_hash, listener_id, csrf_token_hash, expires_at
     ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z')`
  ).run(
    await sha256Hex(`${sessionSecret}:${sessionToken}`),
    listenerId,
    await sha256Hex(`${sessionSecret}:${csrfToken}`)
  );
  sqlite.prepare(
    `INSERT INTO subscriptions (
       id, listener_id, show_id, price_id, provider,
       provider_customer_id, provider_subscription_id, status,
       current_period_end
     ) VALUES (
       'subscription_portal_fixture', ?, ?, ?, 'stripe', ?,
       'sub_portal_fixture', 'active', '2099-01-01T00:00:00.000Z'
     )`
  ).run(listenerId, showId, priceId, customerId);
  if (includeStripeSource) {
    sqlite.prepare(
      `INSERT INTO subscription_entitlement_sources (
         id, listener_id, show_id, price_id, provider,
         provider_customer_id, provider_subscription_id, status,
         current_period_end
       ) VALUES (
         'source_portal_fixture', ?, ?, ?, 'stripe', ?,
         'sub_portal_fixture', 'active', '2099-01-01T00:00:00.000Z'
       )`
    ).run(listenerId, showId, priceId, customerId);
  }
  return {
    sqlite,
    env: {
      DB: db,
      ENVIRONMENT: "staging",
      SITE_ORIGIN: siteOrigin,
      ALLOWED_ORIGINS: siteOrigin,
      LISTENER_SESSION_SECRET: sessionSecret,
      LISTENER_EMAIL_LOOKUP_PEPPER: "portal_email_pepper",
      RESEND_API_KEY: "re_portal_fixture",
      TAX_QUOTE_HASH_SECRET: "portal_tax_quote_secret",
      STRIPE_SECRET_KEY: "sk_test_portal_fixture",
      STRIPE_PORTAL_CONFIGURATION_ID: configurationId
    } as unknown as PodcastEnv
  };
}

function portalRequest({ csrf = csrfToken }: { csrf?: string } = {}) {
  return new Request(
    `https://feeds.dustwave.xyz/v1/member/shows/${showSlug}/billing/portal`,
    {
      method: "POST",
      headers: {
        origin: siteOrigin,
        cookie: `${LISTENER_SESSION_COOKIE}=${sessionToken}`,
        "x-podcast-csrf": csrf
      }
    }
  );
}

function providerFixture({ url = portalUrl }: { url?: string } = {}) {
  const provider: {
    params: Record<string, string> | null;
    idempotencyKeys: string[];
    fetch: ReturnType<typeof vi.fn>;
  } = {
    params: null,
    idempotencyKeys: [],
    fetch: vi.fn()
  };
  provider.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const destination = new URL(String(input));
    expect(destination.pathname).toBe("/v1/billing_portal/sessions");
    expect(init?.method).toBe("POST");
    provider.params = Object.fromEntries(
      new URLSearchParams(String(init?.body ?? ""))
    );
    provider.idempotencyKeys.push(
      new Headers(init?.headers).get("idempotency-key") ?? ""
    );
    return new Response(JSON.stringify({
      id: "bps_portal_fixture",
      object: "billing_portal.session",
      livemode: false,
      url
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "request-id": "req_portal_fixture"
      }
    });
  });
  return provider;
}
