const SEALED_VALUE_PREFIX = "aes-gcm-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SealedValueContract = {
  keyContext: string;
  additionalDataContext: string;
};

export async function sealSensitiveValue(
  value: string,
  recordId: string,
  secret: string,
  contract: SealedValueContract
): Promise<string> {
  const plaintext = String(value);
  if (!plaintext || plaintext.length > 4_000) {
    throw new TypeError("sealed value must contain 1-4000 characters");
  }
  const key = await sealedValueKey(secret, contract.keyContext);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(recordId, contract)
    },
    key,
    encoder.encode(plaintext)
  );
  return [
    SEALED_VALUE_PREFIX,
    base64urlEncode(iv),
    base64urlEncode(new Uint8Array(ciphertext))
  ].join(":");
}

export async function openSensitiveValue(
  sealedValue: string,
  recordId: string,
  secret: string,
  contract: SealedValueContract
): Promise<string | null> {
  const [prefix, ivValue, ciphertextValue, ...extra] =
    String(sealedValue ?? "").split(":");
  if (
    prefix !== SEALED_VALUE_PREFIX
    || !ivValue
    || !ciphertextValue
    || extra.length > 0
  ) {
    return null;
  }
  try {
    const key = await sealedValueKey(secret, contract.keyContext);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64urlDecode(ivValue),
        additionalData: additionalData(recordId, contract)
      },
      key,
      base64urlDecode(ciphertextValue)
    );
    const value = decoder.decode(plaintext);
    return value && value.length <= 4_000 ? value : null;
  } catch {
    return null;
  }
}

export function isSealedSensitiveValue(value: string): boolean {
  return String(value ?? "").startsWith(`${SEALED_VALUE_PREFIX}:`);
}

async function sealedValueKey(
  secret: string,
  keyContext: string
): Promise<CryptoKey> {
  assertSecret(secret);
  assertContext(keyContext);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${keyContext}\0${secret}`)
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

function additionalData(
  recordId: string,
  contract: SealedValueContract
): Uint8Array {
  assertRecordId(recordId);
  assertContext(contract.additionalDataContext);
  return encoder.encode(
    `${contract.additionalDataContext}\0${recordId}`
  );
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("sealed_value_secret_not_configured");
  }
}

function assertRecordId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(value)) {
    throw new TypeError("sealed value record ID is invalid");
  }
}

function assertContext(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(value)) {
    throw new TypeError("sealed value context is invalid");
  }
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Invalid base64url value");
  }
  const base64 = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0)
  );
}
