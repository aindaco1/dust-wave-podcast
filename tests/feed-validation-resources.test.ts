import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import { imageDimensions } from "@dustwave/media-core/image-dimensions";
import { validatePublicFeedResources } from "../src/feed-validation-resources";

describe("public feed resource preflight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a permanent page and directory-sized square PNG", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has("range")) {
        return artworkResponse(1_400, 1_400);
      }
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(validatePublicFeedResources(
      resourceEnv(),
      emptyFeed(),
      "https://feeds.dustwave.xyz/opera/rss.xml"
    )).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects undersized artwork with a stable failure code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has("range")) {
        return artworkResponse(505, 505);
      }
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }));

    await expect(validatePublicFeedResources(
      resourceEnv(),
      emptyFeed(),
      "https://feeds.dustwave.xyz/opera/rss.xml"
    )).rejects.toMatchObject({ code: "feed_artwork_dimensions_invalid" });
  });

  it("does not follow canonical-page redirects outside approved origins", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/capture" }
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(validatePublicFeedResources(
      resourceEnv(),
      emptyFeed(),
      "https://feeds.dustwave.xyz/opera/rss.xml"
    )).rejects.toMatchObject({ code: "feed_canonical_page_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects enclosure query capabilities before any network request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const item = `<item>
      <link>https://dustwave.xyz/news/podcasts/opera/episode/</link>
      <enclosure url="https://media.dustwave.xyz/episodes/episode_1/audio?token=secret" length="10" type="audio/mpeg"/>
    </item>`;

    await expect(validatePublicFeedResources(
      resourceEnv(),
      emptyFeed(item),
      "https://feeds.dustwave.xyz/opera/rss.xml"
    )).rejects.toMatchObject({ code: "feed_enclosure_url_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary canonical origin before any network request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(validatePublicFeedResources(
      resourceEnv(),
      emptyFeed().replaceAll("https://dustwave.xyz", "https://attacker.example"),
      "https://feeds.dustwave.xyz/opera/rss.xml"
    )).rejects.toMatchObject({ code: "feed_canonical_url_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("parses PNG dimensions without decoding untrusted image pixels", () => {
    expect(imageDimensions(pngHeader(3_000, 3_000), "image/png"))
      .toEqual({ width: 3_000, height: 3_000 });
    expect(imageDimensions(new Uint8Array(24), "image/png")).toBeNull();
  });
});

function emptyFeed(item = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <link>https://dustwave.xyz/podcasts/opera/</link>
  <itunes:image href="https://dustwave.xyz/img/podcasts/opera/artwork.png"/>
  ${item}
</channel></rss>`;
}

function resourceEnv(): PodcastEnv {
  return {
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN: "https://feeds.dustwave.xyz",
    MEDIA_ORIGIN: "https://media.dustwave.xyz"
  } as unknown as PodcastEnv;
}

function artworkResponse(width: number, height: number): Response {
  return new Response(pngHeader(width, height), {
    status: 206,
    headers: {
      "content-type": "image/png",
      "content-length": "24",
      "content-range": "bytes 0-23/24"
    }
  });
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
