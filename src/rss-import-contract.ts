import {
  RequestValidationError,
  requiredText
} from "./validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function displayRssImportUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function requireRssImportOwnershipConfirmation(
  value: unknown
): void {
  if (value !== true) {
    throw new RequestValidationError(
      "You must confirm that Dust Wave owns or may import this podcast.",
      "rss_import_ownership_confirmation_required"
    );
  }
}

export function requireExactRssImportKeys(
  value: Record<string, unknown>,
  keys: string[],
  boundary: string
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestValidationError(
      `The RSS import ${boundary} request has unsupported fields.`
    );
  }
}

export function validRssImportSha256(
  value: unknown,
  field: string
): string {
  const digest = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw new RequestValidationError(`${field} must be a SHA-256 digest`);
  }
  return digest;
}
