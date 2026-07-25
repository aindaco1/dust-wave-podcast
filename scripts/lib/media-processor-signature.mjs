import { createHmac } from "node:crypto";

export function mediaProcessorSignature(
  body,
  secret,
  timestamp = Math.floor(Date.now() / 1_000)
) {
  if (!String(secret || "")) {
    throw new Error("MEDIA_PROCESSOR_CALLBACK_SECRET is required.");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new Error("The processor timestamp is invalid.");
  }
  return {
    timestamp,
    signature: createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")
  };
}
