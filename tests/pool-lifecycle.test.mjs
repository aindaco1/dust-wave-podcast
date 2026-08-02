import { hmacSha256, sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  recomputeSubscriptionProjection,
  reconcileExpiredSubscriptionProjections
} from "../src/billing";
import { servePrivateFeed } from "../src/feed";
import { LISTENER_SESSION_COOKIE } from "../src/listener-auth";
import {
  handlePoolGrantEvent,
  redeemPoolCode
} from "../src/pool-redemptions";
import {
  createListenerPrivateFeed,
  rotateListenerPrivateFeed
} from "../src/private-feeds";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const code = "DW-POD-ABCDEFGH-JKLMNPQR-STUVWXYZ-23456789";
const email = "listener@example.com";
const listenerId = "listener_pool_lifecycle";
const showId = "show_pool_lifecycle";
const showSlug = "pool-lifecycle";
const grantId = "grant_pool_lifecycle";
const sessionToken = "pool_lifecycle_session";
const csrfToken = "pool_lifecycle_csrf";
const sessionSecret = "pool_lifecycle_session_secret";
const emailPepper = "pool_lifecycle_email_pepper";
const bridgeSecret = "pool_lifecycle_bridge_secret";
const codePepper = "pool_lifecycle_code_pepper";
const feedPepper = "pool_lifecycle_feed_pepper";

describe("Pool benefit lifecycle contract", () => {
  let fixture;

  afterEach(() => fixture?.sqlite.close());

  it("rehearses grant, redemption, overlap, feed rotation, expiry, and revocation", async () => {
    fixture = await lifecycleFixture();

    const grant = grantEvent("event_pool_grant");
    expect(await sendGrantEvent(fixture.env, grant)).toMatchObject({
      status: 201,
      body: { status: "active", idempotent: false }
    });
    expect(await sendGrantEvent(fixture.env, grant)).toMatchObject({
      status: 200,
      body: { action: "grant", idempotent: true }
    });

    expect(await redeem(fixture.env)).toMatchObject({
      status: 201,
      body: {
        idempotent: false,
        redemption: { status: "active" }
      }
    });
    expect(await redeem(fixture.env)).toMatchObject({
      status: 200,
      body: {
        idempotent: true,
        redemption: { status: "active" }
      }
    });
    expect(poolSource(fixture.sqlite)).toMatchObject({
      provider_subscription_id: grantId,
      status: "active"
    });
    expect(projection(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "active"
    });
    expect(fixture.sqlite.prepare(
      "SELECT redemption_count FROM redemption_codes WHERE provider_grant_id = ?"
    ).get(grantId)).toEqual({ redemption_count: 1 });

    addStripeOverlap(fixture.sqlite);
    await recomputeSubscriptionProjection(fixture.env.DB, listenerId, showId);
    expect(projection(fixture.sqlite)).toMatchObject({
      provider: "stripe",
      status: "active"
    });
    fixture.sqlite.prepare(
      `UPDATE subscription_entitlement_sources
       SET status = 'canceled'
       WHERE listener_id = ? AND show_id = ? AND provider = 'stripe'`
    ).run(listenerId, showId);
    await recomputeSubscriptionProjection(fixture.env.DB, listenerId, showId);
    expect(projection(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "active"
    });
    fixture.sqlite.prepare(
      `DELETE FROM subscription_entitlement_sources
       WHERE listener_id = ? AND show_id = ? AND provider = 'stripe'`
    ).run(listenerId, showId);

    const initialFeed = await issueFeed(fixture.env, false);
    const rotatedFeed = await issueFeed(fixture.env, true);
    expect(initialFeed.status).toBe(201);
    expect(rotatedFeed.status).toBe(200);
    expect(rotatedFeed.body.feed.rotated).toBe(true);
    const initialToken = feedToken(initialFeed.body.feed.url);
    const rotatedToken = feedToken(rotatedFeed.body.feed.url);
    expect(rotatedToken).not.toBe(initialToken);
    expect(activeFeedTokens(fixture.sqlite)).toBe(1);
    expect(await feedStatus(fixture.env, initialToken)).toBe(404);
    expect(await feedStatus(fixture.env, rotatedToken)).toBe(200);
    expect(JSON.stringify(feedTokenRows(fixture.sqlite))).not.toContain(
      rotatedToken
    );

    fixture.sqlite.prepare(
      `UPDATE subscription_entitlement_sources
       SET current_period_end = '2000-01-01T00:00:00.000Z'
       WHERE listener_id = ? AND show_id = ? AND provider = 'pool'`
    ).run(listenerId, showId);
    expect(await reconcileExpiredSubscriptionProjections(fixture.env.DB))
      .toBe(1);
    expect(poolSource(fixture.sqlite).status).toBe("expired");
    expect(projection(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "expired"
    });
    expect(await feedStatus(fixture.env, rotatedToken)).toBe(404);
    expect((await issueFeed(fixture.env, true)).status).toBe(403);
    expect(await reconcileExpiredSubscriptionProjections(fixture.env.DB))
      .toBe(0);

    expect(await sendGrantEvent(fixture.env, {
      eventId: "event_pool_revoke",
      grantId,
      action: "revoke"
    })).toMatchObject({
      status: 200,
      body: { status: "revoked", idempotent: false }
    });
    expect(poolSource(fixture.sqlite).status).toBe("canceled");
    expect(projection(fixture.sqlite).status).toBe("canceled");
    expect(fixture.sqlite.prepare(
      "SELECT status FROM redemption_codes WHERE provider_grant_id = ?"
    ).get(grantId)).toEqual({ status: "revoked" });

    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(fixture.sqlite.prepare(
      "SELECT email_ciphertext FROM listener_accounts WHERE id = ?"
    ).get(listenerId)).toEqual({ email_ciphertext: "not_retained:pool:v1" });
    expect(fixture.sqlite.prepare(
      "SELECT code_hash FROM redemption_codes WHERE provider_grant_id = ?"
    ).get(grantId).code_hash).not.toBe(code);
  });

  it("repairs a stale aggregate after an interrupted expiry pass", async () => {
    fixture = await lifecycleFixture();
    fixture.sqlite.prepare(
      `INSERT INTO subscription_entitlement_sources (
         id, listener_id, show_id, provider,
         provider_subscription_id, status, current_period_end
       ) VALUES (?, ?, ?, 'pool', ?, 'expired', ?)`
    ).run(
      "source_pool_interrupted_expiry",
      listenerId,
      showId,
      "grant_pool_interrupted_expiry",
      "2000-01-01T00:00:00.000Z"
    );
    fixture.sqlite.prepare(
      `INSERT INTO subscriptions (
         id, listener_id, show_id, provider,
         provider_subscription_id, status, current_period_end
       ) VALUES (?, ?, ?, 'pool', ?, 'active', ?)`
    ).run(
      "subscription_pool_interrupted_expiry",
      listenerId,
      showId,
      "grant_pool_interrupted_expiry",
      "2000-01-01T00:00:00.000Z"
    );

    expect(await reconcileExpiredSubscriptionProjections(fixture.env.DB))
      .toBe(1);
    expect(projection(fixture.sqlite)).toMatchObject({
      provider: "pool",
      status: "expired"
    });
    expect(await reconcileExpiredSubscriptionProjections(fixture.env.DB))
      .toBe(0);
    expect(fixture.sqlite.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN (
           'subscription_entitlement_expiry',
           'subscription_projection_expiry'
         )
       ORDER BY name`
    ).all()).toEqual([
      { name: "subscription_entitlement_expiry" },
      { name: "subscription_projection_expiry" }
    ]);
  });
});

async function lifecycleFixture() {
  const sqlite = migratedSqlite();
  const db = sqliteD1(sqlite);
  const emailLookupHash = await hmacSha256(email, emailPepper, "hex");
  sqlite.prepare(
    `INSERT INTO shows (
       id, slug, title, canonical_url, rss_slug, premium_enabled, billing_mode
     ) VALUES (?, ?, ?, ?, ?, 1, 'test')`
  ).run(
    showId,
    showSlug,
    "Pool lifecycle",
    `https://staging.example/podcasts/${showSlug}/`,
    showSlug
  );
  sqlite.prepare(
    `INSERT INTO listener_accounts (
       id, email_lookup_hash, email_ciphertext, email_verified_at
     ) VALUES (?, ?, 'not_retained:pool:v1', datetime('now'))`
  ).run(listenerId, emailLookupHash);
  sqlite.prepare(
    `INSERT INTO listener_sessions (
       token_hash, listener_id, csrf_token_hash, expires_at
     ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z')`
  ).run(
    await sha256Hex(`${sessionSecret}:${sessionToken}`),
    listenerId,
    await sha256Hex(`${sessionSecret}:${csrfToken}`)
  );
  return {
    sqlite,
    env: {
      DB: db,
      ENVIRONMENT: "staging",
      SITE_ORIGIN: "https://dustwave.xyz",
      FEED_ORIGIN: "https://feeds.staging.example",
      MEDIA_ORIGIN: "https://media.staging.example",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      LISTENER_SESSION_SECRET: sessionSecret,
      LISTENER_EMAIL_LOOKUP_PEPPER: emailPepper,
      POOL_REDEMPTION_ENABLED: "true",
      POOL_PODCAST_BRIDGE_SECRET: bridgeSecret,
      POOL_REDEMPTION_CODE_PEPPER: codePepper,
      FEED_TOKEN_PEPPER: feedPepper
    }
  };
}

function grantEvent(eventId) {
  return {
    eventId,
    grantId,
    action: "grant",
    showSlug,
    email,
    code,
    durationDays: 30,
    redeemBy: "2030-01-01T00:00:00.000Z"
  };
}

async function sendGrantEvent(env, body) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    bridgeSecret,
    "hex"
  );
  const response = await handlePoolGrantEvent(
    new Request("https://feeds.staging.example/v1/internal/pool/grants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pool-podcast-timestamp": String(timestamp),
        "x-pool-podcast-signature": signature
      },
      body: rawBody
    }),
    env
  );
  return { status: response.status, body: await response.json() };
}

async function redeem(env) {
  const response = await redeemPoolCode(
    listenerRequest("https://feeds.staging.example/v1/member/redemptions/pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    }),
    env
  );
  return { status: response.status, body: await response.json() };
}

async function issueFeed(env, rotate) {
  const request = listenerRequest(
    `https://feeds.staging.example/v1/member/shows/${showSlug}/feed`,
    { method: "POST" }
  );
  const response = rotate
    ? await rotateListenerPrivateFeed(request, env, showSlug)
    : await createListenerPrivateFeed(request, env, showSlug);
  return { status: response.status, body: await response.json() };
}

function listenerRequest(url, init) {
  const headers = new Headers(init.headers);
  headers.set("origin", "https://dustwave.xyz");
  headers.set("cookie", `${LISTENER_SESSION_COOKIE}=${sessionToken}`);
  headers.set("x-podcast-csrf", csrfToken);
  return new Request(url, { ...init, headers });
}

async function feedStatus(env, token) {
  return (await servePrivateFeed(
    new Request(`https://feeds.staging.example/v1/private/${token}/${showSlug}/rss.xml`),
    env,
    token,
    showSlug
  )).status;
}

function addStripeOverlap(sqlite) {
  sqlite.prepare(
    `INSERT INTO subscription_entitlement_sources (
       id, listener_id, show_id, provider,
       provider_subscription_id, status, current_period_end
     ) VALUES (?, ?, ?, 'stripe', ?, 'active', ?)`
  ).run(
    "source_stripe_pool_overlap",
    listenerId,
    showId,
    "sub_pool_overlap",
    "2032-01-01T00:00:00.000Z"
  );
}

function poolSource(sqlite) {
  return sqlite.prepare(
    `SELECT provider_subscription_id, status, current_period_end
     FROM subscription_entitlement_sources
     WHERE listener_id = ? AND show_id = ? AND provider = 'pool'`
  ).get(listenerId, showId);
}

function projection(sqlite) {
  return sqlite.prepare(
    `SELECT provider, status, current_period_end
     FROM subscriptions
     WHERE listener_id = ? AND show_id = ?`
  ).get(listenerId, showId);
}

function feedToken(url) {
  return new URL(url).pathname.split("/")[3];
}

function activeFeedTokens(sqlite) {
  return sqlite.prepare(
    `SELECT COUNT(*) AS count
     FROM private_feed_tokens
     WHERE listener_id = ? AND show_id = ? AND revoked_at IS NULL`
  ).get(listenerId, showId).count;
}

function feedTokenRows(sqlite) {
  return sqlite.prepare(
    `SELECT token_hash, revoked_at
     FROM private_feed_tokens
     WHERE listener_id = ? AND show_id = ?`
  ).all(listenerId, showId);
}
