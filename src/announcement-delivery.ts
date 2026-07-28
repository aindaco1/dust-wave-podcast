import {
  hmacSha256,
  normalizeEmail,
  sha256Hex,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { prepareAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  announcementAudienceRevision,
  announcementDeliveryMode,
  buildPodcastAnnouncementDryRun,
  ELIGIBLE_ANNOUNCEMENT_AUDIENCE_SQL,
  normalizePodcastAnnouncement
} from "./marketing";
import {
  notificationUnsubscribeToken,
  notificationUnsubscribeTokenHash,
  openNotificationDestination
} from "./notification-destination";
import { isValidEmailAddress } from "./passwordless-security";
import { sendPodcastAnnouncementEmail } from "./resend";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import type { PodcastJob } from "./types";
import {
  boundedPageSize,
  readBoundedText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const ANNOUNCEMENT_ADMIN_ROLES = ["super_admin", "admin"] as const;
const ANNOUNCEMENT_READ_ROLES = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
] as const;
const TERMINAL_DELIVERY_STATUSES = [
  "accepted",
  "delivered",
  "dry_run",
  "suppressed",
  "failed",
  "canceled"
] as const;

type AnnouncementRow = {
  id: string;
  show_id: string;
  revision: number;
  language: "en" | "es";
  subject: string;
  heading: string;
  body_markdown: string;
  cta_label: string;
  cta_url: string;
  announcement_revision: string;
  audience_revision: string;
  review_hash: string;
  eligible_recipient_count: number;
  delivery_mode: "dry_run" | "live";
  status: string;
  approved_at: string;
  completed_at: string | null;
  created_at: string;
  pending_count: number;
  accepted_count: number;
  delivered_count: number;
  dry_run_count: number;
  suppressed_count: number;
  failed_count: number;
};

type DeliveryRow = {
  id: string;
  announcement_id: string;
  listener_id: string;
  show_id: string;
  delivery_mode: "dry_run" | "live";
  language: "en" | "es";
  subject: string;
  heading: string;
  body_markdown: string;
  cta_label: string;
  cta_url: string;
  destination_hash: string;
  email_lookup_hash: string;
  email_ciphertext: string;
  announcements_enabled: number;
  withdrawn_at: string | null;
  unsubscribe_token_hash: string | null;
  preference_updated_at: string;
  current_preference_updated_at: string;
  entitlement_updated_at: string;
  current_entitlement_updated_at: string;
  entitlement_active: number;
  globally_suppressed: number;
  status: string;
  attempt_count: number;
};

export async function approveAdminMarketingAnnouncement(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...ANNOUNCEMENT_ADMIN_ROLES],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  const deliveryMode = announcementDeliveryMode(
    env.ANNOUNCEMENT_DELIVERY_MODE
  );
  if (deliveryMode === "disabled") {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_delivery_disabled" },
      { status: 503 }
    );
  }
  if (!env.ADMIN_SESSION_SECRET) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_review_not_configured" },
      { status: 503 }
    );
  }
  if (
    deliveryMode === "live"
    && (
      !env.ANNOUNCEMENT_DESTINATION_SECRET
      || !env.LISTENER_EMAIL_LOOKUP_PEPPER
      || !env.RESEND_API_KEY
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_provider_not_configured" },
      { status: 503 }
    );
  }
  const body = await readJsonObject(request, 64_000);
  const expectedReviewHash = requiredText(
    body.reviewHash,
    "reviewHash",
    64
  );
  if (!/^[a-f0-9]{64}$/.test(expectedReviewHash)) {
    throw new RequestValidationError("reviewHash is invalid");
  }
  const message = normalizePodcastAnnouncement(body, env.SITE_ORIGIN);
  const review = await buildPodcastAnnouncementDryRun(
    env.DB,
    showId,
    message,
    env.ADMIN_SESSION_SECRET,
    deliveryMode
  ) as {
    audienceRevision: string;
    announcementRevision: string;
    eligibleRecipientCount: number;
    reviewHash: string;
  } | null;
  if (!review) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  if (!timingSafeEqual(expectedReviewHash, review.reviewHash)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_review_changed" },
      { status: 409 }
    );
  }
  if (review.eligibleRecipientCount < 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_audience_empty" },
      { status: 409 }
    );
  }

  const existing = await loadAnnouncementByReviewHash(
    env.DB,
    showId,
    review.reviewHash
  );
  if (existing) {
    if (existing.status === "canceled") {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "announcement_review_changed" },
        { status: 409 }
      );
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      announcement: presentAnnouncement(existing),
      idempotent: true
    });
  }
  const announcementId = `announcement_${
    crypto.randomUUID().replace(/-/g, "")
  }`;
  const adminUserId = auth.authorization.identity.id;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO podcast_announcements (
           id,
           show_id,
           revision,
           language,
           subject,
           heading,
           body_markdown,
           cta_label,
           cta_url,
           announcement_revision,
           audience_revision,
           review_hash,
           eligible_recipient_count,
           delivery_mode,
           status,
           created_by_admin_user_id,
           approved_by_admin_user_id
         ) VALUES (
           ?,
           ?,
           (
             SELECT COALESCE(MAX(revision), 0) + 1
             FROM podcast_announcements
             WHERE show_id = ?
           ),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?
         )`
      ).bind(
        announcementId,
        showId,
        showId,
        message.language,
        message.subject,
        message.heading,
        message.bodyMarkdown,
        message.ctaLabel,
        message.ctaUrl,
        review.announcementRevision,
        review.audienceRevision,
        review.reviewHash,
        review.eligibleRecipientCount,
        deliveryMode,
        adminUserId,
        adminUserId
      ),
      env.DB.prepare(
        `INSERT INTO podcast_announcement_deliveries (
           id,
           announcement_id,
           listener_id,
           destination_hash,
           preference_updated_at,
           entitlement_updated_at
         )
         SELECT
           'delivery_' || lower(hex(randomblob(16))),
           ?,
           p.listener_id,
           l.email_lookup_hash,
           p.updated_at,
           s.updated_at
         ${ELIGIBLE_ANNOUNCEMENT_AUDIENCE_SQL}
         ORDER BY p.listener_id`
      ).bind(announcementId, showId, message.language),
      prepareAdminAudit(env.DB, {
        adminUserId,
        action: "marketing.announcement_approved",
        targetType: "podcast_announcement",
        targetId: announcementId,
        metadata: {
          showId,
          language: message.language,
          deliveryMode,
          eligibleRecipientCount: review.eligibleRecipientCount,
          announcementRevision: review.announcementRevision,
          audienceRevision: review.audienceRevision
        }
      })
    ]);
  } catch (error) {
    const replay = await loadAnnouncementByReviewHash(
      env.DB,
      showId,
      review.reviewHash
    );
    if (!replay) throw error;
    return privateJson(request, env.ALLOWED_ORIGINS, {
      announcement: presentAnnouncement(replay),
      idempotent: true
    });
  }

  const approvedAudience = await loadAnnouncementDeliveryAudience(
    env.DB,
    announcementId
  );
  const approvedAudienceRevision = await announcementAudienceRevision(
    showId,
    message.language,
    approvedAudience,
    env.ADMIN_SESSION_SECRET
  );
  if (!timingSafeEqual(
    review.audienceRevision,
    approvedAudienceRevision
  )) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE podcast_announcement_deliveries
         SET
           status = 'canceled',
           last_error_code = 'announcement_review_changed',
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE announcement_id = ?
           AND status = 'pending'`
      ).bind(announcementId),
      env.DB.prepare(
        `UPDATE podcast_announcements
         SET
           status = 'canceled',
           completed_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(announcementId),
      prepareAdminAudit(env.DB, {
        adminUserId,
        action: "marketing.announcement_audience_changed",
        targetType: "podcast_announcement",
        targetId: announcementId,
        metadata: {
          showId,
          language: message.language,
          deliveryMode
        }
      })
    ]);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "announcement_review_changed" },
      { status: 409 }
    );
  }

  let queueAccepted = true;
  try {
    await queuePendingAnnouncementDeliveries(env, {
      announcementId,
      limit: 100
    });
  } catch (error) {
    queueAccepted = false;
    console.error(JSON.stringify({
      level: "error",
      event: "announcement_queue_failed",
      announcementId,
      showId,
      errorName: error instanceof Error ? error.name : "UnknownError"
    }));
  }
  const announcement = await loadAnnouncementById(env.DB, announcementId);
  if (!announcement) throw new Error("announcement_projection_failed");
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      announcement: presentAnnouncement(announcement),
      idempotent: false,
      queueAccepted
    },
    { status: 202 }
  );
}

export async function listAdminMarketingAnnouncements(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...ANNOUNCEMENT_READ_ROLES],
    showId
  });
  if (!auth.ok) return auth.response;
  const limit = boundedPageSize(
    new URL(request.url).searchParams.get("limit"),
    20,
    100
  );
  const rows = await env.DB.prepare(
    `${announcementSelect("WHERE a.show_id = ?")}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ?`
  ).bind(showId, limit).all<AnnouncementRow>();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    deliveryMode: announcementDeliveryMode(env.ANNOUNCEMENT_DELIVERY_MODE),
    announcements: rows.results.map(presentAnnouncement)
  });
}

export async function schedulePendingAnnouncementDeliveries(
  env: PodcastEnv
): Promise<void> {
  await env.DB.prepare(
    `UPDATE podcast_announcement_deliveries
     SET
       status = 'retry',
       next_attempt_at = datetime('now'),
       last_error_code = 'processing_lease_expired',
       updated_at = datetime('now')
     WHERE status = 'sending'
       AND last_attempt_at <= datetime('now', '-15 minutes')`
  ).run();
  await queuePendingAnnouncementDeliveries(env, { limit: 100 });
}

export async function processAnnouncementDelivery(
  env: PodcastEnv,
  job: PodcastJob
): Promise<void> {
  const deliveryId = job.announcementDeliveryId;
  if (!deliveryId) throw new Error("Announcement job is missing deliveryId");
  let delivery = await loadDelivery(env.DB, deliveryId);
  if (!delivery) return;
  if (
    delivery.show_id !== job.showId
    || delivery.announcement_id !== job.announcementId
  ) {
    throw new Error("Announcement job does not match durable state");
  }
  if (TERMINAL_DELIVERY_STATUSES.includes(
    delivery.status as typeof TERMINAL_DELIVERY_STATUSES[number]
  )) {
    return;
  }
  const claim = await env.DB.prepare(
    `UPDATE podcast_announcement_deliveries
     SET
       status = 'sending',
       attempt_count = attempt_count + 1,
       first_attempt_at = COALESCE(first_attempt_at, datetime('now')),
       last_attempt_at = datetime('now'),
       last_error_code = NULL,
       updated_at = datetime('now')
     WHERE id = ?
       AND status IN ('pending', 'queued', 'retry')
       AND next_attempt_at <= datetime('now')`
  ).bind(deliveryId).run();
  if (Number(claim.meta.changes ?? 0) !== 1) return;
  delivery = await loadDelivery(env.DB, deliveryId);
  if (!delivery) return;

  if (delivery.delivery_mode === "dry_run") {
    await completeDelivery(env.DB, deliveryId, "dry_run", null, null);
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  if (
    announcementDeliveryMode(env.ANNOUNCEMENT_DELIVERY_MODE) !== "live"
    || !env.ANNOUNCEMENT_DESTINATION_SECRET
    || !env.LISTENER_EMAIL_LOOKUP_PEPPER
    || !env.RESEND_API_KEY
  ) {
    await retryDelivery(
      env.DB,
      deliveryId,
      delivery.attempt_count,
      "announcement_provider_not_configured"
    );
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  if (!deliveryStillEligible(delivery)) {
    await completeDelivery(
      env.DB,
      deliveryId,
      "suppressed",
      null,
      "consent_or_entitlement_changed"
    );
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  const email = await openNotificationDestination(
    delivery.email_ciphertext,
    delivery.listener_id,
    env.ANNOUNCEMENT_DESTINATION_SECRET
  );
  if (!email || !isValidEmailAddress(email)) {
    await completeDelivery(
      env.DB,
      deliveryId,
      "failed",
      null,
      "notification_destination_invalid"
    );
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  const destinationHash = await hmacSha256(
    normalizeEmail(email),
    env.LISTENER_EMAIL_LOOKUP_PEPPER,
    "hex"
  );
  if (!timingSafeEqual(destinationHash, delivery.destination_hash)) {
    await completeDelivery(
      env.DB,
      deliveryId,
      "failed",
      null,
      "notification_destination_mismatch"
    );
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  const unsubscribeToken = await notificationUnsubscribeToken(
    delivery.listener_id,
    delivery.show_id,
    env.ANNOUNCEMENT_DESTINATION_SECRET
  );
  const unsubscribeTokenHash = await notificationUnsubscribeTokenHash(
    unsubscribeToken
  );
  if (
    !delivery.unsubscribe_token_hash
    || !timingSafeEqual(
      unsubscribeTokenHash,
      delivery.unsubscribe_token_hash
    )
  ) {
    await completeDelivery(
      env.DB,
      deliveryId,
      "failed",
      null,
      "unsubscribe_token_mismatch"
    );
    await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
    return;
  }
  const unsubscribeUrl = `${
    env.FEED_ORIGIN.replace(/\/$/, "")
  }/v1/notifications/unsubscribe/${unsubscribeToken}`;
  const result = await sendPodcastAnnouncementEmail(env, {
    bodyMarkdown: delivery.body_markdown,
    ctaLabel: delivery.cta_label,
    ctaUrl: delivery.cta_url,
    deliveryId,
    deliveryKey: deliveryId,
    email,
    heading: delivery.heading,
    subject: delivery.subject,
    unsubscribeUrl
  });
  if (result.sent) {
    await completeDelivery(
      env.DB,
      deliveryId,
      "accepted",
      result.providerId ?? null,
      null
    );
  } else if (
    result.failureCode === "provider_timeout"
    || result.failureCode === "provider_unavailable"
    || result.failureCode === "not_configured"
    || result.providerStatus === 409
    || result.providerStatus === 429
    || Number(result.providerStatus ?? 0) >= 500
  ) {
    await retryDelivery(
      env.DB,
      deliveryId,
      delivery.attempt_count,
      result.failureCode ?? "provider_retryable"
    );
  } else {
    await completeDelivery(
      env.DB,
      deliveryId,
      "failed",
      null,
      result.failureCode ?? "provider_rejected"
    );
  }
  await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
}

export async function serveAnnouncementUnsubscribe(
  request: Request,
  env: PodcastEnv,
  tokenValue: string
): Promise<Response> {
  const token = String(tokenValue ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return unsubscribeNotFound();
  }
  const tokenHash = await notificationUnsubscribeTokenHash(token);
  const preference = await env.DB.prepare(
    `SELECT
       p.listener_id,
       p.show_id,
       p.language,
       p.announcements_enabled,
       l.email_lookup_hash AS destination_hash,
       s.title AS show_title
     FROM show_notification_preferences p
     JOIN listener_accounts l ON l.id = p.listener_id
     JOIN shows s ON s.id = p.show_id
     WHERE p.unsubscribe_token_hash = ?`
  ).bind(tokenHash).first<{
    listener_id: string;
    show_id: string;
    language: "en" | "es";
    announcements_enabled: number;
    destination_hash: string;
    show_title: string;
  }>();
  if (!preference) return unsubscribeNotFound();
  if (request.method === "GET" || request.method === "HEAD") {
    const spanish = preference.language === "es";
    const title = spanish ? "Cancelar avisos" : "Unsubscribe";
    const explanation = spanish
      ? `Dejarás de recibir avisos de ${preference.show_title}.`
      : `You will stop receiving announcements from ${preference.show_title}.`;
    const button = spanish ? "Cancelar avisos" : "Unsubscribe";
    const html = `<!doctype html><html lang="${spanish ? "es" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(explanation)}</p><form method="post"><button type="submit">${escapeHtml(button)}</button></form></main></body></html>`;
    return new Response(request.method === "HEAD" ? null : html, {
      headers: publicUnsubscribeHeaders("text/html; charset=utf-8")
    });
  }
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "method_not_allowed" }),
      {
        status: 405,
        headers: publicUnsubscribeHeaders(
          "application/json; charset=utf-8"
        )
      }
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE show_notification_preferences
       SET
         announcements_enabled = 0,
         withdrawn_at = COALESCE(withdrawn_at, datetime('now')),
         updated_at = datetime('now')
       WHERE listener_id = ? AND show_id = ?`
    ).bind(preference.listener_id, preference.show_id),
    env.DB.prepare(
      `UPDATE podcast_announcement_deliveries
       SET
         status = 'suppressed',
         last_error_code = 'listener_unsubscribed',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE listener_id = ?
         AND status IN ('pending', 'queued', 'retry')`
    ).bind(preference.listener_id),
    env.DB.prepare(
      `UPDATE listener_accounts
       SET
         email_ciphertext = 'not_retained:notification_withdrawn:v1',
         updated_at = datetime('now')
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM show_notification_preferences
           WHERE listener_id = ?
             AND show_id != ?
             AND announcements_enabled = 1
             AND withdrawn_at IS NULL
         )`
    ).bind(
      preference.listener_id,
      preference.listener_id,
      preference.show_id
    )
  ]);
  return new Response(null, {
    status: 204,
    headers: publicUnsubscribeHeaders()
  });
}

export async function handleResendWebhook(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) {
    return webhookJson({ error: "resend_webhook_not_configured" }, 503);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return webhookJson({ error: "invalid_content_type" }, 400);
  }
  const rawBody = await readBoundedText(
    request,
    256_000,
    "Resend webhook payload"
  );
  const verified = await verifyResendWebhook(
    rawBody,
    request.headers,
    env.RESEND_WEBHOOK_SECRET
  );
  if (!verified.valid) {
    return webhookJson({ error: "invalid_signature" }, 401);
  }
  const event = await Promise.resolve()
    .then(() => JSON.parse(rawBody) as unknown)
    .catch(() => null);
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return webhookJson({ error: "invalid_payload" }, 400);
  }
  const record = event as Record<string, unknown>;
  const eventType = String(record.type ?? "").slice(0, 80);
  const data = objectValue(record.data);
  const providerId = String(data?.email_id ?? "").slice(0, 160);
  const tags = normalizeWebhookTags(data?.tags);
  const deliveryId = String(tags.podcast_delivery ?? "");
  const marker = await env.DB.prepare(
    `INSERT OR IGNORE INTO podcast_resend_webhook_events (
       id, event_type, provider_id
     ) VALUES (?, ?, ?)`
  ).bind(verified.id, eventType || "unknown", providerId || null).run();
  if (Number(marker.meta.changes ?? 0) !== 1) {
    return webhookJson({ received: true, duplicate: true });
  }
  if (!/^delivery_[a-f0-9]{32}$/.test(deliveryId)) {
    return webhookJson({ received: true, matched: false });
  }
  const delivery = await env.DB.prepare(
    `SELECT announcement_id, destination_hash
     FROM podcast_announcement_deliveries
     WHERE id = ?`
  ).bind(deliveryId).first<{
    announcement_id: string;
    destination_hash: string;
  }>();
  if (!delivery) {
    return webhookJson({ received: true, matched: false });
  }
  const nextStatus = webhookDeliveryStatus(eventType, data);
  if (nextStatus) {
    await env.DB.prepare(
      `UPDATE podcast_announcement_deliveries
       SET
         status = ?,
         provider_id = COALESCE(NULLIF(?, ''), provider_id),
         completed_at = CASE
           WHEN ? IN ('delivered', 'suppressed', 'failed')
           THEN datetime('now')
           ELSE completed_at
         END,
         updated_at = datetime('now')
       WHERE id = ?
         AND status NOT IN ('dry_run', 'canceled')`
    ).bind(nextStatus, providerId, nextStatus, deliveryId).run();
  }
  if (shouldSuppressForWebhook(eventType, data)) {
    await env.DB.prepare(
      `INSERT INTO podcast_announcement_suppressions (
         destination_hash, reason, provider_id, source_event_id
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(destination_hash) DO UPDATE SET
         reason = excluded.reason,
         provider_id = COALESCE(excluded.provider_id, provider_id),
         source_event_id = excluded.source_event_id,
         updated_at = datetime('now')`
    ).bind(
      delivery.destination_hash,
      eventType,
      providerId || null,
      verified.id
    ).run();
  }
  await refreshAnnouncementStatus(env.DB, delivery.announcement_id);
  return webhookJson({ received: true, matched: true });
}

async function queuePendingAnnouncementDeliveries(
  env: PodcastEnv,
  {
    announcementId,
    limit
  }: {
    announcementId?: string;
    limit: number;
  }
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT
       d.id,
       d.announcement_id,
       a.show_id
     FROM podcast_announcement_deliveries d
     JOIN podcast_announcements a ON a.id = d.announcement_id
     WHERE d.status IN ('pending', 'retry', 'queued')
       AND d.next_attempt_at <= datetime('now')
       AND (? IS NULL OR d.announcement_id = ?)
     ORDER BY d.next_attempt_at, d.id
     LIMIT ?`
  ).bind(
    announcementId ?? null,
    announcementId ?? null,
    Math.max(1, Math.min(100, limit))
  ).all<{
    id: string;
    announcement_id: string;
    show_id: string;
  }>();
  if (rows.results.length < 1) return 0;
  await env.JOBS.sendBatch(
    rows.results.map((row) => ({
      body: {
        id: row.id,
        type: "send-announcement",
        showId: row.show_id,
        announcementId: row.announcement_id,
        announcementDeliveryId: row.id,
        requestedAt: new Date().toISOString()
      } satisfies PodcastJob
    }))
  );
  await env.DB.batch(rows.results.map((row) =>
    env.DB.prepare(
      `UPDATE podcast_announcement_deliveries
       SET status = 'queued', updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'retry')`
    ).bind(row.id)
  ));
  return rows.results.length;
}

async function loadDelivery(
  db: D1Database,
  deliveryId: string
): Promise<DeliveryRow | null> {
  return db.prepare(
    `SELECT
       d.id,
       d.announcement_id,
       d.listener_id,
       a.show_id,
       a.delivery_mode,
       a.language,
       a.subject,
       a.heading,
       a.body_markdown,
       a.cta_label,
       a.cta_url,
       d.destination_hash,
       l.email_lookup_hash,
       l.email_ciphertext,
       p.announcements_enabled,
       p.withdrawn_at,
       p.unsubscribe_token_hash,
       d.preference_updated_at,
       p.updated_at AS current_preference_updated_at,
       d.entitlement_updated_at,
       s.updated_at AS current_entitlement_updated_at,
       (
         s.status = 'active'
         AND (
           s.current_period_end IS NULL
           OR s.current_period_end > ${SQL_UTC_NOW_RFC3339}
         )
       ) AS entitlement_active,
       EXISTS (
         SELECT 1
         FROM podcast_announcement_suppressions x
         WHERE x.destination_hash = d.destination_hash
       ) AS globally_suppressed,
       d.status,
       d.attempt_count
     FROM podcast_announcement_deliveries d
     JOIN podcast_announcements a ON a.id = d.announcement_id
     JOIN listener_accounts l ON l.id = d.listener_id
     JOIN show_notification_preferences p
       ON p.listener_id = d.listener_id
      AND p.show_id = a.show_id
     JOIN subscriptions s
       ON s.listener_id = d.listener_id
      AND s.show_id = a.show_id
     WHERE d.id = ?`
  ).bind(deliveryId).first<DeliveryRow>();
}

async function loadAnnouncementDeliveryAudience(
  db: D1Database,
  announcementId: string
): Promise<Array<{
  listener_id: string;
  destination_hash: string;
  updated_at: string;
  entitlement_updated_at: string;
}>> {
  const rows = await db.prepare(
    `SELECT
       listener_id,
       destination_hash,
       preference_updated_at AS updated_at,
       entitlement_updated_at
     FROM podcast_announcement_deliveries
     WHERE announcement_id = ?
     ORDER BY listener_id`
  ).bind(announcementId).all<{
    listener_id: string;
    destination_hash: string;
    updated_at: string;
    entitlement_updated_at: string;
  }>();
  return rows.results;
}

function deliveryStillEligible(delivery: DeliveryRow): boolean {
  return delivery.announcements_enabled === 1
    && delivery.withdrawn_at === null
    && delivery.entitlement_active === 1
    && delivery.globally_suppressed === 0
    && delivery.destination_hash === delivery.email_lookup_hash
    && delivery.preference_updated_at
      === delivery.current_preference_updated_at
    && delivery.entitlement_updated_at
      === delivery.current_entitlement_updated_at;
}

async function retryDelivery(
  db: D1Database,
  deliveryId: string,
  attemptCount: number,
  errorCode: string
): Promise<void> {
  const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attemptCount, 8));
  await db.prepare(
    `UPDATE podcast_announcement_deliveries
     SET
       status = CASE WHEN attempt_count >= 8 THEN 'failed' ELSE 'retry' END,
       next_attempt_at = CASE
         WHEN attempt_count >= 8 THEN next_attempt_at
         ELSE datetime('now', ?)
       END,
       last_error_code = ?,
       completed_at = CASE
         WHEN attempt_count >= 8 THEN datetime('now')
         ELSE NULL
       END,
       updated_at = datetime('now')
     WHERE id = ? AND status = 'sending'`
  ).bind(
    `+${delayMinutes} minutes`,
    errorCode.slice(0, 80),
    deliveryId
  ).run();
}

async function completeDelivery(
  db: D1Database,
  deliveryId: string,
  status: "accepted" | "dry_run" | "suppressed" | "failed",
  providerId: string | null,
  errorCode: string | null
): Promise<void> {
  await db.prepare(
    `UPDATE podcast_announcement_deliveries
     SET
       status = ?,
       provider_id = ?,
       last_error_code = ?,
       accepted_at = CASE
         WHEN ? = 'accepted' THEN datetime('now')
         ELSE accepted_at
       END,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status = 'sending'`
  ).bind(
    status,
    providerId,
    errorCode,
    status,
    deliveryId
  ).run();
}

async function refreshAnnouncementStatus(
  db: D1Database,
  announcementId: string
): Promise<void> {
  await db.prepare(
    `UPDATE podcast_announcements
     SET
       status = CASE
         WHEN EXISTS (
           SELECT 1
           FROM podcast_announcement_deliveries
           WHERE announcement_id = podcast_announcements.id
             AND status IN ('pending', 'queued', 'sending', 'retry')
         ) THEN 'processing'
         WHEN EXISTS (
           SELECT 1
           FROM podcast_announcement_deliveries
           WHERE announcement_id = podcast_announcements.id
             AND status = 'failed'
         ) AND EXISTS (
           SELECT 1
           FROM podcast_announcement_deliveries
           WHERE announcement_id = podcast_announcements.id
             AND status IN ('accepted', 'delivered', 'dry_run')
         ) THEN 'partial'
         WHEN EXISTS (
           SELECT 1
           FROM podcast_announcement_deliveries
           WHERE announcement_id = podcast_announcements.id
             AND status = 'failed'
         ) THEN 'failed'
         ELSE 'completed'
       END,
       completed_at = CASE
         WHEN EXISTS (
           SELECT 1
           FROM podcast_announcement_deliveries
           WHERE announcement_id = podcast_announcements.id
             AND status IN ('pending', 'queued', 'sending', 'retry')
         ) THEN NULL
         ELSE COALESCE(completed_at, datetime('now'))
       END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(announcementId).run();
}

async function loadAnnouncementById(
  db: D1Database,
  announcementId: string
): Promise<AnnouncementRow | null> {
  return db.prepare(
    announcementSelect("WHERE a.id = ?")
  ).bind(announcementId).first<AnnouncementRow>();
}

async function loadAnnouncementByReviewHash(
  db: D1Database,
  showId: string,
  reviewHash: string
): Promise<AnnouncementRow | null> {
  return db.prepare(
    announcementSelect("WHERE a.show_id = ? AND a.review_hash = ?")
  ).bind(showId, reviewHash).first<AnnouncementRow>();
}

function announcementSelect(whereClause: string): string {
  return `SELECT
    a.*,
    SUM(CASE WHEN d.status IN ('pending', 'queued', 'sending', 'retry') THEN 1 ELSE 0 END) AS pending_count,
    SUM(CASE WHEN d.status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
    SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
    SUM(CASE WHEN d.status = 'dry_run' THEN 1 ELSE 0 END) AS dry_run_count,
    SUM(CASE WHEN d.status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed_count,
    SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
   FROM podcast_announcements a
   LEFT JOIN podcast_announcement_deliveries d
     ON d.announcement_id = a.id
   ${whereClause}
   GROUP BY a.id`;
}

function presentAnnouncement(row: AnnouncementRow): Record<string, unknown> {
  return {
    id: row.id,
    showId: row.show_id,
    revision: row.revision,
    language: row.language,
    subject: row.subject,
    heading: row.heading,
    announcementRevision: row.announcement_revision,
    audienceRevision: row.audience_revision,
    reviewHash: row.review_hash,
    eligibleRecipientCount: row.eligible_recipient_count,
    deliveryMode: row.delivery_mode,
    status: row.status,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    deliveryCounts: {
      pending: Number(row.pending_count ?? 0),
      accepted: Number(row.accepted_count ?? 0),
      delivered: Number(row.delivered_count ?? 0),
      dryRun: Number(row.dry_run_count ?? 0),
      suppressed: Number(row.suppressed_count ?? 0),
      failed: Number(row.failed_count ?? 0)
    }
  };
}

async function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  now = new Date()
): Promise<{ valid: boolean; id: string }> {
  const id = headers.get("svix-id") ?? "";
  const timestamp = headers.get("svix-timestamp") ?? "";
  const signature = headers.get("svix-signature") ?? "";
  const timestampSeconds = Number(timestamp);
  if (
    !id
    || id.length > 160
    || !Number.isSafeInteger(timestampSeconds)
    || Math.abs(now.getTime() / 1_000 - timestampSeconds) > 5 * 60
    || !signature
  ) {
    return { valid: false, id };
  }
  try {
    const secretValue = secret.startsWith("whsec_")
      ? secret.slice(6)
      : secret;
    const key = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(secretValue),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const digest = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)
    ));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    const expected = btoa(binary);
    const candidates = signature.split(/\s+/)
      .map((value) => value.startsWith("v1,") ? value.slice(3) : "")
      .filter(Boolean);
    return {
      valid: candidates.some((candidate) =>
        timingSafeEqual(candidate, expected)
      ),
      id
    };
  } catch {
    return { valid: false, id };
  }
}

function webhookDeliveryStatus(
  eventType: string,
  data: Record<string, unknown> | null
): "accepted" | "delivered" | "suppressed" | "failed" | null {
  if (eventType === "email.sent") return "accepted";
  if (eventType === "email.delivered") return "delivered";
  if (
    eventType === "email.suppressed"
    || eventType === "email.complained"
  ) return "suppressed";
  if (eventType === "email.bounced") {
    return shouldSuppressForWebhook(eventType, data)
      ? "suppressed"
      : "failed";
  }
  if (eventType === "email.failed") return "failed";
  return null;
}

function shouldSuppressForWebhook(
  eventType: string,
  data: Record<string, unknown> | null
): boolean {
  if (
    eventType === "email.complained"
    || eventType === "email.suppressed"
  ) return true;
  if (eventType !== "email.bounced") return false;
  const bounce = objectValue(data?.bounce);
  return String(bounce?.type ?? "").toLowerCase() === "permanent";
}

function normalizeWebhookTags(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((item) => {
      const tag = objectValue(item);
      const name = typeof tag?.name === "string" ? tag.name : "";
      const tagValue = typeof tag?.value === "string" ? tag.value : "";
      return name ? [[name, tagValue]] : [];
    }));
  }
  const tags = objectValue(value);
  if (!tags) return {};
  return Object.fromEntries(Object.entries(tags).flatMap(([key, tagValue]) =>
    typeof tagValue === "string" ? [[key, tagValue]] : []
  ));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0)
  );
}

function unsubscribeNotFound(): Response {
  return new Response(
    JSON.stringify({ error: "unsubscribe_not_found" }),
    {
      status: 404,
      headers: publicUnsubscribeHeaders(
        "application/json; charset=utf-8"
      )
    }
  );
}

function publicUnsubscribeHeaders(
  contentType?: string
): Headers {
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive"
  });
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function webhookJson(
  body: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
