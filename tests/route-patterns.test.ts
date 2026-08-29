import { describe, expect, it } from "vitest";

import * as routes from "../src/route-patterns";

describe("route boundaries", () => {
  it("keeps every dynamic route fully anchored", () => {
    const values = Object.entries(routes);
    expect(values.length).toBeGreaterThanOrEqual(150);
    for (const [name, route] of values) {
      if (route instanceof RegExp) {
        expect(route.source.startsWith("^"), name).toBe(true);
        expect(route.source.endsWith("$"), name).toBe(true);
      } else {
        expect(route, name).toMatch(/^\/v1\//);
      }
    }
  });

  it("preserves representative public, private, admin, and processor matches", () => {
    expect(routes.SHOW_PATH.exec("/v1/shows/dust-dont-settle")?.[1])
      .toBe("dust-dont-settle");
    expect(routes.PRIVATE_FEED_PATH.test(
      `/v1/private/${"a".repeat(43)}/dust-dont-settle/rss.xml`
    )).toBe(true);
    expect(routes.ADMIN_EPISODE_PATH.exec("/v1/admin/episodes/episode_1")?.[1])
      .toBe("episode_1");
    expect(routes.PROCESSOR_DELIVERY_AUDIO_PART_PATH.exec(
      "/v1/processor/delivery-audio-jobs/job_1/parts/12"
    )?.slice(1)).toEqual(["job_1", "12"]);
  });

  it("rejects suffixes that could bypass a route boundary", () => {
    expect(routes.SHOW_PATH.test("/v1/shows/show-id/episodes")).toBe(false);
    expect(routes.ADMIN_EPISODE_PATH.test(
      "/v1/admin/episodes/episode_1/publish"
    )).toBe(false);
    expect(routes.PROCESSOR_DISPATCH_CLAIM_PATH)
      .toBe("/v1/processor/dispatches/claim");
  });
});
