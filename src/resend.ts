import type { PodcastEnv } from "./env";
import { fetchWithTimeout } from "./fetch-with-timeout";
import type { LoginLanguage } from "./passwordless-security";

const RESEND_EMAIL_URL = "https://api.resend.com/emails";
const RESEND_EMAIL_PATHS = new Set(["/emails", "/emails/"]);
const RESEND_TIMEOUT_MS = 8_000;

export type MagicLinkDelivery = {
  sent: boolean;
  providerId?: string;
  providerStatus?: number;
  diagnosticCode?:
    | "fetch_exception"
    | "fetch_header_invalid"
    | "fetch_network_error"
    | "fetch_redirect_rejected"
    | "fetch_type_error"
    | "fetch_url_invalid";
  failureCode?:
    | "not_configured"
    | "provider_rejected"
    | "provider_timeout"
    | "provider_unavailable";
};

export async function sendAdminMagicLink(
  env: PodcastEnv,
  {
    email,
    loginUrl,
    language,
    deliveryKey
  }: {
    email: string;
    loginUrl: string;
    language: LoginLanguage;
    deliveryKey: string;
  }
): Promise<MagicLinkDelivery> {
  return sendMagicLink(env, {
    audience: "admin",
    email,
    loginUrl,
    language,
    deliveryKey
  });
}

export async function sendListenerMagicLink(
  env: PodcastEnv,
  {
    email,
    loginUrl,
    language,
    deliveryKey
  }: {
    email: string;
    loginUrl: string;
    language: LoginLanguage;
    deliveryKey: string;
  }
): Promise<MagicLinkDelivery> {
  return sendMagicLink(env, {
    audience: "listener",
    email,
    loginUrl,
    language,
    deliveryKey
  });
}

async function sendMagicLink(
  env: PodcastEnv,
  {
    audience,
    email,
    loginUrl,
    language,
    deliveryKey
  }: {
    audience: "admin" | "listener";
    email: string;
    loginUrl: string;
    language: LoginLanguage;
    deliveryKey: string;
  }
): Promise<MagicLinkDelivery> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, failureCode: "not_configured" };
  }
  const spanish = language === "es";
  const listener = audience === "listener";
  const subject = spanish
    ? listener
      ? "Tu enlace de escucha de Dust Wave Podcasts"
      : "Tu enlace de acceso a Dust Wave Podcasts"
    : listener
      ? "Your Dust Wave Podcasts listener sign-in link"
      : "Your Dust Wave Podcasts sign-in link";
  const action = spanish
    ? listener ? "Abrir mi cuenta de podcasts" : "Acceder a Podcasts"
    : listener ? "Open my podcast account" : "Sign in to Podcasts";
  const explanation = spanish
    ? "Este enlace vence en 15 minutos y solo puede usarse una vez."
    : "This link expires in 15 minutes and can only be used once.";
  const body = JSON.stringify({
    from: env.PODCAST_EMAIL_FROM || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
    to: [email],
    subject,
    text: `${action}: ${loginUrl}\n\n${explanation}`,
    html: `<p><a href="${escapeAttribute(loginUrl)}">${action}</a></p><p>${explanation}</p>`
  });
  const requestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `podcast-${audience}-login/${deliveryKey}`
    },
    body,
    redirect: "manual"
  } satisfies RequestInit;
  try {
    let response = await fetchWithTimeout(
      RESEND_EMAIL_URL,
      requestInit,
      RESEND_TIMEOUT_MS
    );
    if (response.status === 307 || response.status === 308) {
      const redirectUrl = trustedResendRedirect(
        response.headers.get("location")
      );
      await response.body?.cancel();
      if (!redirectUrl) {
        return {
          sent: false,
          providerStatus: response.status,
          failureCode: "provider_rejected",
          diagnosticCode: "fetch_redirect_rejected"
        };
      }
      response = await fetchWithTimeout(
        redirectUrl,
        requestInit,
        RESEND_TIMEOUT_MS
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return {
        sent: false,
        providerStatus: response.status,
        failureCode: "provider_rejected",
        diagnosticCode: "fetch_redirect_rejected"
      };
    }
    const payload = await response.json().catch(() => ({})) as {
      id?: string;
    };
    if (!response.ok) {
      return {
        sent: false,
        providerStatus: response.status,
        failureCode: "provider_rejected"
      };
    }
    return {
      sent: true,
      ...(payload.id ? { providerId: payload.id } : {})
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return {
        sent: false,
        failureCode: "provider_timeout"
      };
    }
    return {
      sent: false,
      failureCode: "provider_unavailable",
      diagnosticCode: providerDiagnosticCode(error)
    };
  }
}

function trustedResendRedirect(value: string | null): string | null {
  try {
    const url = new URL(String(value ?? ""), RESEND_EMAIL_URL);
    return url.origin === "https://api.resend.com"
      && RESEND_EMAIL_PATHS.has(url.pathname)
      && !url.username
      && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function providerDiagnosticCode(
  error: unknown
): NonNullable<MagicLinkDelivery["diagnosticCode"]> {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : "";
  if (message.includes("redirect")) return "fetch_redirect_rejected";
  if (message.includes("header")) return "fetch_header_invalid";
  if (message.includes("network") || message.includes("fetch failed")) {
    return "fetch_network_error";
  }
  if (message.includes("url")) return "fetch_url_invalid";
  return error instanceof TypeError
    ? "fetch_type_error"
    : "fetch_exception";
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
