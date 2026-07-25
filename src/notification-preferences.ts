import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { requireListener } from "./listener-auth";
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
  await env.DB
    .prepare(
      `INSERT INTO show_notification_preferences (
         listener_id,
         show_id,
         announcements_enabled,
         language,
         consented_at,
         withdrawn_at
       ) VALUES (
         ?, ?, ?, ?,
         CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
         CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END
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
         updated_at = datetime('now')`
    )
    .bind(
      listenerId,
      subscription.show.id,
      body.enabled ? 1 : 0,
      language,
      body.enabled ? 1 : 0,
      body.enabled ? 1 : 0
    )
    .run();
  return privateJson(request, env.ALLOWED_ORIGINS, {
    show: subscription.show,
    preference: {
      announcementsEnabled: body.enabled,
      language,
      consentSource: "member_account"
    }
  });
}
