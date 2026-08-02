import type { PodcastEnv } from "./env";
import {
  isValidYouTubeChannelId,
  verifyYouTubeChannelAccess,
  youtubeProviderConfigured,
  YouTubeProviderError
} from "./youtube-provider";

const YOUTUBE_PROVIDER = "youtube";

type ProviderHealthRow = {
  provider: string;
  account_reference: string | null;
  status: "pending" | "ready" | "failed";
  failure_code: string | null;
  checked_at: string | null;
  last_success_at: string | null;
  next_check_at: string;
  consecutive_failures: number;
  lease_token: string | null;
};

type YouTubeVerifier = (
  env: PodcastEnv
) => Promise<{ channelId: string }>;

export async function youtubeChannelAccessEvidenceCurrent(
  db: D1Database,
  expectedChannelId: unknown
): Promise<boolean> {
  if (!isValidYouTubeChannelId(expectedChannelId)) return false;
  const row = await db.prepare(
    `SELECT EXISTS (
       SELECT 1
       FROM provider_access_health
       WHERE provider = 'youtube'
         AND status = 'ready'
         AND account_reference = ?
         AND last_success_at >= datetime('now', '-24 hours')
         AND lease_token IS NULL
         AND lease_expires_at IS NULL
     ) AS current`
  ).bind(expectedChannelId).first<{ current: number }>();
  return Number(row?.current) === 1;
}

/**
 * Refreshes and verifies the exact configured YouTube channel on a bounded
 * cadence. Only content-free provider health is stored; access and refresh
 * tokens never enter D1 or logs.
 */
export async function scheduleYouTubeProviderAccessCheck(
  env: PodcastEnv,
  verify: YouTubeVerifier = verifyYouTubeChannelAccess
): Promise<number> {
  if (!youtubeProviderConfigured(env)) return 0;

  const leaseToken = crypto.randomUUID().replaceAll("-", "");
  let claimed: ProviderHealthRow | null;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO provider_access_health (
         provider, status, next_check_at
       ) VALUES (?, 'pending', datetime('now'))`
    ).bind(YOUTUBE_PROVIDER).run();
    await env.DB.prepare(
      `UPDATE provider_access_health
       SET
         lease_token = ?,
         lease_expires_at = datetime('now', '+2 minutes'),
         updated_at = datetime('now')
       WHERE provider = ?
         AND next_check_at <= datetime('now')
         AND (
           lease_expires_at IS NULL
           OR lease_expires_at <= datetime('now')
         )`
    ).bind(leaseToken, YOUTUBE_PROVIDER).run();
    claimed = await loadProviderHealth(env.DB, YOUTUBE_PROVIDER);
  } catch (error) {
    logProviderCheckError("provider_access_health_claim_failed", error);
    return 0;
  }
  if (claimed?.lease_token !== leaseToken) return 0;

  try {
    const verified = await verify(env);
    await env.DB.prepare(
      `UPDATE provider_access_health
       SET
         account_reference = ?,
         status = 'ready',
         failure_code = NULL,
         checked_at = datetime('now'),
         last_success_at = datetime('now'),
         next_check_at = datetime('now', '+12 hours'),
         consecutive_failures = 0,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = datetime('now')
       WHERE provider = ? AND lease_token = ?`
    ).bind(verified.channelId, YOUTUBE_PROVIDER, leaseToken).run();
    const stored = await loadProviderHealth(env.DB, YOUTUBE_PROVIDER);
    if (
      stored?.status !== "ready"
      || stored.account_reference !== verified.channelId
      || stored.failure_code !== null
      || stored.consecutive_failures !== 0
      || stored.lease_token !== null
    ) {
      throw new Error("provider_access_health_success_not_committed");
    }
    console.log(JSON.stringify({
      level: "info",
      event: "provider_access_health_ready",
      provider: YOUTUBE_PROVIDER
    }));
    return 1;
  } catch (error) {
    const failureCode = providerFailureCode(error);
    try {
      await env.DB.prepare(
        `UPDATE provider_access_health
         SET
           status = 'failed',
           failure_code = ?,
           checked_at = datetime('now'),
           next_check_at = datetime('now', '+1 hour'),
           consecutive_failures = MIN(consecutive_failures + 1, 1000000),
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = datetime('now')
         WHERE provider = ? AND lease_token = ?`
      ).bind(failureCode, YOUTUBE_PROVIDER, leaseToken).run();
      const stored = await loadProviderHealth(env.DB, YOUTUBE_PROVIDER);
      if (
        stored?.status !== "failed"
        || stored.failure_code !== failureCode
        || stored.consecutive_failures < 1
        || stored.lease_token !== null
      ) {
        throw new Error("provider_access_health_failure_not_committed");
      }
    } catch (storeError) {
      logProviderCheckError("provider_access_health_store_failed", storeError);
      return 0;
    }
    console.error(JSON.stringify({
      level: "error",
      event: "provider_access_health_failed",
      provider: YOUTUBE_PROVIDER,
      failureCode
    }));
    return 1;
  }
}

async function loadProviderHealth(
  db: D1Database,
  provider: string
): Promise<ProviderHealthRow | null> {
  return db.prepare(
    `SELECT
       provider, account_reference, status, failure_code, checked_at,
       last_success_at, next_check_at, consecutive_failures, lease_token
     FROM provider_access_health
     WHERE provider = ?`
  ).bind(provider).first<ProviderHealthRow>();
}

function providerFailureCode(error: unknown): string {
  return error instanceof YouTubeProviderError
    && /^[a-z0-9_-]{1,80}$/.test(error.code)
    ? error.code
    : "youtube_provider_check_failed";
}

function logProviderCheckError(event: string, error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    provider: YOUTUBE_PROVIDER,
    errorName: error instanceof Error ? error.name : "UnknownError"
  }));
}
