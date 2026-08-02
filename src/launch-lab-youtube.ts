import type { PodcastEnv } from "./env";
import { recordLaunchLabObservations } from "./launch-lab-ledger";
import { youtubeChannelAccessEvidenceCurrent } from
  "./provider-access-health";

export async function reconcileLaunchLabYouTubeChannelIdentity(
  env: PodcastEnv,
  runId: string
): Promise<boolean> {
  if (!await youtubeChannelAccessEvidenceCurrent(
    env.DB,
    env.YOUTUBE_CHANNEL_ID
  )) {
    return false;
  }
  await recordLaunchLabObservations(env.DB, runId, [{
    provider: "youtube",
    scenario: "channel_identity",
    observedStatus: "verified"
  }]);
  return true;
}
