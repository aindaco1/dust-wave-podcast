import launchLabFixture from "../config/launch-lab-fixture.json";

type SourceRow = {
  listener_id: string;
  status: string;
  current_period_end: string | null;
};

export async function loadLaunchLabStripeSource(
  db: D1Database,
  subscriptionId: string
): Promise<SourceRow | null> {
  return db.prepare(
    `SELECT listener_id, status, current_period_end
     FROM subscription_entitlement_sources
     WHERE provider = 'stripe' AND provider_subscription_id = ?`
  ).bind(subscriptionId).first<SourceRow>();
}

export async function cleanupLaunchLabStripeFixture(
  db: D1Database,
  input: { attemptId: string; subscriptionId: string | null }
): Promise<void> {
  const source = input.subscriptionId
    ? await loadLaunchLabStripeSource(db, input.subscriptionId)
    : null;
  if (source) {
    await db.batch([
      db.prepare(
        `DELETE FROM subscriptions WHERE listener_id = ? AND show_id = ?`
      ).bind(source.listener_id, launchLabFixture.show.id),
      db.prepare(
        `DELETE FROM subscription_entitlement_sources
         WHERE listener_id = ? AND show_id = ? AND provider = 'stripe'
           AND provider_subscription_id = ?`
      ).bind(
        source.listener_id,
        launchLabFixture.show.id,
        input.subscriptionId
      ),
      db.prepare(
        `DELETE FROM subscription_checkout_attempts WHERE id = ?`
      ).bind(input.attemptId),
      db.prepare(
        `DELETE FROM listener_accounts
         WHERE id = ? AND email_ciphertext = 'not_retained:stripe:v1'
           AND NOT EXISTS (
             SELECT 1 FROM subscription_entitlement_sources WHERE listener_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM subscriptions WHERE listener_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM subscription_checkout_attempts WHERE listener_id = ?
           )`
      ).bind(
        source.listener_id,
        source.listener_id,
        source.listener_id,
        source.listener_id
      )
    ]);
    return;
  }
  await db.prepare(
    `DELETE FROM subscription_checkout_attempts WHERE id = ?`
  ).bind(input.attemptId).run();
}
