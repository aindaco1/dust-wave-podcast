import type { PodcastEnv } from "./env";

type LoginLanguage = "en" | "es";

export async function sendAdminMagicLink(
  env: PodcastEnv,
  {
    email,
    loginUrl,
    language
  }: { email: string; loginUrl: string; language: LoginLanguage }
): Promise<{ sent: boolean; providerId?: string }> {
  if (!env.RESEND_API_KEY) return { sent: false };
  const spanish = language === "es";
  const subject = spanish
    ? "Tu enlace de acceso a Dust Wave Podcasts"
    : "Your Dust Wave Podcasts sign-in link";
  const action = spanish ? "Acceder a Podcasts" : "Sign in to Podcasts";
  const explanation = spanish
    ? "Este enlace vence en 15 minutos y solo puede usarse una vez."
    : "This link expires in 15 minutes and can only be used once.";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: env.PODCAST_EMAIL_FROM || "Dust Wave Podcasts <podcasts@dustwave.xyz>",
      to: [email],
      subject,
      text: `${action}: ${loginUrl}\n\n${explanation}`,
      html: `<p><a href="${escapeAttribute(loginUrl)}">${action}</a></p><p>${explanation}</p>`
    })
  });
  const payload = await response.json().catch(() => ({})) as { id?: string };
  return {
    sent: response.ok,
    ...(response.ok && payload.id ? { providerId: payload.id } : {})
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
