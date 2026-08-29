import { readSignedJsonBody } from "./signed-callback";
import { privateJson } from "./http";
import type { PodcastEnv } from "./env";
import {
  positiveInteger,
  RequestValidationError,
  validIdentifier
} from "./validation";

export const PROCESSOR_TIMESTAMP_HEADER = "x-podcast-processor-timestamp";
export const PROCESSOR_SIGNATURE_HEADER = "x-podcast-processor-signature";
export const PROCESSOR_PART_PAYLOAD_HEADER =
  "x-podcast-processor-part-payload";
export const MAXIMUM_PROCESSOR_BODY_BYTES = 125_000;
export const MAXIMUM_PROCESSOR_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAXIMUM_PROCESSOR_PART_BYTES = 32 * 1024 * 1024;
export const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const RECOMMENDED_PROCESSOR_PART_BYTES = 33_554_432 as const;

export type ProcessorPartRow = {
  part_number: number;
  uploaded_bytes: number;
};

export type ProcessorPartPayload = {
  id: string;
  partNumber: number;
  objectBytes: number;
  sha256: string;
  manifestSha256: string;
};

export type ProcessorMultipartEvidence = {
  objectBytes: number;
  outputSha256: string;
  partCount: number;
  manifestSha256: string;
};

export function mediaProcessorAuthError(
  request: Request,
  allowedOrigins: string,
  reason: "secret_missing" | "invalid_signature"
): Response {
  return privateJson(
    request,
    allowedOrigins,
    {
      error: reason === "secret_missing"
        ? "not_found"
        : "invalid_processor_signature"
    },
    { status: reason === "secret_missing" ? 404 : 401 }
  );
}

export function invalidMediaProcessorSignature(
  request: Request,
  env: PodcastEnv
): Response {
  return mediaProcessorAuthError(
    request,
    env.ALLOWED_ORIGINS,
    "invalid_signature"
  );
}

export async function readMediaProcessorSignedJson(
  request: Request,
  {
    available,
    secret,
    bodyName,
    invalidBodyCode,
    maximumBytes = MAXIMUM_PROCESSOR_BODY_BYTES,
    unavailableResponse,
    invalidSignatureResponse
  }: {
    available: boolean;
    secret?: string;
    bodyName: string;
    invalidBodyCode: string;
    maximumBytes?: number;
    unavailableResponse: () => Response;
    invalidSignatureResponse: () => Response;
  }
): Promise<{ body: Record<string, unknown> } | Response> {
  if (!available) return unavailableResponse();
  const signed = await readSignedJsonBody(request, {
    secret,
    timestampHeader: PROCESSOR_TIMESTAMP_HEADER,
    signatureHeader: PROCESSOR_SIGNATURE_HEADER,
    maximumBytes,
    bodyName,
    invalidBodyCode
  });
  if (!signed.ok) {
    return signed.reason === "secret_missing"
      ? unavailableResponse()
      : invalidSignatureResponse();
  }
  return signed;
}

export function parseMediaProcessorPartPayload(
  encoded: string,
  {
    idField,
    idLabel,
    invalidPayloadMessage,
    maximumPartBytes = MAXIMUM_PROCESSOR_PART_BYTES,
    validateSha256 = requiredProcessorSha256
  }: {
    idField: string;
    idLabel: string;
    invalidPayloadMessage: string;
    maximumPartBytes?: number;
    validateSha256?: (value: unknown, field: string) => string;
  }
): ProcessorPartPayload {
  let value: Record<string, unknown>;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - encoded.length % 4) % 4);
    value = JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(invalidPayloadMessage);
  }
  return {
    id: validIdentifier(value[idField], idLabel),
    partNumber: positiveInteger(value.partNumber, "partNumber", 10_000),
    objectBytes: positiveInteger(
      value.objectBytes,
      "objectBytes",
      maximumPartBytes
    ),
    sha256: validateSha256(value.sha256, "sha256"),
    manifestSha256: validateSha256(
      value.manifestSha256,
      "manifestSha256"
    )
  };
}

export function parseMediaProcessorMultipartEvidence(
  body: Record<string, unknown>,
  expectedId: string,
  {
    idField,
    mismatchMessage = "The multipart evidence does not match its URL",
    maximumOutputBytes = MAXIMUM_PROCESSOR_OUTPUT_BYTES,
    validateSha256 = requiredProcessorSha256
  }: {
    idField: string;
    mismatchMessage?: string;
    maximumOutputBytes?: number;
    validateSha256?: (value: unknown, field: string) => string;
  }
): ProcessorMultipartEvidence {
  if (
    body[idField] !== expectedId
    || body.action !== "upload-complete"
  ) {
    throw new RequestValidationError(mismatchMessage);
  }
  return {
    objectBytes: positiveInteger(
      body.objectBytes,
      "objectBytes",
      maximumOutputBytes
    ),
    outputSha256: validateSha256(
      body.outputSha256,
      "outputSha256"
    ),
    partCount: positiveInteger(body.partCount, "partCount", 10_000),
    manifestSha256: validateSha256(
      body.manifestSha256,
      "manifestSha256"
    )
  };
}

export function validateMediaProcessorMultipartParts(
  parts: ProcessorPartRow[],
  evidence: Pick<ProcessorMultipartEvidence, "objectBytes" | "partCount">,
  {
    partCountMessage = "The multipart part count is incomplete",
    contiguousMessage = "The multipart parts must be contiguous",
    minimumPartMessage =
      "Every non-final multipart part must be at least 5 MiB",
    byteTotalMessage =
      "The multipart byte total does not match the output",
    combinedOrderingAndSizeMessage
  }: {
    partCountMessage?: string;
    contiguousMessage?: string;
    minimumPartMessage?: string;
    byteTotalMessage?: string;
    combinedOrderingAndSizeMessage?: string;
  } = {}
): void {
  if (parts.length !== evidence.partCount || parts.length === 0) {
    throw new RequestValidationError(partCountMessage);
  }
  let total = 0;
  for (const [index, part] of parts.entries()) {
    if (part.part_number !== index + 1) {
      throw new RequestValidationError(
        combinedOrderingAndSizeMessage ?? contiguousMessage
      );
    }
    if (
      index < parts.length - 1
      && part.uploaded_bytes < MINIMUM_MULTIPART_PART_BYTES
    ) {
      throw new RequestValidationError(
        combinedOrderingAndSizeMessage ?? minimumPartMessage
      );
    }
    total += part.uploaded_bytes;
  }
  if (total !== evidence.objectBytes) {
    throw new RequestValidationError(byteTotalMessage);
  }
}

export function requiredProcessorSha256(
  value: unknown,
  field: string
): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RequestValidationError(`${field} must be a SHA-256 hex digest`);
  }
  return value;
}
