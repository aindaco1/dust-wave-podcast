import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);
const workerEntrypoint = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
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

  it("keeps automatic URL-bearing telemetry off for bearer-token routes", () => {
    expect(config.observability.enabled).toBe(true);
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.observability.traces).toEqual({
      enabled: false
    });
    expect(config.env.staging.observability).toBeUndefined();
    expect(config.env.production.observability).toBeUndefined();
    expect(workerEntrypoint).not.toContain("request.url");
    expect(workerEntrypoint).not.toContain("error.message");
    expect(workerEntrypoint).toContain('event: "job_failed"');
    expect(workerEntrypoint).toContain("queueMessageId: message.id");
    expect(workerEntrypoint).toContain("attempt: message.attempts");
    expect(workerEntrypoint).toContain("errorName:");
  });

  it("keeps staging billing test-only and fail-closed behind required secrets", () => {
    const requiredSecrets = new Set(
      config.env.staging.secrets.required
    );
    expect(Array.from(requiredSecrets)).toEqual(expect.arrayContaining([
      "LISTENER_EMAIL_LOOKUP_PEPPER",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "TAX_QUOTE_HASH_SECRET",
      "TURNSTILE_SECRET_KEY"
    ]));
    expect(config.env.staging.vars.STRIPE_MODE).toBe("test");
    expect(config.env.staging.vars.SUBSCRIPTION_CHECKOUT_ENABLED).toBe(
      "false"
    );
    expect(config.env.staging.vars.CHECKOUT_TURNSTILE_REQUIRED).toBe(
      "true"
    );
    expect(config.env.staging.vars.ADMIN_TURNSTILE_REQUIRED).toBe(
      "false"
    );
    expect(config.env.staging.vars.LISTENER_TURNSTILE_REQUIRED).toBe(
      "true"
    );
    expect(config.env.production.vars.SUBSCRIPTION_CHECKOUT_ENABLED).toBe(
      "false"
    );
    expect(config.env.production.vars.ADMIN_TURNSTILE_REQUIRED).toBe(
      "true"
    );
  });

  it("keeps public clip delivery isolated to staging preview", () => {
    expect(config.env.staging.vars.CLIP_PUBLICATION_MODE).toBe(
      "staging_preview"
    );
    expect(config.env.production.vars.CLIP_PUBLICATION_MODE).toBe(
      "disabled"
    );
  });

  it("keeps RSS execution staging-only behind a dedicated secret", () => {
    const requiredSecrets = new Set(
      config.env.staging.secrets.required
    );
    expect(requiredSecrets.has("RSS_IMPORT_URL_SECRET")).toBe(true);
    expect(config.env.staging.vars.RSS_IMPORT_EXECUTION_MODE).toBe(
      "staging_copy"
    );
    expect(config.env.production.vars.RSS_IMPORT_EXECUTION_MODE).toBe(
      "disabled"
    );
  });

  it("keeps review-only AI drafting enabled only in staging", () => {
    expect(config.env.staging.ai).toEqual({ binding: "AI" });
    expect(config.env.production.ai).toEqual({ binding: "AI" });
    expect(config.env.staging.vars.SHOW_NOTES_AI_ENABLED).toBe("true");
    expect(config.env.production.vars.SHOW_NOTES_AI_ENABLED).toBe("false");
    expect(config.env.staging.vars.CHAPTER_DRAFT_AI_ENABLED).toBe("true");
    expect(config.env.production.vars.CHAPTER_DRAFT_AI_ENABLED).toBe("false");
    expect(config.env.staging.vars.CLIP_DRAFT_AI_ENABLED).toBe("true");
    expect(config.env.production.vars.CLIP_DRAFT_AI_ENABLED).toBe("false");
  });
});
