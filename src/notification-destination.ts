import {
  hmacSha256,
  normalizeEmail,
  sha256Hex
} from "@dustwave/worker-core/crypto";

const DESTINATION_PREFIX = "aes-gcm-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sealNotificationDestination(
  emailValue: string,
  listenerId: string,
  secret: string
): Promise<string> {
  const email = normalizeEmail(emailValue);
  const key = await destinationKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: destinationContext(listenerId)
    },
    key,
    encoder.encode(email)
  );
  return [
    DESTINATION_PREFIX,
    base64urlEncode(iv),
    base64urlEncode(new Uint8Array(ciphertext))
  ].join(":");
}

export async function openNotificationDestination(
  sealedValue: string,
  listenerId: string,
  secret: string
): Promise<string | null> {
  const [prefix, ivValue, ciphertextValue, ...extra] =
    String(sealedValue ?? "").split(":");
  if (
    prefix !== DESTINATION_PREFIX
    || !ivValue
    || !ciphertextValue
    || extra.length > 0
  ) {
    return null;
  }
  try {
    const key = await destinationKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64urlDecode(ivValue),
        additionalData: destinationContext(listenerId)
      },
      key,
      base64urlDecode(ciphertextValue)
    );
    const email = normalizeEmail(decoder.decode(plaintext));
    return email || null;
  } catch {
    return null;
  }
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
  return String(value ?? "").startsWith(`${DESTINATION_PREFIX}:`);
}

async function destinationKey(secret: string): Promise<CryptoKey> {
  assertDestinationSecret(secret);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`podcast-notification-destination-v1\0${secret}`)
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

function assertDestinationSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("notification_destination_not_configured");
  }
}

function destinationContext(listenerId: string): Uint8Array {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(listenerId)) {
    throw new TypeError("listenerId is invalid");
  }
  return encoder.encode(`podcast-listener-email-v1\0${listenerId}`);
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid base64url value");
  }
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0)
  );
}
