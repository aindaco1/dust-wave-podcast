import type { PodcastEnv } from "./env";
import { isTruthy } from "./validation";

export function poolRedemptionConfigured(env: PodcastEnv): boolean {
  return isTruthy(env.POOL_REDEMPTION_ENABLED)
    && Boolean(env.POOL_PODCAST_BRIDGE_SECRET)
    && Boolean(env.POOL_REDEMPTION_CODE_PEPPER)
    && Boolean(env.LISTENER_EMAIL_LOOKUP_PEPPER);
}
