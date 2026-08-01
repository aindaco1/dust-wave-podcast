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

export async function sendPodcastAnnouncementEmail(
  env: PodcastEnv,
  {
    bodyMarkdown,
    ctaLabel,
    ctaUrl,
    deliveryId,
    deliveryKey,
    email,
    heading,
    subject,
    unsubscribeUrl
  }: {
    bodyMarkdown: string;
    ctaLabel: string;
    ctaUrl: string;
    deliveryId: string;
    deliveryKey: string;
    email: string;
    heading: string;
    subject: string;
    unsubscribeUrl: string;
  }
): Promise<MagicLinkDelivery> {
  const textBody = markdownToPlainText(bodyMarkdown);
  const text = [
    heading,
    textBody,
    ctaLabel && ctaUrl ? `${ctaLabel}: ${ctaUrl}` : "",
    `Unsubscribe: ${unsubscribeUrl}`
  ].filter(Boolean).join("\n\n");
  const html = [
    heading ? `<h1>${escapeHtml(heading)}</h1>` : "",
    markdownToSafeHtml(bodyMarkdown),
    ctaLabel && ctaUrl
      ? `<p><a href="${escapeAttribute(ctaUrl)}">${escapeHtml(ctaLabel)}</a></p>`
      : "",
    `<p><a href="${escapeAttribute(unsubscribeUrl)}">Unsubscribe / Cancelar suscripción</a></p>`
  ].filter(Boolean).join("");
  return sendResendPayload(
    env,
    {
      from:
        env.PODCAST_EMAIL_FROM
        || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
      to: [email],
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      },
      tags: [
        { name: "podcast_delivery", value: safeTagValue(deliveryId) },
        { name: "category", value: "announcement" }
      ]
    },
    `podcast-announcement/${deliveryKey}`
  );
}

export async function sendAdminActionMagicLink(
  env: PodcastEnv,
  {
    actionKind,
    deliveryKey,
    email,
    loginUrl
  }: {
    actionKind:
      | "delivery_audio_approval"
      | "transcript_review"
      | "working_master_decision";
    deliveryKey: string;
    email: string;
    loginUrl: string;
  }
): Promise<MagicLinkDelivery> {
  const copy = adminActionCopy(actionKind);
  const subject = copy.subject;
  const text = [
    copy.english,
    copy.spanish,
    `${copy.action}: ${loginUrl}`,
    "This single-use link expires 15 minutes after it was issued.",
    "Este enlace de un solo uso vence 15 minutos después de su emisión."
  ].join("\n\n");
  const html = [
    `<p>${copy.english}</p>`,
    `<p>${copy.spanish}</p>`,
    `<p><a href="${escapeAttribute(loginUrl)}">${copy.action}</a></p>`,
    "<p>This single-use link expires 15 minutes after it was issued.<br>",
    "Este enlace de un solo uso vence 15 minutos después de su emisión.</p>"
  ].join("");
  return sendResendPayload(
    env,
    {
      from:
        env.PODCAST_EMAIL_FROM
        || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
      to: [email],
      subject,
      text,
      html,
      tags: [{ name: "category", value: "admin_action" }]
    },
    `podcast-admin-action/${deliveryKey}`
  );
}

function adminActionCopy(
  actionKind:
    | "delivery_audio_approval"
    | "transcript_review"
    | "working_master_decision"
): {
  subject: string;
  english: string;
  spanish: string;
  action: string;
} {
  if (actionKind === "delivery_audio_approval") {
    return {
      subject:
        "Podcast audio ready for review / Audio del podcast listo para revisión",
      english:
        "The normalized podcast audio and player waveform passed their evidence checks and need final review.",
      spanish:
        "El audio normalizado y la forma de onda del podcast aprobaron sus controles y necesitan revisión final.",
      action: "Review audio / Revisar audio"
    };
  }
  if (actionKind === "transcript_review") {
    return {
      subject:
        "Podcast transcript ready for review / Transcripción del podcast lista para revisión",
      english:
        "The source-language podcast transcript is ready for editorial and speaker-label review.",
      spanish:
        "La transcripción del podcast en el idioma original está lista para revisión editorial y de hablantes.",
      action: "Review transcript / Revisar transcripción"
    };
  }
  return {
    subject:
      "Podcast master ready for review / Máster del podcast listo para revisión",
    english:
      "A full enhanced podcast master passed its quality gate and needs your decision.",
    spanish:
      "Un máster completo y mejorado del podcast aprobó el control de calidad y necesita tu decisión.",
    action: "Review and decide / Revisar y decidir"
  };
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
  return sendResendPayload(env, {
    from: env.PODCAST_EMAIL_FROM || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
    to: [email],
    subject,
    text: `${action}: ${loginUrl}\n\n${explanation}`,
    html: `<p><a href="${escapeAttribute(loginUrl)}">${action}</a></p><p>${explanation}</p>`
  }, `podcast-${audience}-login/${deliveryKey}`);
}

async function sendResendPayload(
  env: PodcastEnv,
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<MagicLinkDelivery> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, failureCode: "not_configured" };
  }
  const body = JSON.stringify(payload);
  const requestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
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
    const providerPayload = await readBoundedProviderResponse(response);
    if (!response.ok) {
      return {
        sent: false,
        providerStatus: response.status,
        failureCode: "provider_rejected"
      };
    }
    return {
      sent: true,
      ...(providerPayload.id ? { providerId: providerPayload.id } : {})
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

async function readBoundedProviderResponse(
  response: Response
): Promise<{ id?: string }> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32_768) {
        await reader.cancel("provider_response_too_large").catch(() => {});
        return {};
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? { id: id.slice(0, 160) } : {};
  } catch {
    return {};
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

function escapeHtml(value: string): string {
  return escapeAttribute(value).replace(/'/g, "&#39;");
}

function markdownToPlainText(value: string): string {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/[*_~`>#]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownToSafeHtml(value: string): string {
  return markdownToPlainText(value)
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) =>
      `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

function safeTagValue(value: string): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 256) || "none";
}
