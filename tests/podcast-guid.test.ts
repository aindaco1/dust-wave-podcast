import { describe, expect, it } from "vitest";

import {
  isPodcastGuid,
  podcastGuidForFeedUrl
} from "../src/podcast-guid";

describe("Podcasting 2.0 channel GUID", () => {
  it("matches the published UUIDv5 examples", async () => {
    await expect(
      podcastGuidForFeedUrl(
        "https://mp3s.nashownotes.com/pc20rss.xml"
      )
    ).resolves.toBe("917393e3-1b1e-5cef-ace4-edaa54e1f810");
    await expect(
      podcastGuidForFeedUrl("https://podnews.net/rss")
    ).resolves.toBe("9b024349-ccf0-5f69-a609-6b82873eab3c");
  });

  it("strips the scheme and trailing slash without changing identity", async () => {
    const expected = await podcastGuidForFeedUrl(
      "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml"
    );
    await expect(
      podcastGuidForFeedUrl(
        "http://feeds.dustwave.xyz/opera-en-la-selva/rss.xml/"
      )
    ).resolves.toBe(expected);
    expect(expected).toBe("d21642df-1816-55c8-b308-6209066e9ef6");
  });

  it("accepts only lowercase RFC 4122 UUIDv5 values", () => {
    expect(
      isPodcastGuid("d21642df-1816-55c8-b308-6209066e9ef6")
    ).toBe(true);
    expect(
      isPodcastGuid("d21642df-1816-45c8-b308-6209066e9ef6")
    ).toBe(false);
    expect(
      isPodcastGuid("D21642DF-1816-55C8-B308-6209066E9EF6")
    ).toBe(false);
    expect(isPodcastGuid(null)).toBe(false);
  });

  it("rejects feed seeds with credentials, fragments, or another protocol", async () => {
    await expect(
      podcastGuidForFeedUrl("https://user@example.com/feed.xml")
    ).rejects.toThrow(TypeError);
    await expect(
      podcastGuidForFeedUrl("https://example.com/feed.xml#private")
    ).rejects.toThrow(TypeError);
    await expect(
      podcastGuidForFeedUrl("ftp://example.com/feed.xml")
    ).rejects.toThrow(TypeError);
  });
});
