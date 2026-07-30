import {
  hmacSha256,
  normalizeEmail,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { requireListener } from "./listener-auth";
import {
  notificationUnsubscribeToken,
  notificationUnsubscribeTokenHash,
  sealNotificationDestination
} from "./notification-destination";
import { isValidEmailAddress } from "./passwordless-security";
import {
  readJsonObject,
  RequestValidationError,
  validSlug
} from "./validation";

export async function updateListenerNotificationPreference(
  request: Request,
  env: PodcastEnv,
  showSlugValue: string
): Promise<Response> {
  const showSlug = validSlug(showSlugValue, "showSlug");
  const auth = await requireListener(request, env, { requireCsrf: true });
  if (!auth.ok) return auth.response;
  const subscription = auth.authorization.identity.subscriptions.find(
    ({ show }) => show.slug === showSlug
  );
  if (!subscription) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_subscription_not_found" },
      { status: 404 }
    );
  }
  const body = await readJsonObject(request, 16_384);
  if (typeof body.enabled !== "boolean") {
    throw new RequestValidationError("enabled must be a boolean");
  }
  const language = String(body.language ?? "en").trim().toLowerCase();
  if (!["en", "es"].includes(language)) {
    throw new RequestValidationError("language must be en or es");
  }
  const listenerId = auth.authorization.identity.id;
  const account = await env.DB
    .prepare(
      `SELECT email_lookup_hash
       FROM listener_accounts
       WHERE id = ?`
    )
    .bind(listenerId)
    .first<{ email_lookup_hash: string }>();
  if (!account) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "listener_not_found" },
      { status: 404 }
    );
  }

  let sealedDestination: string | null = null;
  let unsubscribeTokenHash: string | null = null;
  if (body.enabled) {
    if (
      !env.ANNOUNCEMENT_DESTINATION_SECRET
      || !env.LISTENER_EMAIL_LOOKUP_PEPPER
    ) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "notification_delivery_not_configured" },
        { status: 503 }
      );
    }
    const email = normalizeEmail(body.email);
    if (!isValidEmailAddress(email)) {
      throw new RequestValidationError(
        "email is required when enabling notifications"
      );
    }
    const emailLookupHash = await hmacSha256(
      email,
      env.LISTENER_EMAIL_LOOKUP_PEPPER,
      "hex"
    );
    if (!timingSafeEqual(emailLookupHash, account.email_lookup_hash)) {
      throw new RequestValidationError(
        "email must match the authenticated listener account",
        "notification_email_mismatch",
        403
      );
    }
    sealedDestination = await sealNotificationDestination(
      email,
      listenerId,
      env.ANNOUNCEMENT_DESTINATION_SECRET
    );
    const unsubscribeToken = await notificationUnsubscribeToken(
      listenerId,
      subscription.show.id,
      env.ANNOUNCEMENT_DESTINATION_SECRET
    );
    unsubscribeTokenHash = await notificationUnsubscribeTokenHash(
      unsubscribeToken
    );
  }

  const preferenceStatement = env.DB
    .prepare(
      `INSERT INTO show_notification_preferences (
         listener_id,
         show_id,
         announcements_enabled,
         language,
         consented_at,
         withdrawn_at,
         unsubscribe_token_hash
       ) VALUES (
         ?, ?, ?, ?,
         CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
         CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END,
         ?
       )
       ON CONFLICT(listener_id, show_id) DO UPDATE SET
         announcements_enabled = excluded.announcements_enabled,
         language = excluded.language,
         consented_at = CASE
           WHEN excluded.announcements_enabled = 1
           THEN datetime('now')
           ELSE show_notification_preferences.consented_at
         END,
         withdrawn_at = CASE
           WHEN excluded.announcements_enabled = 0
           THEN datetime('now')
           ELSE NULL
         END,
         unsubscribe_token_hash = CASE
           WHEN excluded.announcements_enabled = 1
           THEN excluded.unsubscribe_token_hash
           ELSE show_notification_preferences.unsubscribe_token_hash
         END,
         updated_at = datetime('now')`
    )
    .bind(
      listenerId,
      subscription.show.id,
      body.enabled ? 1 : 0,
      language,
      body.enabled ? 1 : 0,
      body.enabled ? 1 : 0,
      unsubscribeTokenHash
    );
  if (body.enabled && sealedDestination) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE listener_accounts
         SET email_ciphertext = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(sealedDestination, listenerId),
      preferenceStatement
    ]);
  } else {
    await env.DB.batch([
      preferenceStatement,
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
               AND announcements_enabled = 1
               AND withdrawn_at IS NULL
           )`
      ).bind(listenerId, listenerId)
    ]);
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    show: subscription.show,
    preference: {
      announcementsEnabled: body.enabled,
      language,
      consentSource: "member_account",
      destinationProtected: body.enabled
    }
  });
}
