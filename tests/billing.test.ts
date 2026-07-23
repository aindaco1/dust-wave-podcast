import { describe, expect, it } from "vitest";

import { handleStripeWebhook } from "../src/billing";
import type { PodcastEnv } from "../src/env";

describe("Stripe webhook boundary", () => {
  it("rejects an unsigned provider payload before touching D1", async () => {
    const response = await handleStripeWebhook(
      new Request("https://feeds.dustwave.xyz/v1/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify({ id: "evt_fixture" })
      }),
      {
        STRIPE_WEBHOOK_SECRET: "whsec_fixture"
      } as PodcastEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
  });
});
