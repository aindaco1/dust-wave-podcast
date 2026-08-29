import { RequestValidationError } from "@dustwave/worker-core/request-validation";

export {
  boundedPageSize,
  isTruthy,
  optionalText,
  positiveInteger,
  readBoundedBytes,
  readBoundedText,
  readJsonObject,
  readOptionalJsonObject,
  requiredText,
  safeFilename,
  validDateTime,
  validIdentifier,
  validSlug
} from "@dustwave/worker-core/request-validation";

export { RequestValidationError };

export function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RequestValidationError(`${field} must be a non-negative integer`);
  }
  return number;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function strictInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  return value as number;
}

export function recordOrNull(
  value: unknown
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function boundedEvidence(
  value: unknown,
  maximum: number
): string | null {
  const text = String(value ?? "").trim();
  return text ? Array.from(text).slice(0, maximum).join("") : null;
}
