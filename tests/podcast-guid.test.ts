import { describe, expect, it } from "vitest";

import {
  discoverPodcastGuid,
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

  it("discovers canonical identity with the standard or an alternate prefix", () => {
    const channel =
      "<channel><p20:guid>"
      + "d21642df-1816-55c8-b308-6209066e9ef6"
      + "</p20:guid></channel>";
    expect(discoverPodcastGuid(
      '<rss xmlns:p20="https://podcastindex.org/namespace/1.0">'
        + `${channel}</rss>`,
      channel
    )).toEqual({
      status: "valid",
      guid: "d21642df-1816-55c8-b308-6209066e9ef6"
    });
    expect(discoverPodcastGuid("<rss><channel/></rss>", "<channel/>"))
      .toEqual({ status: "absent", guid: null });
  });

  it("marks malformed, undeclared, attributed, or duplicate tags invalid", () => {
    const root =
      '<rss xmlns:podcast="https://podcastindex.org/namespace/1.0">';
    for (const channel of [
      "<channel><podcast:guid>not-a-guid</podcast:guid></channel>",
      "<channel><podcast:guid source=\"host\">"
        + "d21642df-1816-55c8-b308-6209066e9ef6"
        + "</podcast:guid></channel>",
      "<channel><podcast:guid>"
        + "d21642df-1816-55c8-b308-6209066e9ef6"
        + "</podcast:guid><podcast:guid>"
        + "917393e3-1b1e-5cef-ace4-edaa54e1f810"
        + "</podcast:guid></channel>"
    ]) {
      expect(discoverPodcastGuid(`${root}${channel}</rss>`, channel))
        .toEqual({ status: "invalid", guid: null });
    }
    const undeclared =
      "<channel><podcast:guid>"
      + "d21642df-1816-55c8-b308-6209066e9ef6"
      + "</podcast:guid></channel>";
    expect(discoverPodcastGuid(`<rss>${undeclared}</rss>`, undeclared))
      .toEqual({ status: "invalid", guid: null });
    expect(discoverPodcastGuid(
      '<rss xmlns:p20="https://podcastindex.org/namespace/1.0">'
        + `${undeclared}</rss>`,
      undeclared
    )).toEqual({ status: "invalid", guid: null });
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
