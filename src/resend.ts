import type { PodcastEnv } from "./env";
import type { LoginLanguage } from "./passwordless-security";

export type MagicLinkDelivery = {
  sent: boolean;
  providerId?: string;
  providerStatus?: number;
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
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": `podcast-${audience}-login/${deliveryKey}`
      },
      body: JSON.stringify({
        from: env.PODCAST_EMAIL_FROM || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
        to: [email],
        subject,
        text: `${action}: ${loginUrl}\n\n${explanation}`,
        html: `<p><a href="${escapeAttribute(loginUrl)}">${action}</a></p><p>${explanation}</p>`
      }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
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
    return {
      sent: false,
      failureCode:
        name === "AbortError" || name === "TimeoutError"
          ? "provider_timeout"
          : "provider_unavailable"
    };
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
