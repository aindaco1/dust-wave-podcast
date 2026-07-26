import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);

const stagingWebsiteOrigin =
  "https://dust-wave-website-staging.pages.dev";
const localDevelopmentOrigin = "http://localhost:8080";
const productionWebsiteOrigins = [
  "https://dustwave.xyz",
  "https://www.dustwave.xyz"
];

function configuredOrigins(environment) {
  return config.env[environment].vars.ALLOWED_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function expectExactOrigins(origins) {
  expect(new Set(origins).size).toBe(origins.length);

  for (const origin of origins) {
    const parsed = new URL(origin);
    expect(parsed.origin).toBe(origin);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.pathname).toBe("/");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
  }
}

describe("deployment configuration", () => {
  it("keeps credentialed browser origins isolated by environment", () => {
    const stagingOrigins = configuredOrigins("staging");
    const productionOrigins = configuredOrigins("production");

    expect(config.env.staging.vars.SITE_ORIGIN).toBe(stagingWebsiteOrigin);
    expect(config.env.production.vars.SITE_ORIGIN).toBe(
      "https://dustwave.xyz"
    );
    expect(stagingOrigins).toEqual([
      stagingWebsiteOrigin,
      localDevelopmentOrigin
    ]);
    expect(productionOrigins).toEqual(productionWebsiteOrigins);
    expect(stagingOrigins.filter((origin) =>
      productionOrigins.includes(origin)
    )).toEqual([]);
    expect(config.env.staging.vars.FEED_ORIGIN).not.toBe(
      config.env.production.vars.FEED_ORIGIN
    );
    expect(config.env.staging.vars.MEDIA_ORIGIN).not.toBe(
      config.env.production.vars.MEDIA_ORIGIN
    );
  });

  it("uses duplicate-free, exact origins without paths or credentials", () => {
    expectExactOrigins(configuredOrigins("staging"));
    expectExactOrigins(configuredOrigins("production"));
  });
});
