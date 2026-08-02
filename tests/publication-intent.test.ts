import { describe, expect, it } from "vitest";

import {
  hasPublicationDestination,
  planEpisodePublication,
  publicationIntentScheduledAt
} from "../src/publication-intent";

describe("root publication intent", () => {
  it.each([
    ["public", null, "full_episode", ["rss", "news"]],
    ["public", "video/source.mp4", "full_episode", ["rss", "news", "youtube"]],
    ["early_access", "video/source.mp4", "full_episode", ["rss", "news", "youtube"]],
    ["free_mini", null, "full_episode", ["rss", "news"]],
    ["premium_bonus", null, "premium_teaser", ["rss", "news"]],
    ["premium_bonus", "video/source.mp4", "premium_teaser", ["rss", "news"]]
  ] as const)(
    "plans %s with video %s as %s",
    (access, videoSourceKey, newsMode, destinations) => {
      const plan = planEpisodePublication({ access, videoSourceKey });
      expect(plan.newsMode).toBe(newsMode);
      expect(plan.intents.map(({ destination }) => destination))
        .toEqual(Array.from(destinations));
      expect(plan.intents.map(({ releaseTiming }) => releaseTiming))
        .toEqual(destinations.map(() => "public_release"));
      expect(hasPublicationDestination(plan, "youtube"))
        .toBe(access !== "premium_bonus" && videoSourceKey !== null);
    }
  );

  it("uses a ready audio rendition when no native video was uploaded", () => {
    const plan = planEpisodePublication({
      access: "public",
      videoSourceKey: null,
      youtubeVideoKey:
        "podcasts/show/episode/youtube_audio_rendition/render.mp4"
    });
    expect(plan.intents.map(({ destination }) => destination)).toEqual([
      "rss",
      "news",
      "youtube"
    ]);
  });

  it("holds an early-access YouTube intent until public release", () => {
    const premiumAt = "2026-08-01T12:00:00.000Z";
    const publicAt = "2026-08-08T12:00:00.000Z";
    const plan = planEpisodePublication({
      access: "early_access",
      videoSourceKey: "video/source.mp4"
    });
    const youtube = plan.intents.find(({ destination }) =>
      destination === "youtube"
    );

    expect(youtube).toBeDefined();
    expect(publicationIntentScheduledAt(youtube!, { publicAt })).toBe(publicAt);
    expect(publicationIntentScheduledAt(youtube!, { publicAt }))
      .not.toBe(premiumAt);
  });
});
