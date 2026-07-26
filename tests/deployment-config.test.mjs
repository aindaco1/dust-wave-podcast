import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);

const stagingWebsiteOrigin =
  "https://dust-wave-website-staging.pages.dev";

describe("deployment configuration", () => {
  it("allows the isolated website only in the staging Worker environment", () => {
    const stagingOrigins =
      config.env.staging.vars.ALLOWED_ORIGINS.split(",");
    const productionOrigins =
      config.env.production.vars.ALLOWED_ORIGINS.split(",");

    expect(stagingOrigins).toContain(stagingWebsiteOrigin);
    expect(productionOrigins).not.toContain(stagingWebsiteOrigin);
  });
});
