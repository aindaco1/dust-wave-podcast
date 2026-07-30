export async function consumeSubscriptionRateLimit(
  db: D1Database,
  limit: {
    action: string;
    windowSeconds: number;
    maximum: number;
  },
  identityHash: string
): Promise<boolean> {
  if (
    !/^[a-z0-9_]{1,64}$/.test(limit.action)
    || !Number.isSafeInteger(limit.windowSeconds)
    || limit.windowSeconds < 1
    || !Number.isSafeInteger(limit.maximum)
    || limit.maximum < 1
    || !/^[a-f0-9]{64}$/.test(identityHash)
  ) {
    throw new TypeError("Subscription rate-limit configuration is invalid");
  }
  const currentSeconds = Math.floor(Date.now() / 1_000);
  const windowStartedAt =
    Math.floor(currentSeconds / limit.windowSeconds) * limit.windowSeconds;
  const expiresAt = windowStartedAt + limit.windowSeconds * 2;
  const bucket = await db
    .prepare(
      `INSERT INTO subscription_billing_rate_limits (
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
