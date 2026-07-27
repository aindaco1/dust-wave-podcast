import { describe, expect, it } from "vitest";

import {
  hasPublicationDestination,
  planEpisodePublication
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
});
