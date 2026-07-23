export class RequestValidationError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = "invalid_request", status = 400) {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
    this.status = status;
  }
}

export async function readJsonObject(
  request: Request,
  maximumBytes = 1_000_000
): Promise<Record<string, unknown>> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestValidationError("Request body is too large", "body_too_large", 413);
  }
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("A JSON object is required");
  }
  return value as Record<string, unknown>;
}

export function requiredText(
  value: unknown,
  field: string,
  maximumLength = 500
): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RequestValidationError(`${field} is required`);
  if (text.length > maximumLength) {
    throw new RequestValidationError(`${field} is too long`);
  }
  return text;
}

export function optionalText(
  value: unknown,
  field: string,
  maximumLength = 10_000
): string {
  const text = String(value ?? "").trim();
  if (text.length > maximumLength) {
    throw new RequestValidationError(`${field} is too long`);
  }
  return text;
}

export function validSlug(value: unknown, field = "slug"): string {
  const slug = requiredText(value, field, 120).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new RequestValidationError(`${field} must be URL-safe`);
  }
  return slug;
}

export function validIdentifier(value: unknown, field = "id"): string {
  const id = requiredText(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return id;
}

export function validDateTime(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new RequestValidationError(`${field} must be an ISO date-time`);
  }
  return date.toISOString();
}

export function safeFilename(value: unknown): string {
  const filename = requiredText(value, "filename", 180)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  if (filename === "." || filename === "..") {
    throw new RequestValidationError("filename is invalid");
  }
  return filename;
}

export function positiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new RequestValidationError(`${field} must be a positive integer`);
  }
  return number;
}

export function isTruthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}
