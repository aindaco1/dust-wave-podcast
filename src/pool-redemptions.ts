import {
  hmacSha256,
  normalizeEmail,
  randomToken,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";
import {
  normalizePodcastBenefitCode
} from "@dustwave/worker-core/podcast-benefits";

import { recomputeSubscriptionProjection } from "./billing";
import type { PodcastEnv } from "./env";
import { poolRedemptionConfigured } from "./feature-config";
import { privateJson } from "./http";
import { requireListener } from "./listener-auth";
import { isValidEmailAddress } from "./passwordless-security";
import { readSignedJsonBody } from "./signed-callback";
import { consumeSubscriptionRateLimit } from "./subscription-rate-limits";
import {
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  validDateTime,
  validIdentifier,
  validSlug
} from "./validation";

const BRIDGE_MAXIMUM_BODY_BYTES = 8_192;
const REDEMPTION_SESSION_LIMIT = {
  action: "pool_redemption_session",
  windowSeconds: 60 * 60,
  maximum: 10
} as const;
const REDEMPTION_CODE_LIMIT = {
  action: "pool_redemption_code",
  windowSeconds: 24 * 60 * 60,
  maximum: 10
} as const;

type GrantEventRow = {
  event_id: string;
  provider_grant_id: string;
  action: "grant" | "revoke";
  body_sha256: string;
  status: "received" | "processed" | "failed";
};

type PoolCodeRow = {
  id: string;
  show_id: string;
  show_slug: string;
  show_title: string;
  provider_grant_id: string;
  recipient_email_lookup_hash: string;
  listener_email_lookup_hash: string;
  duration_days: number | null;
  status: "active" | "revoked";
  expires_at: string | null;
};

export async function handlePoolGrantEvent(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!poolRedemptionConfigured(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "not_found" },
      { status: 404 }
    );
  }
  const signed = await readSignedJsonBody(request, {
    secret: env.POOL_PODCAST_BRIDGE_SECRET,
    timestampHeader: "x-pool-podcast-timestamp",
    signatureHeader: "x-pool-podcast-signature",
    maximumBytes: BRIDGE_MAXIMUM_BODY_BYTES,
    bodyName: "Pool grant event",
    invalidBodyCode: "invalid_pool_grant_event"
  });
  if (!signed.ok) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: signed.reason === "secret_missing"
          ? "not_found"
          : "invalid_pool_grant_signature"
      },
      { status: signed.reason === "secret_missing" ? 404 : 401 }
    );
  }

  const eventId = validIdentifier(signed.body.eventId, "eventId");
  const grantId = validIdentifier(signed.body.grantId, "grantId");
  const action = validGrantAction(signed.body.action);
  const bodyDigest = await sha256Hex(JSON.stringify(signed.body));
  const existingEvent = await findGrantEvent(env.DB, eventId);
  if (existingEvent) {
    if (
      existingEvent.provider_grant_id !== grantId
      || existingEvent.action !== action
      || !timingSafeEqual(existingEvent.body_sha256, bodyDigest)
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "pool_grant_event_conflict" },
        { status: 409 }
      );
    }
    if (existingEvent.status === "processed") {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        accepted: true,
        action,
        idempotent: true
      });
    }
  } else {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO pool_grant_events (
           event_id, provider_grant_id, action, body_sha256
         ) VALUES (?, ?, ?, ?)`
      )
      .bind(eventId, grantId, action, bodyDigest)
      .run();
    const racedEvent = await findGrantEvent(env.DB, eventId);
    if (
      !racedEvent
      || racedEvent.provider_grant_id !== grantId
      || racedEvent.action !== action
      || !timingSafeEqual(racedEvent.body_sha256, bodyDigest)
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "pool_grant_event_conflict" },
        { status: 409 }
      );
    }
    if (racedEvent.status === "processed") {
      return privateJson(request, env.ALLOWED_ORIGINS, {
        accepted: true,
        action,
        idempotent: true
      });
    }
  }

  return action === "grant"
    ? applyPoolGrant(request, env, signed.body, eventId, grantId)
    : applyPoolRevocation(request, env, eventId, grantId);
}

export async function redeemPoolCode(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireListener(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  if (!poolRedemptionConfigured(env)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "pool_redemption_not_configured" },
      { status: 503 }
    );
  }
  if (!await consumeSubscriptionRateLimit(
    env.DB,
    REDEMPTION_SESSION_LIMIT,
    auth.authorization.sessionTokenHash
  )) {
    return rateLimitedResponse(request, env);
  }
  const body = await readJsonObject(request, 4_096);
  const code = validPoolCode(body.code);
  const codeHash = await hmacSha256(
    code,
    env.POOL_REDEMPTION_CODE_PEPPER as string,
    "hex"
  );
  if (!await consumeSubscriptionRateLimit(
    env.DB,
    REDEMPTION_CODE_LIMIT,
    codeHash
  )) {
    return rateLimitedResponse(request, env);
  }

  const codeRow = await env.DB
    .prepare(
      `SELECT
         c.id, c.show_id, sh.slug AS show_slug, sh.title AS show_title,
         c.provider_grant_id, c.recipient_email_lookup_hash,
         l.email_lookup_hash AS listener_email_lookup_hash,
         c.duration_days, c.status, c.expires_at
       FROM redemption_codes c
       JOIN shows sh ON sh.id = c.show_id
       JOIN listener_accounts l ON l.id = ?
       WHERE
         c.code_hash = ?
         AND c.source = 'pool'
         AND sh.test_fixture = 0
       LIMIT 1`
    )
    .bind(auth.authorization.identity.id, codeHash)
    .first<PoolCodeRow>();
  if (!poolCodeAvailable(codeRow)) {
    return unavailableCodeResponse(request, env);
  }

  const existing = await env.DB
    .prepare(
      `SELECT id
       FROM redemptions
       WHERE code_id = ? AND listener_id = ?`
    )
    .bind(codeRow.id, auth.authorization.identity.id)
    .first<{ id: string }>();
  if (existing) {
    await recomputeSubscriptionProjection(
      env.DB,
      auth.authorization.identity.id,
      codeRow.show_id
    );
    return poolRedemptionResponse(
      request,
      env,
      codeRow,
      auth.authorization.identity.id,
      true
    );
  }

  const existingSource = await env.DB
    .prepare(
      `SELECT status, current_period_end
       FROM subscription_entitlement_sources
       WHERE listener_id = ? AND show_id = ? AND provider = 'pool'`
    )
    .bind(auth.authorization.identity.id, codeRow.show_id)
    .first<{
      status: string;
      current_period_end: string | null;
    }>();
  const currentPeriodEnd = extendedPeriodEnd(
    codeRow.duration_days,
    existingSource
  );
  const redemptionId = `redemption_${randomToken(16)}`;
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO redemptions (
             id, code_id, listener_id
           ) VALUES (?, ?, ?)`
        )
        .bind(
          redemptionId,
          codeRow.id,
          auth.authorization.identity.id
        ),
      env.DB
        .prepare(
          `INSERT INTO subscription_entitlement_sources (
             id, listener_id, show_id, provider,
             provider_subscription_id, status, current_period_end
           ) VALUES (?, ?, ?, 'pool', ?, 'active', ?)
           ON CONFLICT (listener_id, show_id, provider)
           DO UPDATE SET
             provider_subscription_id = excluded.provider_subscription_id,
             status = 'active',
             current_period_end = excluded.current_period_end,
             canceled_at = NULL,
             updated_at = datetime('now')`
        )
        .bind(
          `source_${randomToken(16)}`,
          auth.authorization.identity.id,
          codeRow.show_id,
          codeRow.provider_grant_id,
          currentPeriodEnd
        )
    ]);
  } catch {
    const raced = await env.DB
      .prepare(
        `SELECT id
         FROM redemptions
         WHERE code_id = ? AND listener_id = ?`
      )
      .bind(codeRow.id, auth.authorization.identity.id)
      .first<{ id: string }>();
    if (!raced) return unavailableCodeResponse(request, env);
  }

  await recomputeSubscriptionProjection(
    env.DB,
    auth.authorization.identity.id,
    codeRow.show_id
  );
  await env.DB
    .prepare(
      `UPDATE redemptions
       SET subscription_id = (
         SELECT id
         FROM subscriptions
         WHERE listener_id = ? AND show_id = ?
       )
       WHERE code_id = ? AND listener_id = ?`
    )
    .bind(
      auth.authorization.identity.id,
      codeRow.show_id,
      codeRow.id,
      auth.authorization.identity.id
    )
    .run();
  return poolRedemptionResponse(
    request,
    env,
    codeRow,
    auth.authorization.identity.id,
    false
  );
}

async function applyPoolGrant(
  request: Request,
  env: PodcastEnv,
  body: Record<string, unknown>,
  eventId: string,
  grantId: string
): Promise<Response> {
  const showSlug = validSlug(body.showSlug, "showSlug");
  const email = normalizeEmail(body.email);
  if (!isValidEmailAddress(email)) {
    throw new RequestValidationError("email is invalid");
  }
  const code = validPoolCode(body.code);
  const durationDays = body.durationDays === null
    || body.durationDays === undefined
    ? null
    : positiveInteger(body.durationDays, "durationDays", 3_660);
  const redeemBy = validDateTime(body.redeemBy, "redeemBy");
  if (
    redeemBy
    && (
      Date.parse(redeemBy) <= Date.now()
      || Date.parse(redeemBy) > Date.now() + 5 * 366 * 24 * 60 * 60 * 1_000
    )
  ) {
    throw new RequestValidationError(
      "redeemBy must be in the next five years"
    );
  }
  const show = await env.DB
    .prepare(
      `SELECT id
       FROM shows
       WHERE slug = ?
         AND status != 'archived'
         AND premium_enabled = 1
         AND test_fixture = 0`
    )
    .bind(showSlug)
    .first<{ id: string }>();
  if (!show) {
    await failGrantEvent(env.DB, eventId, "pool_show_not_available");
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "pool_show_not_available" },
      { status: 409 }
    );
  }
  const [codeHash, emailHash] = await Promise.all([
    hmacSha256(
      code,
      env.POOL_REDEMPTION_CODE_PEPPER as string,
      "hex"
    ),
    hmacSha256(
      email,
      env.LISTENER_EMAIL_LOOKUP_PEPPER as string,
      "hex"
    )
  ]);
  const revoked = await env.DB
    .prepare(
      `SELECT event_id
       FROM pool_grant_events
       WHERE
         provider_grant_id = ?
         AND action = 'revoke'
         AND status = 'processed'
       LIMIT 1`
    )
    .bind(grantId)
    .first<{ event_id: string }>();
  if (revoked) {
    await completeGrantEvent(env.DB, eventId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      accepted: true,
      action: "grant",
      status: "revoked",
      idempotent: true
    });
  }
  const existing = await env.DB
    .prepare(
      `SELECT
         id, show_id, code_hash, recipient_email_lookup_hash,
         duration_days, expires_at, status
       FROM redemption_codes
       WHERE source = 'pool' AND provider_grant_id = ?`
    )
    .bind(grantId)
    .first<{
      id: string;
      show_id: string;
      code_hash: string;
      recipient_email_lookup_hash: string;
      duration_days: number | null;
      expires_at: string | null;
      status: "active" | "revoked";
    }>();
  if (existing) {
    const matches = existing.show_id === show.id
      && timingSafeEqual(existing.code_hash, codeHash)
      && timingSafeEqual(existing.recipient_email_lookup_hash, emailHash)
      && existing.duration_days === durationDays
      && existing.expires_at === redeemBy;
    if (!matches) {
      await failGrantEvent(env.DB, eventId, "pool_grant_conflict");
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "pool_grant_conflict" },
        { status: 409 }
      );
    }
    await completeGrantEvent(env.DB, eventId);
    return privateJson(request, env.ALLOWED_ORIGINS, {
      accepted: true,
      action: "grant",
      status: existing.status,
      idempotent: true
    });
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO redemption_codes (
           id, code_hash, show_id, source, duration_days,
           max_redemptions, expires_at, provider_grant_id,
           recipient_email_lookup_hash, status, updated_at
         ) VALUES (?, ?, ?, 'pool', ?, 1, ?, ?, ?, 'active', datetime('now'))`
      )
      .bind(
        `code_${randomToken(16)}`,
        codeHash,
        show.id,
        durationDays,
        redeemBy,
        grantId,
        emailHash
      ),
    completedEventStatement(env.DB, eventId)
  ]);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      accepted: true,
      action: "grant",
      status: "active",
      idempotent: false
    },
    { status: 201 }
  );
}

async function applyPoolRevocation(
  request: Request,
  env: PodcastEnv,
  eventId: string,
  grantId: string
): Promise<Response> {
  const grant = await env.DB
    .prepare(
      `SELECT c.id, c.show_id, r.listener_id
       FROM redemption_codes c
       LEFT JOIN redemptions r ON r.code_id = c.id
       WHERE c.source = 'pool' AND c.provider_grant_id = ?
       LIMIT 1`
    )
    .bind(grantId)
    .first<{
      id: string;
      show_id: string;
      listener_id: string | null;
    }>();
  const statements: D1PreparedStatement[] = [];
  if (grant) {
    statements.push(
      env.DB
        .prepare(
          `UPDATE redemption_codes
           SET
             status = 'revoked',
             revoked_at = COALESCE(revoked_at, datetime('now')),
             updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(grant.id)
    );
    if (grant.listener_id) {
      statements.push(
        env.DB
          .prepare(
            `UPDATE subscription_entitlement_sources
             SET
               status = 'canceled',
               canceled_at = COALESCE(canceled_at, datetime('now')),
               updated_at = datetime('now')
             WHERE
               listener_id = ?
               AND show_id = ?
               AND provider = 'pool'
               AND provider_subscription_id = ?`
          )
          .bind(grant.listener_id, grant.show_id, grantId)
      );
    }
  }
  statements.push(completedEventStatement(env.DB, eventId));
  await env.DB.batch(statements);
  if (grant?.listener_id) {
    await recomputeSubscriptionProjection(
      env.DB,
      grant.listener_id,
      grant.show_id
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    accepted: true,
    action: "revoke",
    status: "revoked",
    idempotent: !grant
  });
}

async function poolRedemptionResponse(
  request: Request,
  env: PodcastEnv,
  code: PoolCodeRow,
  listenerId: string,
  idempotent: boolean
): Promise<Response> {
  const subscription = await env.DB
    .prepare(
      `SELECT status, current_period_end
       FROM subscriptions
       WHERE listener_id = ? AND show_id = ?`
    )
    .bind(listenerId, code.show_id)
    .first<{
      status: string;
      current_period_end: string | null;
    }>();
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      redemption: {
        show: {
          slug: code.show_slug,
          title: code.show_title
        },
        status: subscription?.status ?? "active",
        currentPeriodEnd: subscription?.current_period_end ?? null
      },
      idempotent
    },
    { status: idempotent ? 200 : 201 }
  );
}

function poolCodeAvailable(code: PoolCodeRow | null): code is PoolCodeRow {
  return Boolean(
    code
    && code.status === "active"
    && code.provider_grant_id
    && timingSafeEqual(
      code.recipient_email_lookup_hash,
      code.listener_email_lookup_hash
    )
    && (
      code.expires_at === null
      || Date.parse(code.expires_at) > Date.now()
    )
  );
}

function extendedPeriodEnd(
  durationDays: number | null,
  existing: {
    status: string;
    current_period_end: string | null;
  } | null
): string | null {
  if (
    durationDays === null
    || (
      existing?.status === "active"
      && existing.current_period_end === null
    )
  ) {
    return null;
  }
  const currentEnd = Date.parse(existing?.current_period_end ?? "");
  const base = Number.isFinite(currentEnd) && currentEnd > Date.now()
    ? currentEnd
    : Date.now();
  return new Date(base + durationDays * 24 * 60 * 60 * 1_000).toISOString();
}

async function findGrantEvent(
  db: D1Database,
  eventId: string
): Promise<GrantEventRow | null> {
  return db
    .prepare(
      `SELECT
         event_id, provider_grant_id, action, body_sha256, status
       FROM pool_grant_events
       WHERE event_id = ?`
    )
    .bind(eventId)
    .first<GrantEventRow>();
}

async function completeGrantEvent(
  db: D1Database,
  eventId: string
): Promise<void> {
  await completedEventStatement(db, eventId).run();
}

function completedEventStatement(
  db: D1Database,
  eventId: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pool_grant_events
       SET
         status = 'processed',
         failure_code = NULL,
         processed_at = COALESCE(processed_at, datetime('now')),
         updated_at = datetime('now')
       WHERE event_id = ?`
    )
    .bind(eventId);
}

async function failGrantEvent(
  db: D1Database,
  eventId: string,
  failureCode: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE pool_grant_events
       SET
         status = 'failed',
         failure_code = ?,
         updated_at = datetime('now')
       WHERE event_id = ?`
    )
    .bind(failureCode, eventId)
    .run();
}

function validGrantAction(value: unknown): "grant" | "revoke" {
  if (value === "grant" || value === "revoke") return value;
  throw new RequestValidationError("action must be grant or revoke");
}

function validPoolCode(value: unknown): string {
  try {
    return normalizePodcastBenefitCode(value);
  } catch {
    throw new RequestValidationError(
      "code is invalid",
      "invalid_redemption_code"
    );
  }
}

function unavailableCodeResponse(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "redemption_code_not_available" },
    { status: 404 }
  );
}

function rateLimitedResponse(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "rate_limited" },
    { status: 429, headers: { "retry-after": "3600" } }
  );
}
