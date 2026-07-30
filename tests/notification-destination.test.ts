import { describe, expect, it } from "vitest";

import {
  notificationUnsubscribeToken,
  notificationUnsubscribeTokenHash,
  openNotificationDestination,
  sealNotificationDestination
} from "../src/notification-destination";

const DESTINATION_SECRET =
  "notification_destination_test_secret_123456789";

describe("protected announcement destinations", () => {
  it("seals a normalized email with listener-bound authenticated encryption", async () => {
    const sealed = await sealNotificationDestination(
      " LISTENER@Example.com ",
      "listener_fixture",
      DESTINATION_SECRET
    );

    expect(sealed).toMatch(/^aes-gcm-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("listener@example.com");
    await expect(
      openNotificationDestination(
        sealed,
        "listener_fixture",
        DESTINATION_SECRET
      )
    ).resolves.toBe("listener@example.com");
    await expect(
      openNotificationDestination(
        sealed,
        "different_listener",
        DESTINATION_SECRET
      )
    ).resolves.toBeNull();
  });

  it("derives stable, opaque, show-scoped unsubscribe tokens", async () => {
    const token = await notificationUnsubscribeToken(
      "listener_fixture",
      "show_fixture",
      DESTINATION_SECRET
    );
    const otherShowToken = await notificationUnsubscribeToken(
      "listener_fixture",
      "show_other",
      DESTINATION_SECRET
    );

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(otherShowToken).not.toBe(token);
    await expect(notificationUnsubscribeTokenHash(token))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for undersized key material", async () => {
    await expect(
      sealNotificationDestination(
        "listener@example.com",
        "listener_fixture",
        "too-short"
      )
    ).rejects.toThrow("notification_destination_not_configured");
  });
});
