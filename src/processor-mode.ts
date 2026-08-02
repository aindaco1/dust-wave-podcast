import type { PodcastEnv } from "./env";

export type ProcessorMode =
  | "staging_automatic"
  | "staging_manual"
  | "unavailable";

export function describeProcessorAvailability(
  env: PodcastEnv,
  prerequisitesAvailable: boolean
): {
  available: boolean;
  mode: ProcessorMode;
} {
  const available = env.ENVIRONMENT === "staging"
    && prerequisitesAvailable;
  if (!available) {
    return { available: false, mode: "unavailable" };
  }
  return {
    available: true,
    mode: env.PROCESSOR_DISPATCH_MODE === "github_actions_pull"
      ? "staging_automatic"
      : "staging_manual"
  };
}
