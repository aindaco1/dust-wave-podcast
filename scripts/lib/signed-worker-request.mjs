import {
  mediaProcessorSignature
} from "./media-processor-signature.mjs";

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 64_000;

export async function signedWorkerRequest({
  fetchImpl = fetch,
  callbackSecret,
  origin,
  path,
  body,
  errorPrefix,
  maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES
}) {
  if (!/^[a-z0-9_]{3,80}$/.test(String(errorPrefix ?? ""))) {
    throw new Error("Signed Worker request error prefix is invalid.");
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes)
    || maximumResponseBytes < 100
    || maximumResponseBytes > 1_000_000
  ) {
    throw new Error("Signed Worker response limit is invalid.");
  }
  const rawBody = JSON.stringify(body);
  const signed = mediaProcessorSignature(rawBody, callbackSecret);
  const response = await fetchImpl(new URL(path, origin), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-podcast-processor-timestamp": String(signed.timestamp),
      "x-podcast-processor-signature": signed.signature
    },
    body: rawBody
  });
  const responseBody = await readBoundedResponse(
    response,
    maximumResponseBytes
  );
  if (!response.ok) {
    const code = `${errorPrefix}_http_${response.status}`;
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  const value = parseObject(responseBody);
  if (!value) throw new Error(`${errorPrefix}_response_invalid`);
  return value;
}

export async function retrySignedWorkerRequest(input, attempts = 3) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Signed Worker retry count is invalid.");
  }
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await signedWorkerRequest(input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readBoundedResponse(response, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("signed_worker_response_too_large");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error("signed_worker_response_too_large");
  }
  return text;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
