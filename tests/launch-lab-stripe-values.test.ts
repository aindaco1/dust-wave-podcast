import { describe, expect, it } from "vitest";

import { createLaunchLabStripeValueReaders } from
  "../src/launch-lab-stripe-values";

describe("Launch Lab Stripe value readers", () => {
  it("preserves lifecycle and hosted-checkout error namespaces", () => {
    const lifecycle = createLaunchLabStripeValueReaders("launch_lab");
    const hosted = createLaunchLabStripeValueReaders("launch_lab_hosted");

    expect(() => lifecycle.providerId("wrong", "cus")).toThrow(
      "launch_lab_invalid_cus_id"
    );
    expect(() => hosted.providerId("wrong", "cus")).toThrow(
      "launch_lab_hosted_invalid_cus_id"
    );
  });

  it("reads direct and expanded provider IDs without throwing", () => {
    const { nestedId, providerId } = createLaunchLabStripeValueReaders(
      "launch_lab"
    );

    expect(providerId("cus_123456", "cus")).toBe("cus_123456");
    expect(nestedId("cus_123456", "cus")).toBe("cus_123456");
    expect(nestedId({ id: "cus_123456" }, "cus")).toBe("cus_123456");
    expect(nestedId({ id: "wrong" }, "cus")).toBeNull();
    expect(nestedId(null, "cus")).toBeNull();
  });

  it("normalizes positive integers and safe diagnostic codes", () => {
    const { positiveInteger, safeErrorCode } =
      createLaunchLabStripeValueReaders("launch_lab");

    expect(positiveInteger("42")).toBe(42);
    expect(positiveInteger(0)).toBe(0);
    expect(positiveInteger(-1)).toBe(0);
    expect(safeErrorCode(new Error("Stripe exploded!"))).toBe(
      "stripe_exploded_"
    );
    expect(safeErrorCode(null)).toBe("unknown_error");
  });
});
