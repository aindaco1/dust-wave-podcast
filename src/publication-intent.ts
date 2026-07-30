import type { EpisodeAccess, PodcastJob } from "./types";

export type RootPublicationDestination = "rss" | "news" | "youtube";
export type NewsPublicationMode = "full_episode" | "premium_teaser";

export type RootPublicationIntent = {
  destination: RootPublicationDestination;
  jobType: Extract<
    PodcastJob["type"],
    "publish-rss" | "publish-news" | "publish-youtube"
  >;
};

export type EpisodePublicationPlan = {
  newsMode: NewsPublicationMode;
  intents: RootPublicationIntent[];
};

export function planEpisodePublication(input: {
  access: EpisodeAccess;
  videoSourceKey?: string | null;
  youtubeVideoKey?: string | null;
}): EpisodePublicationPlan {
  const intents: RootPublicationIntent[] = [
    { destination: "rss", jobType: "publish-rss" },
    { destination: "news", jobType: "publish-news" }
  ];
  const youtubeVideoKey = input.youtubeVideoKey ?? input.videoSourceKey ?? null;
  if (input.access !== "premium_bonus" && Boolean(youtubeVideoKey)) {
    intents.push({ destination: "youtube", jobType: "publish-youtube" });
  }
  return {
    newsMode: input.access === "premium_bonus"
      ? "premium_teaser"
      : "full_episode",
    intents
  };
}

export function hasPublicationDestination(
  plan: EpisodePublicationPlan,
  destination: RootPublicationDestination
): boolean {
  return plan.intents.some((intent) => intent.destination === destination);
}
