import {
  createStripeClient,
  StripeApiError
} from "@dustwave/worker-core/stripe";

import type { PodcastEnv } from "./env";

export function createPodcastStripeClient(env: PodcastEnv) {
  return createStripeClient(env.STRIPE_SECRET_KEY || "", {
    userAgent: "dust-wave-podcast/0.2.0",
    onRequest(event) {
      console.log(JSON.stringify({
        level: event.success ? "info" : "warn",
        event: "stripe_api_request",
        method: event.method,
        path: event.path,
        status: event.status,
        success: event.success,
        requestId: event.requestId,
        errorType: event.errorType,
        errorCode: event.errorCode
      }));
    }
  });
}

export function stripeErrorStatus(error: unknown): 502 | 503 {
  return error instanceof StripeApiError && error.retryable ? 503 : 502;
}

export function logStripeBoundaryError(
  event: string,
  error: unknown
): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    type: error instanceof StripeApiError ? error.type : "invalid_response",
    code: error instanceof StripeApiError ? error.code : "",
    status: error instanceof StripeApiError ? error.statusCode : 0,
    requestId: error instanceof StripeApiError ? error.requestId : "",
    retryable: error instanceof StripeApiError ? error.retryable : false
  }));
}

export function validStripeId(
  value: unknown,
  prefix: "cus" | "cs" | "bpc" | "txr"
): string {
  const text = String(value ?? "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{6,128}$`).test(text)) {
    throw new Error("Invalid Stripe object identifier");
  }
  return text;
}
