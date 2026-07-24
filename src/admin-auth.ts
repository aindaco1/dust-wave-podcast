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
import { sendAdminMagicLink } from "./resend";
import { isTruthy } from "./validation";

export const ADMIN_SESSION_COOKIE = "dustwave_podcast_admin_session";
const LOGIN_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
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

export type AdminRole = "super_admin" | "admin" | "producer" | "analyst";

export interface AdminIdentity {
  id: string;
  roles: Array<{ role: AdminRole; showId: string | null }>;
}

export interface AdminAuthorization {
  identity: AdminIdentity;
  sessionTokenHash: string;
}

export function hasAdminRoleForShow(
  identity: AdminIdentity,
  allowedRoles?: AdminRole[],
  showId?: string | null
): boolean {
  return identity.roles.some(({ role, showId: roleShowId }) =>
    (!allowedRoles || allowedRoles.includes(role))
    && (
      role === "super_admin"
      || !showId
      || roleShowId === null
      || roleShowId === showId
    )
  );
}

function authConfigured(env: PodcastEnv): boolean {
  return Boolean(
    env.ADMIN_EMAIL_LOOKUP_PEPPER
    && env.ADMIN_SESSION_SECRET
    && env.RESEND_API_KEY
  );
}

function sessionCookie(token: string, maximumAge = SESSION_TTL_SECONDS): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/v1/admin",
    `Max-Age=${maximumAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function clearSessionCookie(): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/v1/admin",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

async function emailLookupHash(env: PodcastEnv, email: string): Promise<string> {
  return hmacSha256(email, env.ADMIN_EMAIL_LOOKUP_PEPPER || "", "hex");
}

export async function startAdminLogin(
  request: Request,
  env: PodcastEnv,
  body: Record<string, unknown>
): Promise<Response> {
  if (!authConfigured(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_auth_not_configured" },
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
      action: "podcast_admin_login",
      requiredEnvName: "ADMIN_TURNSTILE_REQUIRED"
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
  const clientHash = await passwordlessClientHash(
    request,
    env.ADMIN_SESSION_SECRET,
    "podcast-admin-auth-client"
  );
  const clientAllowed = await consumePasswordlessRateLimit(
    env.DB,
    "admin_auth_rate_limit_buckets",
    AUTH_RATE_LIMITS.startClient,
    clientHash
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
    "admin_auth_rate_limit_buckets",
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
  const admin = await env.DB
    .prepare(
      `SELECT id
       FROM admin_users
       WHERE email_lookup_hash = ? AND status IN ('invited', 'active')`
    )
    .bind(lookupHash)
    .first<{ id: string }>();

  let exposedLoginUrl: string | undefined;
  if (admin) {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${token}`);
    await env.DB
      .prepare(
        `INSERT INTO admin_login_tokens (
           token_hash, admin_user_id, expires_at
         ) VALUES (?, ?, datetime('now', '+15 minutes'))`
      )
      .bind(tokenHash, admin.id)
      .run();

    const language = normalizeLoginLanguage(body.preferredLanguage);
    const loginUrl = `${env.SITE_ORIGIN.replace(/\/$/, "")}/admin/podcasts/#magic-link=${token}`;
    const exposeLink = env.ENVIRONMENT === "staging"
      && isTruthy(env.ADMIN_AUTH_EXPOSE_LOGIN_LINK);
    if (exposeLink) {
      exposedLoginUrl = loginUrl;
    } else {
      const delivery = await sendAdminMagicLink(env, {
        email,
        loginUrl,
        language,
        deliveryKey: tokenHash
      });
      if (!delivery.sent) {
        console.error(JSON.stringify({
          level: "error",
          event: "admin_login_delivery_failed",
          adminUserId: admin.id
        }));
      }
    }
  }

  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { accepted: true, ...(exposedLoginUrl ? { loginUrl: exposedLoginUrl } : {}) },
    { status: 202 }
  );
}

export async function exchangeAdminLogin(
  request: Request,
  env: PodcastEnv,
  body: Record<string, unknown>
): Promise<Response> {
  if (!env.ADMIN_SESSION_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_auth_not_configured" },
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
    "admin_auth_rate_limit_buckets",
    AUTH_RATE_LIMITS.exchangeClient,
    await passwordlessClientHash(
      request,
      env.ADMIN_SESSION_SECRET,
      "podcast-admin-auth-client"
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
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "invalid_or_expired_token" },
      { status: 401 }
    );
  }
  const tokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${token}`);
  const consumed = await env.DB
    .prepare(
      `UPDATE admin_login_tokens
       SET consumed_at = datetime('now')
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND expires_at > datetime('now')
       RETURNING admin_user_id`
    )
    .bind(tokenHash)
    .first<{ admin_user_id: string }>();
  if (!consumed) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "invalid_or_expired_token" },
      { status: 401 }
    );
  }

  const sessionToken = randomToken(32);
  const csrfToken = randomToken(24);
  const sessionTokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${sessionToken}`);
  const csrfTokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${csrfToken}`);
  await env.DB
    .prepare(
      `INSERT INTO admin_sessions (
         token_hash, admin_user_id, csrf_token_hash, expires_at
       ) VALUES (?, ?, ?, datetime('now', '+8 hours'))`
    )
    .bind(sessionTokenHash, consumed.admin_user_id, csrfTokenHash)
    .run();
  await env.DB
    .prepare(
      `UPDATE admin_users
       SET
         status = 'active',
         activated_at = COALESCE(activated_at, datetime('now')),
         last_authenticated_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(consumed.admin_user_id)
    .run();

  const identity = await loadAdminIdentity(env.DB, consumed.admin_user_id);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      authenticated: true,
      identity,
      csrfToken,
      expiresInSeconds: SESSION_TTL_SECONDS
    },
    {
      headers: { "set-cookie": sessionCookie(sessionToken) }
    }
  );
}

async function loadAdminIdentity(
  db: D1Database,
  adminUserId: string
): Promise<AdminIdentity> {
  const roles = await db
    .prepare(
      `SELECT role, show_id
       FROM admin_user_roles
       WHERE admin_user_id = ?
       ORDER BY role, show_id`
    )
    .bind(adminUserId)
    .all<{ role: AdminRole; show_id: string | null }>();
  return {
    id: adminUserId,
    roles: roles.results.map(({ role, show_id }) => ({ role, showId: show_id }))
  };
}

export async function requireAdmin(
  request: Request,
  env: PodcastEnv,
  {
    allowedRoles,
    requireCsrf = false,
    showId
  }: {
    allowedRoles?: AdminRole[];
    requireCsrf?: boolean;
    showId?: string | null;
  } = {}
): Promise<{ ok: true; authorization: AdminAuthorization } | { ok: false; response: Response }> {
  const sessionToken = getCookie(request, ADMIN_SESSION_COOKIE);
  if (!sessionToken || !env.ADMIN_SESSION_SECRET) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "unauthorized" },
        { status: 401 }
      )
    };
  }
  const sessionTokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${sessionToken}`);
  const session = await env.DB
    .prepare(
      `SELECT s.admin_user_id, s.csrf_token_hash
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > datetime('now')
         AND u.status = 'active'`
    )
    .bind(sessionTokenHash)
    .first<{ admin_user_id: string; csrf_token_hash: string }>();
  if (!session) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "unauthorized" },
        { status: 401, headers: { "set-cookie": clearSessionCookie() } }
      )
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
    const csrfHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${csrfToken}`);
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

  const identity = await loadAdminIdentity(env.DB, session.admin_user_id);
  if (!hasAdminRoleForShow(identity, allowedRoles, showId)) {
    return {
      ok: false,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "forbidden" },
        { status: 403 }
      )
    };
  }

  await env.DB
    .prepare(
      `UPDATE admin_sessions
       SET last_seen_at = datetime('now')
       WHERE token_hash = ?
         AND last_seen_at < datetime('now', '-5 minutes')`
    )
    .bind(sessionTokenHash)
    .run();
  return {
    ok: true,
    authorization: { identity, sessionTokenHash }
  };
}

export async function pruneAdminAuthState(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM admin_auth_rate_limit_buckets
       WHERE expires_at <= datetime('now')`
    ),
    db.prepare(
      `DELETE FROM admin_login_tokens
       WHERE expires_at < datetime('now', '-1 day')
          OR consumed_at < datetime('now', '-1 day')`
    ),
    db.prepare(
      `DELETE FROM admin_sessions
       WHERE expires_at < datetime('now', '-1 day')
          OR revoked_at < datetime('now', '-1 day')`
    )
  ]);
}

export async function getAdminSession(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const csrfToken = randomToken(24);
  const csrfTokenHash = await sha256Hex(`${env.ADMIN_SESSION_SECRET}:${csrfToken}`);
  await env.DB
    .prepare(
      `UPDATE admin_sessions
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

export async function logoutAdmin(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  await env.DB
    .prepare(
      `UPDATE admin_sessions
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
