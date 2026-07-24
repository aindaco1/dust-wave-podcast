import {
  getCookie,
  hmacSha256,
  normalizeEmail,
  randomToken,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";
import { verifyTurnstile } from "@dustwave/worker-core/turnstile";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  consumePasswordlessRateLimit,
  isValidEmailAddress,
  normalizeLoginLanguage,
  passwordlessClientHash,
  trustedSiteOrigin
} from "./passwordless-security";
import { sendListenerMagicLink } from "./resend";
import { isTruthy } from "./validation";

export const LISTENER_SESSION_COOKIE =
  "dustwave_podcast_listener_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CSRF_HEADER = "x-podcast-csrf";
const AUTH_RATE_LIMITS = {
  startClient: { action: "start_client", windowSeconds: 15 * 60, maximum: 10 },
  startEmail: { action: "start_email", windowSeconds: 60 * 60, maximum: 5 },
  exchangeClient: {
    action: "exchange_client",
    windowSeconds: 15 * 60,
    maximum: 30
  }
} as const;

type SubscriptionRow = {
  subscription_id: string;
  provider: "stripe" | "pool" | "manual";
  status: "pending" | "active" | "past_due" | "paused" | "canceled" | "expired";
  current_period_end: string | null;
  show_id: string;
  show_slug: string;
  show_title: string;
  billing_period: "month" | "year" | null;
  entitled: number;
  has_private_feed: number;
};

export interface ListenerIdentity {
  id: string;
  subscriptions: Array<{
    id: string;
    provider: SubscriptionRow["provider"];
    status: SubscriptionRow["status"];
    currentPeriodEnd: string | null;
    billingPeriod: SubscriptionRow["billing_period"];
    entitled: boolean;
    hasPrivateFeed: boolean;
    show: {
      id: string;
      slug: string;
      title: string;
    };
  }>;
}

export interface ListenerAuthorization {
  identity: ListenerIdentity;
  sessionTokenHash: string;
}

function authConfigured(env: PodcastEnv): boolean {
  return Boolean(
    env.LISTENER_EMAIL_LOOKUP_PEPPER
    && env.LISTENER_SESSION_SECRET
    && env.RESEND_API_KEY
  );
}

function sessionCookie(token: string, maximumAge = SESSION_TTL_SECONDS): string {
  return [
    `${LISTENER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/v1/member",
    `Max-Age=${maximumAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function clearSessionCookie(): string {
  return [
    `${LISTENER_SESSION_COOKIE}=`,
    "Path=/v1/member",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

async function emailLookupHash(
  env: PodcastEnv,
  email: string
): Promise<string> {
  return hmacSha256(
    email,
    env.LISTENER_EMAIL_LOOKUP_PEPPER || "",
    "hex"
  );
}

export async function startListenerLogin(
  request: Request,
  env: PodcastEnv,
  body: Record<string, unknown>
): Promise<Response> {
  if (!authConfigured(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "listener_auth_not_configured" },
      { status: 503 }
    );
  }
  if (!trustedSiteOrigin(request, env.SITE_ORIGIN)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "origin_not_allowed" },
      { status: 403 }
    );
  }
  const challenge = await verifyTurnstile(
    request,
    env,
    String(body.turnstileToken ?? request.headers.get("x-turnstile-token") ?? ""),
    {
      action: "podcast_listener_login",
      requiredEnvName: "LISTENER_TURNSTILE_REQUIRED"
    }
  );
  if (!challenge.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: challenge.code },
      { status: challenge.status }
    );
  }

  const email = normalizeEmail(body.email);
  const clientAllowed = await consumePasswordlessRateLimit(
    env.DB,
    "listener_auth_rate_limit_buckets",
    AUTH_RATE_LIMITS.startClient,
    await passwordlessClientHash(
      request,
      env.LISTENER_SESSION_SECRET || "",
      "podcast-listener-auth-client"
    )
  );
  if (!isValidEmailAddress(email)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { accepted: true },
      { status: 202 }
    );
  }
  const lookupHash = await emailLookupHash(env, email);
  const emailAllowed = await consumePasswordlessRateLimit(
    env.DB,
    "listener_auth_rate_limit_buckets",
    AUTH_RATE_LIMITS.startEmail,
    lookupHash
  );
  if (!clientAllowed || !emailAllowed) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { accepted: true },
      { status: 202, headers: { "retry-after": "900" } }
    );
  }
  const listener = await env.DB
    .prepare(
      `SELECT id
       FROM listener_accounts
       WHERE email_lookup_hash = ?`
    )
    .bind(lookupHash)
    .first<{ id: string }>();

  let exposedLoginUrl: string | undefined;
  if (listener) {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(
      `${env.LISTENER_SESSION_SECRET}:${token}`
    );
    await env.DB
      .prepare(
        `INSERT INTO listener_login_tokens (
           token_hash, listener_id, expires_at
         ) VALUES (?, ?, datetime('now', '+15 minutes'))`
      )
      .bind(tokenHash, listener.id)
      .run();
    const language = normalizeLoginLanguage(body.preferredLanguage);
    const loginUrl = `${
      env.SITE_ORIGIN.replace(/\/$/, "")
    }/podcasts/account/#magic-link=${token}`;
    const exposeLink = env.ENVIRONMENT === "staging"
      && isTruthy(env.LISTENER_AUTH_EXPOSE_LOGIN_LINK);
    if (exposeLink) {
      exposedLoginUrl = loginUrl;
    } else {
      const delivery = await sendListenerMagicLink(env, {
        email,
        loginUrl,
        language,
        deliveryKey: tokenHash
      });
      if (!delivery.sent) {
        console.error(JSON.stringify({
          level: "error",
          event: "listener_login_delivery_failed",
          listenerId: listener.id
        }));
      }
    }
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      accepted: true,
      ...(exposedLoginUrl ? { loginUrl: exposedLoginUrl } : {})
    },
    { status: 202 }
  );
}

export async function exchangeListenerLogin(
  request: Request,
  env: PodcastEnv,
  body: Record<string, unknown>
): Promise<Response> {
  if (!env.LISTENER_SESSION_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "listener_auth_not_configured" },
      { status: 503 }
    );
  }
  if (!trustedSiteOrigin(request, env.SITE_ORIGIN)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "origin_not_allowed" },
      { status: 403 }
    );
  }
  const clientAllowed = await consumePasswordlessRateLimit(
    env.DB,
    "listener_auth_rate_limit_buckets",
    AUTH_RATE_LIMITS.exchangeClient,
    await passwordlessClientHash(
      request,
      env.LISTENER_SESSION_SECRET,
      "podcast-listener-auth-client"
    )
  );
  if (!clientAllowed) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": "900" } }
    );
  }
  const token = String(body.token ?? "").trim();
  if (!token || token.length > 256) {
    return invalidTokenResponse(request, env);
  }
  const tokenHash = await sha256Hex(
    `${env.LISTENER_SESSION_SECRET}:${token}`
  );
  const consumed = await env.DB
    .prepare(
      `UPDATE listener_login_tokens
       SET consumed_at = datetime('now')
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND expires_at > datetime('now')
       RETURNING listener_id`
    )
    .bind(tokenHash)
    .first<{ listener_id: string }>();
  if (!consumed) return invalidTokenResponse(request, env);

  const sessionToken = randomToken(32);
  const csrfToken = randomToken(24);
  const sessionTokenHash = await sha256Hex(
    `${env.LISTENER_SESSION_SECRET}:${sessionToken}`
  );
  const csrfTokenHash = await sha256Hex(
    `${env.LISTENER_SESSION_SECRET}:${csrfToken}`
  );
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO listener_sessions (
           token_hash, listener_id, csrf_token_hash, expires_at
         ) VALUES (?, ?, ?, datetime('now', '+30 days'))`
      )
      .bind(
        sessionTokenHash,
        consumed.listener_id,
        csrfTokenHash
      ),
    env.DB
      .prepare(
        `UPDATE listener_accounts
         SET
           email_verified_at = COALESCE(
             email_verified_at,
             datetime('now')
           ),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(consumed.listener_id)
  ]);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      authenticated: true,
      identity: await loadListenerIdentity(env.DB, consumed.listener_id),
      csrfToken,
      expiresInSeconds: SESSION_TTL_SECONDS
    },
    { headers: { "set-cookie": sessionCookie(sessionToken) } }
  );
}

export async function requireListener(
  request: Request,
  env: PodcastEnv,
  { requireCsrf = false }: { requireCsrf?: boolean } = {}
): Promise<
  | { ok: true; authorization: ListenerAuthorization }
  | { ok: false; response: Response }
> {
  const sessionToken = getCookie(request, LISTENER_SESSION_COOKIE);
  if (!sessionToken || !env.LISTENER_SESSION_SECRET) {
    return {
      ok: false,
      response: unauthorizedResponse(request, env)
    };
  }
  const sessionTokenHash = await sha256Hex(
    `${env.LISTENER_SESSION_SECRET}:${sessionToken}`
  );
  const session = await env.DB
    .prepare(
      `SELECT listener_id, csrf_token_hash
       FROM listener_sessions
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > datetime('now')`
    )
    .bind(sessionTokenHash)
    .first<{ listener_id: string; csrf_token_hash: string }>();
  if (!session) {
    return {
      ok: false,
      response: unauthorizedResponse(request, env, clearSessionCookie())
    };
  }
  if (requireCsrf) {
    if (!trustedSiteOrigin(request, env.SITE_ORIGIN)) {
      return {
        ok: false,
        response: privateJson(
          request,
          env.ALLOWED_ORIGINS,
          { error: "origin_not_allowed" },
          { status: 403 }
        )
      };
    }
    const csrfToken = request.headers.get(CSRF_HEADER) ?? "";
    const csrfHash = await sha256Hex(
      `${env.LISTENER_SESSION_SECRET}:${csrfToken}`
    );
    if (!timingSafeEqual(csrfHash, session.csrf_token_hash)) {
      return {
        ok: false,
        response: privateJson(
          request,
          env.ALLOWED_ORIGINS,
          { error: "invalid_csrf_token" },
          { status: 403 }
        )
      };
    }
  }
  await env.DB
    .prepare(
      `UPDATE listener_sessions
       SET last_seen_at = datetime('now')
       WHERE token_hash = ?
         AND last_seen_at < datetime('now', '-5 minutes')`
    )
    .bind(sessionTokenHash)
    .run();
  return {
    ok: true,
    authorization: {
      identity: await loadListenerIdentity(env.DB, session.listener_id),
      sessionTokenHash
    }
  };
}

export async function getListenerSession(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireListener(request, env);
  if (!auth.ok) return auth.response;
  const csrfToken = randomToken(24);
  const csrfTokenHash = await sha256Hex(
    `${env.LISTENER_SESSION_SECRET}:${csrfToken}`
  );
  await env.DB
    .prepare(
      `UPDATE listener_sessions
       SET csrf_token_hash = ?, last_seen_at = datetime('now')
       WHERE token_hash = ?`
    )
    .bind(csrfTokenHash, auth.authorization.sessionTokenHash)
    .run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    authenticated: true,
    identity: auth.authorization.identity,
    csrfToken,
    expiresInSeconds: SESSION_TTL_SECONDS
  });
}

export async function logoutListener(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireListener(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  await env.DB
    .prepare(
      `UPDATE listener_sessions
       SET revoked_at = datetime('now')
       WHERE token_hash = ?`
    )
    .bind(auth.authorization.sessionTokenHash)
    .run();
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { authenticated: false },
    { headers: { "set-cookie": clearSessionCookie() } }
  );
}

export async function pruneListenerAuthState(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM listener_auth_rate_limit_buckets
       WHERE expires_at <= datetime('now')`
    ),
    db.prepare(
      `DELETE FROM listener_login_tokens
       WHERE expires_at < datetime('now', '-1 day')
          OR consumed_at < datetime('now', '-1 day')`
    ),
    db.prepare(
      `DELETE FROM listener_sessions
       WHERE expires_at < datetime('now', '-1 day')
          OR revoked_at < datetime('now', '-1 day')`
    )
  ]);
}

async function loadListenerIdentity(
  db: D1Database,
  listenerId: string
): Promise<ListenerIdentity> {
  const subscriptions = await db
    .prepare(
      `SELECT
         s.id AS subscription_id,
         s.provider,
         s.status,
         s.current_period_end,
         sh.id AS show_id,
         sh.slug AS show_slug,
         sh.title AS show_title,
         p.billing_period,
         (
           s.status = 'active'
           AND (
             s.current_period_end IS NULL
             OR s.current_period_end > datetime('now')
           )
         ) AS entitled,
         EXISTS (
           SELECT 1
           FROM private_feed_tokens f
           WHERE
             f.listener_id = s.listener_id
             AND f.show_id = s.show_id
             AND f.revoked_at IS NULL
         ) AS has_private_feed
       FROM subscriptions s
       JOIN shows sh ON sh.id = s.show_id
       LEFT JOIN show_prices p ON p.id = s.price_id
       WHERE s.listener_id = ?
       ORDER BY sh.title, s.created_at`
    )
    .bind(listenerId)
    .all<SubscriptionRow>();
  return {
    id: listenerId,
    subscriptions: subscriptions.results.map((subscription) => ({
      id: subscription.subscription_id,
      provider: subscription.provider,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      billingPeriod: subscription.billing_period,
      entitled: subscription.entitled === 1,
      hasPrivateFeed: subscription.has_private_feed === 1,
      show: {
        id: subscription.show_id,
        slug: subscription.show_slug,
        title: subscription.show_title
      }
    }))
  };
}

function invalidTokenResponse(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "invalid_or_expired_token" },
    { status: 401 }
  );
}

function unauthorizedResponse(
  request: Request,
  env: PodcastEnv,
  cookie?: string
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "unauthorized" },
    {
      status: 401,
      ...(cookie ? { headers: { "set-cookie": cookie } } : {})
    }
  );
}
