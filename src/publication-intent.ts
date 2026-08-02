import type { EpisodeAccess, PodcastJob } from "./types";

export type RootPublicationDestination = "rss" | "news" | "youtube";
export type NewsPublicationMode = "full_episode" | "premium_teaser";
export type RootPublicationReleaseTiming = "public_release";

export type RootPublicationIntent = {
  destination: RootPublicationDestination;
  jobType: Extract<
    PodcastJob["type"],
    "publish-rss" | "publish-news" | "publish-youtube"
  >;
  releaseTiming: RootPublicationReleaseTiming;
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
    rootPublicationIntent("rss", "publish-rss"),
    rootPublicationIntent("news", "publish-news")
  ];
  const youtubeVideoKey = input.youtubeVideoKey ?? input.videoSourceKey ?? null;
  if (input.access !== "premium_bonus" && Boolean(youtubeVideoKey)) {
    intents.push(rootPublicationIntent("youtube", "publish-youtube"));
  }
  return {
    newsMode: input.access === "premium_bonus"
      ? "premium_teaser"
      : "full_episode",
    intents
  };
}

export function publicationIntentScheduledAt(
  intent: RootPublicationIntent,
  input: { publicAt: string }
): string {
  switch (intent.releaseTiming) {
    case "public_release":
      return input.publicAt;
  }
}

export function hasPublicationDestination(
  plan: EpisodePublicationPlan,
  destination: RootPublicationDestination
): boolean {
  return plan.intents.some((intent) => intent.destination === destination);
}

function rootPublicationIntent(
  destination: RootPublicationDestination,
  jobType: RootPublicationIntent["jobType"]
): RootPublicationIntent {
  return { destination, jobType, releaseTiming: "public_release" };
}
