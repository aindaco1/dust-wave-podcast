import {
  hmacSha256,
  normalizeEmail,
  sha256Hex
} from "@dustwave/worker-core/crypto";
import {
  isSealedSensitiveValue,
  openSensitiveValue,
  sealSensitiveValue
} from "./sealed-value";

const DESTINATION_CONTRACT = {
  keyContext: "podcast-notification-destination-v1",
  additionalDataContext: "podcast-listener-email-v1"
};

export async function sealNotificationDestination(
  emailValue: string,
  listenerId: string,
  secret: string
): Promise<string> {
  assertDestinationSecret(secret);
  const email = normalizeEmail(emailValue);
  return sealSensitiveValue(
    email,
    listenerId,
    secret,
    DESTINATION_CONTRACT
  );
}

export async function openNotificationDestination(
  sealedValue: string,
  listenerId: string,
  secret: string
): Promise<string | null> {
  assertDestinationSecret(secret);
  const email = await openSensitiveValue(
    sealedValue,
    listenerId,
    secret,
    DESTINATION_CONTRACT
  );
  return email ? normalizeEmail(email) : null;
}

export async function notificationUnsubscribeToken(
  listenerId: string,
  showId: string,
  secret: string
): Promise<string> {
  assertDestinationSecret(secret);
  return hmacSha256(
    `podcast-announcement-unsubscribe-v1\0${listenerId}\0${showId}`,
    secret
  );
}

export async function notificationUnsubscribeTokenHash(
  token: string
): Promise<string> {
  return sha256Hex(`podcast-announcement-unsubscribe-v1\0${token}`);
}

export function isSealedNotificationDestination(value: string): boolean {
  return isSealedSensitiveValue(value);
}

function assertDestinationSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("notification_destination_not_configured");
  }
}
