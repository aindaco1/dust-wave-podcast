import {
  hmacSha256,
  sha256Hex
} from "@dustwave/worker-core/crypto";

import { requireAdmin } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const MARKETING_ROLES = ["super_admin", "admin", "producer"] as const;

export type PodcastAnnouncement = {
  language: "en" | "es";
  subject: string;
  heading: string;
  bodyMarkdown: string;
  ctaLabel: string;
  ctaUrl: string;
};

export type EligibleAudienceRow = {
  listener_id: string;
  destination_hash: string;
  updated_at: string;
  entitlement_updated_at: string;
};

export type AnnouncementDeliveryMode = "disabled" | "dry_run" | "live";

export const ELIGIBLE_ANNOUNCEMENT_AUDIENCE_SQL = `
  FROM show_notification_preferences p
  JOIN listener_accounts l
    ON l.id = p.listener_id
  JOIN subscriptions s
    ON s.listener_id = p.listener_id
   AND s.show_id = p.show_id
  WHERE
    p.show_id = ?
    AND p.language = ?
    AND p.announcements_enabled = 1
    AND p.withdrawn_at IS NULL
    AND p.unsubscribe_token_hash IS NOT NULL
    AND l.email_ciphertext LIKE 'aes-gcm-v1:%'
    AND s.status = 'active'
    AND (
      s.current_period_end IS NULL
      OR s.current_period_end > ${SQL_UTC_NOW_RFC3339}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM podcast_announcement_suppressions x
      WHERE x.destination_hash = l.email_lookup_hash
    )`;

export async function dryRunAdminMarketingAnnouncement(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...MARKETING_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request, 64_000);
  const message = normalizePodcastAnnouncement(body, env.SITE_ORIGIN);
  const result = await buildPodcastAnnouncementDryRun(
    env.DB,
    showId,
    message,
    env.ADMIN_SESSION_SECRET || "",
    announcementDeliveryMode(env.ANNOUNCEMENT_DELIVERY_MODE)
  );
  if (!result) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, result);
}

export function normalizePodcastAnnouncement(
  body: Record<string, unknown>,
  siteOrigin: string
): PodcastAnnouncement {
  const language = String(body.language ?? "en").trim().toLowerCase();
  if (!["en", "es"].includes(language)) {
    throw new RequestValidationError("language must be en or es");
  }
  const subject = requiredText(body.subject, "subject", 160);
  const heading = optionalText(body.heading, "heading", 160);
  const bodyMarkdown = requiredText(
    body.bodyMarkdown,
    "bodyMarkdown",
    10_000
  );
  const ctaLabel = optionalText(body.ctaLabel, "ctaLabel", 80);
  const ctaUrl = normalizeSameSiteCtaUrl(body.ctaUrl, siteOrigin);
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl)) {
    throw new RequestValidationError(
      "ctaLabel and ctaUrl must be provided together"
    );
  }
  return {
    language: language as "en" | "es",
    subject,
    heading,
    bodyMarkdown,
    ctaLabel,
    ctaUrl
  };
}

export async function buildPodcastAnnouncementDryRun(
  db: D1Database,
  showId: string,
  message: PodcastAnnouncement,
  revisionSecret: string,
  deliveryMode: AnnouncementDeliveryMode = "disabled"
): Promise<Record<string, unknown> | null> {
  if (!revisionSecret) {
    throw new RequestValidationError(
      "announcement review is not configured"
    );
  }
  const show = await db
    .prepare(
      `SELECT id, slug, title, canonical_url
       FROM shows
       WHERE id = ? AND status != 'archived'`
    )
    .bind(showId)
    .first<{
      id: string;
      slug: string;
      title: string;
      canonical_url: string;
    }>();
  if (!show) return null;
  const audience = await loadEligibleAnnouncementAudience(
    db,
    showId,
    message.language
  );
  const audienceRevision = await announcementAudienceRevision(
    showId,
    message.language,
    audience,
    revisionSecret
  );
  const announcementRevision = await sha256Hex(
    JSON.stringify({
      showId,
      language: message.language,
      subject: message.subject,
      heading: message.heading,
      bodyMarkdown: message.bodyMarkdown,
      ctaLabel: message.ctaLabel,
      ctaUrl: message.ctaUrl
    })
  );
  const reviewHash = await hmacSha256(
    `podcast-marketing-review-v1\0${announcementRevision}:${audienceRevision}`,
    revisionSecret,
    "hex"
  );
  return {
    dryRun: true,
    reviewOnly: true,
    approvalRequired: true,
    sendEnabled: deliveryMode !== "disabled",
    ...(deliveryMode === "disabled"
      ? { sendBlockedReason: "announcement_delivery_disabled" }
      : {}),
    deliveryMode,
    deliveryProvider: "resend",
    consentPolicy: "explicit_show_opt_in",
    eligibleRecipientCount: audience.length,
    audienceRevision,
    announcementRevision,
    reviewHash,
    show: {
      id: show.id,
      slug: show.slug,
      title: show.title,
      canonicalUrl: show.canonical_url
    },
    preview: message
  };
}

export async function loadEligibleAnnouncementAudience(
  db: D1Database,
  showId: string,
  language: "en" | "es"
): Promise<EligibleAudienceRow[]> {
  const audience = await db
    .prepare(
      `SELECT
         p.listener_id,
         l.email_lookup_hash AS destination_hash,
         p.updated_at,
         s.updated_at AS entitlement_updated_at
       ${ELIGIBLE_ANNOUNCEMENT_AUDIENCE_SQL}
       ORDER BY p.listener_id`
    )
    .bind(showId, language)
    .all<EligibleAudienceRow>();
  return audience.results;
}

export async function announcementAudienceRevision(
  showId: string,
  language: "en" | "es",
  audience: EligibleAudienceRow[],
  revisionSecret: string
): Promise<string> {
  return hmacSha256(
    `podcast-marketing-audience-v1\0${showId}\0${language}\0${
      audience.map((row) => [
        row.listener_id,
        row.destination_hash,
        row.updated_at,
        row.entitlement_updated_at
      ].join(":")).join("\n")
    }`,
    revisionSecret,
    "hex"
  );
}

export function announcementDeliveryMode(
  value: string | undefined
): AnnouncementDeliveryMode {
  const mode = String(value ?? "disabled").trim().toLowerCase();
  return mode === "dry_run" || mode === "live" ? mode : "disabled";
}

function normalizeSameSiteCtaUrl(
  value: unknown,
  siteOrigin: string
): string {
  const raw = optionalText(value, "ctaUrl", 2_048);
  if (!raw) return "";
  let url;
  let allowedOrigin;
  try {
    url = new URL(raw);
    allowedOrigin = new URL(siteOrigin).origin;
  } catch {
    throw new RequestValidationError(
      "ctaUrl must be an absolute same-site URL"
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.origin !== allowedOrigin
  ) {
    throw new RequestValidationError(
      "ctaUrl must be an absolute same-site URL"
    );
  }
  return url.toString();
}
