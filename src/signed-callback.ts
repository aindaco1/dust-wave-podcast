import {
  hmacSha256,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import {
  RequestValidationError
} from "./validation";

export type SignedJsonBodyResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: "secret_missing" | "invalid_signature";
    };

export async function readSignedJsonBody(
  request: Request,
  {
    secret,
    timestampHeader,
    signatureHeader,
    maximumBytes,
    bodyName,
    invalidBodyCode,
    signatureWindowSeconds = 5 * 60,
    now = new Date()
  }: {
    secret?: string;
    timestampHeader: string;
    signatureHeader: string;
    maximumBytes: number;
    bodyName: string;
    invalidBodyCode: string;
    signatureWindowSeconds?: number;
    now?: Date;
  }
): Promise<SignedJsonBodyResult> {
  if (!secret) return { ok: false, reason: "secret_missing" };
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 2
    || !Number.isSafeInteger(signatureWindowSeconds)
    || signatureWindowSeconds < 1
    || !Number.isFinite(now.getTime())
  ) {
    throw new TypeError("Signed callback configuration is invalid");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError(
      `${bodyName} must use application/json`,
      invalidBodyCode
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > maximumBytes
    ) {
      throw new RequestValidationError(
        `${bodyName} is too large`,
        "body_too_large",
        413
      );
    }
  }

  const rawBody = await request.text();
  const rawBodyBytes = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyBytes > maximumBytes) {
    throw new RequestValidationError(
      `${bodyName} is too large`,
      "body_too_large",
      413
    );
  }
  if (rawBodyBytes < 2) {
    throw new RequestValidationError(
      `${bodyName} body is invalid`,
      invalidBodyCode
    );
  }

  const timestamp = Number(request.headers.get(timestampHeader));
  const signature = request.headers.get(signatureHeader) ?? "";
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp < 1
    || !/^[a-f0-9]{64}$/.test(signature)
    || Math.abs(Math.floor(now.getTime() / 1_000) - timestamp)
      > signatureWindowSeconds
  ) {
    return { ok: false, reason: "invalid_signature" };
  }
  const expected = await hmacSha256(
    `${timestamp}.${rawBody}`,
    secret,
    "hex"
  );
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const value = await Promise.resolve()
    .then(() => JSON.parse(rawBody) as unknown)
    .catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(
      `${bodyName} must be a JSON object`,
      invalidBodyCode
    );
  }
  return { ok: true, body: value as Record<string, unknown> };
}
