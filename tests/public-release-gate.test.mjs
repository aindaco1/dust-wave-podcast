import { describe, expect, it, vi } from "vitest";

import { runPublicReleaseGate } from
  "../scripts/lib/public-release-gate.mjs";

const feedUrl = "https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml";
const artworkUrl =
  "https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork-feed.jpg";
const etag = `W/"${"a".repeat(64)}"`;
const conditionalEtag = etag.replace(/^W\//, "");
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Ópera en la Selva</title>
<atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
<itunes:image href="${artworkUrl}"/>
</channel></rss>`;

describe("public release gate", () => {
  it("checks the feed, artwork budget, security headers, and conditional cache", async () => {
    const fetchImpl = releaseFetchFixture();
    const evidence = await runPublicReleaseGate({
      environment: "production",
      fetchImpl
    });

    expect(evidence).toMatchObject({
      schemaVersion: "dust-wave-public-release-gate-v1",
      environment: "production",
      feedUrl,
      feedEtag: etag,
      artworkUrl,
      artworkBytes: 209_373,
      conditionalStatus: 304,
      passed: true
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      headers: { accept: "image/jpeg" },
      redirect: "error"
    });
    expect(fetchImpl.mock.calls[2][1].headers["if-none-match"]).toBe(
      conditionalEtag
    );
  });

  it("rejects an unknown deployment target before making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(runPublicReleaseGate({
      environment: "preview",
      fetchImpl
    })).rejects.toThrow("exactly staging or production");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a production feed failure without probing downstream assets", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '{"error":"internal_error"}',
      { status: 500, headers: { "content-type": "application/json" } }
    ));
    await expect(runPublicReleaseGate({
      environment: "production",
      fetchImpl
    })).rejects.toThrow("RSS feed returned HTTP 500");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects artwork over the podcast-directory size budget", async () => {
    const fetchImpl = releaseFetchFixture({ artworkBytes: 1_500_001 });
    await expect(runPublicReleaseGate({
      environment: "production",
      fetchImpl
    })).rejects.toThrow("feed artwork exceeds its 1500000-byte release budget");
  });

  it("rejects a feed that points at noncanonical artwork", async () => {
    const fetchImpl = releaseFetchFixture({
      xml: feedXml.replace(artworkUrl, "https://example.com/artwork.jpg")
    });
    await expect(runPublicReleaseGate({
      environment: "production",
      fetchImpl
    })).rejects.toThrow("exact release artwork URL");
  });
});

function releaseFetchFixture({ xml = feedXml, artworkBytes = 209_373 } = {}) {
  return vi.fn(async (url, init = {}) => {
    if (url === artworkUrl) {
      return new Response(new Uint8Array(artworkBytes), {
        status: 200,
        headers: {
          "cache-control": "public, max-age=14400",
          "content-length": String(artworkBytes),
          "content-type": "image/jpeg",
          "x-content-type-options": "nosniff"
        }
      });
    }
    if (init.headers?.["if-none-match"]) {
      return new Response(null, {
        status: 304,
        headers: { etag: conditionalEtag }
      });
    }
    return new Response(xml, {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
        "content-length": String(new TextEncoder().encode(xml).byteLength),
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
        "x-content-type-options": "nosniff"
      }
    });
  });
}
