import {
  hmacSha256,
  randomToken
} from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  type ListenerIdentity,
  requireListener
} from "./listener-auth";

export async function createListenerPrivateFeed(
  request: Request,
  env: PodcastEnv,
  showSlug: string
): Promise<Response> {
  return issueListenerPrivateFeed(request, env, showSlug, false);
}

export async function rotateListenerPrivateFeed(
  request: Request,
  env: PodcastEnv,
  showSlug: string
): Promise<Response> {
  return issueListenerPrivateFeed(request, env, showSlug, true);
}

export async function hashPrivateFeedToken(
  rawToken: string,
  secret: string
): Promise<string> {
  return hmacSha256(
    `podcast-private-feed:${rawToken}`,
    secret,
    "hex"
  );
}

export async function touchPrivateFeedToken(
  db: D1Database,
  tokenHash: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE private_feed_tokens
       SET last_used_at = datetime('now')
       WHERE token_hash = ?
         AND (
           last_used_at IS NULL
           OR last_used_at < datetime('now', '-1 hour')
         )`
    )
    .bind(tokenHash)
    .run();
}

export function privateFeedTokenNeedsTouch(
  lastUsedAt: string | null,
  now = Date.now()
): boolean {
  if (!lastUsedAt) return true;
  const timestamp = Date.parse(
    /[zZ]|[+-]\d\d:\d\d$/.test(lastUsedAt)
      ? lastUsedAt
      : `${lastUsedAt.replace(" ", "T")}Z`
  );
  return !Number.isFinite(timestamp) || timestamp <= now - 60 * 60 * 1_000;
}

function activeSubscriptionForShow(
  identity: ListenerIdentity,
  showSlug: string
): ListenerIdentity["subscriptions"][number] | undefined {
  return identity.subscriptions.find((subscription) =>
    subscription.show.slug === showSlug && subscription.entitled
  );
}

async function issueListenerPrivateFeed(
  request: Request,
  env: PodcastEnv,
  showSlug: string,
  rotate: boolean
): Promise<Response> {
  const auth = await requireListener(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  if (!env.FEED_TOKEN_PEPPER) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "private_feed_not_configured" },
      { status: 503 }
    );
  }
  const subscription = activeSubscriptionForShow(
    auth.authorization.identity,
    showSlug
  );
  if (!subscription) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "premium_entitlement_required" },
      { status: 403 }
    );
  }
  if (!rotate && subscription.hasPrivateFeed) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "private_feed_already_exists" },
      { status: 409 }
    );
  }

  const token = randomToken(32);
  const tokenHash = await hashPrivateFeedToken(token, env.FEED_TOKEN_PEPPER);
  const tokenId = `feed_${randomToken(16)}`;
  const insert = env.DB
    .prepare(
      `INSERT INTO private_feed_tokens (
         id, listener_id, show_id, token_hash
       ) VALUES (?, ?, ?, ?)`
    )
    .bind(
      tokenId,
      auth.authorization.identity.id,
      subscription.show.id,
      tokenHash
    );
  try {
    if (rotate) {
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE private_feed_tokens
             SET revoked_at = datetime('now')
             WHERE listener_id = ?
               AND show_id = ?
               AND revoked_at IS NULL`
          )
          .bind(
            auth.authorization.identity.id,
            subscription.show.id
          ),
        insert
      ]);
    } else {
      await insert.run();
    }
  } catch {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "private_feed_conflict" },
      { status: 409 }
    );
  }
  const feedUrl = `${
    env.FEED_ORIGIN.replace(/\/$/, "")
  }/v1/private/${token}/${showSlug}/rss.xml`;
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      feed: {
        show: subscription.show,
        url: feedUrl,
        rotated: rotate,
        shownOnce: true
      }
    },
    { status: rotate ? 200 : 201 }
  );
}
