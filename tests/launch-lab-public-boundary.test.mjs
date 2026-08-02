import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import fixture from "../config/launch-lab-fixture.json";

const showsSource = readFileSync(
  new URL("../src/shows.ts", import.meta.url),
  "utf8"
);
const feedSource = readFileSync(
  new URL("../src/feed.ts", import.meta.url),
  "utf8"
);
const publicBoundarySources = [
  "media.ts",
  "chapters.ts",
  "transcripts.ts",
  "clip-publications.ts",
  "tax-quotes.ts",
  "subscription-checkout.ts",
  "pool-redemptions.ts",
  "delivery-audio.ts",
  "ad-runtime.ts"
].map((filename) => ({
  filename,
  source: readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8")
}));

describe("Launch Lab public boundary", () => {
  it("keeps the immutable fixture explicitly non-public and non-billable", () => {
    expect(fixture.safeguards).toEqual({
      stagingOnly: true,
      publicCatalog: false,
      launchEligible: false,
      billable: false,
      rssDirectoryBlocked: true
    });
    expect(fixture.show.testFixture).toBe(true);
  });

  it("filters fixtures from both public show reads and the public RSS feed", () => {
    expect(showsSource.match(/test_fixture = 0/g)).toHaveLength(2);
    expect(feedSource).toContain("AND test_fixture = 0");
  });

  it("blocks private fixture feeds from directory ingestion", () => {
    expect(feedSource).toContain(
      'show.test_fixture === 1 ? "<itunes:block>yes</itunes:block>"'
    );
  });

  it("keeps fixture descendants out of ordinary public and billable routes", () => {
    for (const { filename, source } of publicBoundarySources) {
      expect(source, filename).toMatch(/test_fixture\s*=\s*0|test_fixture === 0/);
    }
  });
});
