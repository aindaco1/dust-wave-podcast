import {
  hmacSha256,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

export type LoginLanguage = "en" | "es";

type PasswordlessRateLimitTable =
  | "admin_auth_rate_limit_buckets"
  | "listener_auth_rate_limit_buckets";

export function normalizeLoginLanguage(value: unknown): LoginLanguage {
  return String(value ?? "").trim().toLowerCase() === "es" ? "es" : "en";
}

export function isValidEmailAddress(value: string): boolean {
  return value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function trustedSiteOrigin(
  request: Request,
  siteOrigin: string
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return timingSafeEqual(
      new URL(origin).origin,
      new URL(siteOrigin).origin
    );
  } catch {
    return false;
  }
}

export async function passwordlessClientHash(
  request: Request,
  secret: string,
  namespace: string
): Promise<string> {
  const clientAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
  return hmacSha256(
    `${namespace}:${clientAddress}`,
    secret,
    "hex"
  );
}

export async function consumePasswordlessRateLimit(
  db: D1Database,
  table: PasswordlessRateLimitTable,
  limit: {
    action: string;
    windowSeconds: number;
    maximum: number;
  },
  identityHash: string
): Promise<boolean> {
  if (
    !Number.isSafeInteger(limit.windowSeconds)
    || limit.windowSeconds < 60
    || !Number.isSafeInteger(limit.maximum)
    || limit.maximum < 1
  ) {
    throw new RangeError("Invalid passwordless rate-limit policy");
  }
  const tableName = table === "admin_auth_rate_limit_buckets"
    ? "admin_auth_rate_limit_buckets"
    : "listener_auth_rate_limit_buckets";
  const currentSeconds = Math.floor(Date.now() / 1_000);
  const windowStartedAt =
    Math.floor(currentSeconds / limit.windowSeconds) * limit.windowSeconds;
  const expiresAt = windowStartedAt + limit.windowSeconds * 2;
  const bucket = await db
    .prepare(
      `INSERT INTO ${tableName} (
         action, identity_hash, window_started_at, attempt_count, expires_at
       ) VALUES (?, ?, ?, 1, datetime(?, 'unixepoch'))
       ON CONFLICT (action, identity_hash, window_started_at)
       DO UPDATE SET attempt_count = attempt_count + 1
       WHERE attempt_count <= ${limit.maximum}
       RETURNING attempt_count`
    )
    .bind(limit.action, identityHash, windowStartedAt, expiresAt)
    .first<{ attempt_count: number }>();
  return Boolean(
    bucket
    && Number.isInteger(bucket.attempt_count)
    && bucket.attempt_count <= limit.maximum
  );
}
