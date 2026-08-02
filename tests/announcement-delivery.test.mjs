import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleResendWebhook,
  processAnnouncementDelivery,
  serveAnnouncementUnsubscribe
} from "../src/announcement-delivery";
import {
  notificationUnsubscribeToken,
  notificationUnsubscribeTokenHash
} from "../src/notification-destination";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const destinationSecret =
  "announcement_delivery_test_secret_123456789";
const deliveryId = `delivery_${"f".repeat(32)}`;

describe("durable announcement delivery", () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    for (const filename of readdirSync(migrationsDirectory)
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
    }
    seedDeliveryFixture(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("completes a dry-run entirely from durable state", async () => {
    await processAnnouncementDelivery(
      {
        DB: db,
        ANNOUNCEMENT_DELIVERY_MODE: "dry_run"
      },
      {
        id: deliveryId,
        type: "send-announcement",
        showId: "show_fixture",
        announcementId: "announcement_fixture",
        announcementDeliveryId: deliveryId,
        requestedAt: "2026-07-26T00:00:00.000Z"
      }
    );

    expect(sqlite.prepare(`
      SELECT status, attempt_count, provider_id
      FROM podcast_announcement_deliveries
      WHERE id = ?
    `).get(deliveryId)).toMatchObject({
      status: "dry_run",
      attempt_count: 1,
      provider_id: null
    });
    expect(sqlite.prepare(`
      SELECT status, completed_at
      FROM podcast_announcements
      WHERE id = 'announcement_fixture'
    `).get()).toMatchObject({
      status: "completed"
    });
  });

  it("withdraws one show, suppresses pending work, and erases its last destination", async () => {
    const token = await notificationUnsubscribeToken(
      "listener_fixture",
      "show_fixture",
      destinationSecret
    );
    const tokenHash = await notificationUnsubscribeTokenHash(token);
    sqlite.prepare(`
      UPDATE show_notification_preferences
      SET unsubscribe_token_hash = ?
      WHERE listener_id = 'listener_fixture'
        AND show_id = 'show_fixture'
    `).run(tokenHash);

    const response = await serveAnnouncementUnsubscribe(
      new Request(
        `https://feeds.dustwave.xyz/v1/notifications/unsubscribe/${token}`,
        { method: "POST" }
      ),
      { DB: db },
      token
    );

    expect(response.status).toBe(204);
    expect(sqlite.prepare(`
      SELECT announcements_enabled, withdrawn_at
      FROM show_notification_preferences
      WHERE listener_id = 'listener_fixture'
        AND show_id = 'show_fixture'
    `).get()).toMatchObject({
      announcements_enabled: 0
    });
    expect(sqlite.prepare(`
      SELECT status, last_error_code
      FROM podcast_announcement_deliveries
      WHERE id = ?
    `).get(deliveryId)).toMatchObject({
      status: "suppressed",
      last_error_code: "listener_unsubscribed"
    });
    expect(sqlite.prepare(`
      SELECT email_ciphertext
      FROM listener_accounts
      WHERE id = 'listener_fixture'
    `).get()).toEqual({
      email_ciphertext: "not_retained:notification_withdrawn:v1"
    });
  });

  it("accepts a signed complaint once and globally suppresses the destination", async () => {
    const secretBytes = new TextEncoder().encode(
      "resend_webhook_test_secret_123456"
    );
    const webhookSecret = `whsec_${bytesToBase64(secretBytes)}`;
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const eventId = "evt_announcement_fixture";
    const body = JSON.stringify({
      type: "email.complained",
      data: {
        email_id: "email_provider_fixture",
        tags: [{
          name: "podcast_delivery",
          value: deliveryId
        }]
      }
    });
    const signature = await signWebhook(
      eventId,
      timestamp,
      body,
      secretBytes
    );
    const request = () => new Request(
      "https://feeds.dustwave.xyz/v1/webhooks/resend",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": eventId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${signature}`
        },
        body
      }
    );

    const first = await handleResendWebhook(
      request(),
      { DB: db, RESEND_WEBHOOK_SECRET: webhookSecret }
    );
    const replay = await handleResendWebhook(
      request(),
      { DB: db, RESEND_WEBHOOK_SECRET: webhookSecret }
    );

    expect(await first.json()).toEqual({
      received: true,
      matched: true
    });
    expect(await replay.json()).toEqual({
      received: true,
      duplicate: true
    });
    expect(sqlite.prepare(`
      SELECT status, provider_id
      FROM podcast_announcement_deliveries
      WHERE id = ?
    `).get(deliveryId)).toMatchObject({
      status: "suppressed",
      provider_id: "email_provider_fixture"
    });
    expect(sqlite.prepare(`
      SELECT reason, source_event_id
      FROM podcast_announcement_suppressions
    `).get()).toEqual({
      reason: "email.complained",
      source_event_id: eventId
    });
  });

  it("routes signed Launch Lab events without touching real announcement state", async () => {
    const scenarioId = "lab_launch_lab_run_0001_resend_delivered";
    sqlite.prepare(
      "INSERT INTO launch_lab_runs (id, show_id, source_commit) "
      + "VALUES (?, ?, ?)"
    ).run(
      "launch_lab_run_0001",
      "show_fixture",
      "a".repeat(40)
    );
    sqlite.prepare(
      "INSERT INTO launch_lab_provider_scenarios "
      + "(id, run_id, provider, scenario, expected_status, state, "
      + "observed_status, provider_id) "
      + "VALUES (?, ?, 'resend', ?, ?, 'running', 'accepted', ?)"
    ).run(
      scenarioId,
      "launch_lab_run_0001",
      "delivered",
      "delivered",
      "email_launch_lab_fixture"
    );
    const secretBytes = new TextEncoder().encode(
      "resend_webhook_test_secret_123456"
    );
    const webhookSecret = "whsec_" + bytesToBase64(secretBytes);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const eventId = "evt_launch_lab_fixture";
    const body = JSON.stringify({
      type: "email.delivered",
      data: {
        email_id: "email_launch_lab_fixture",
        tags: [{
          name: "launch_lab_scenario",
          value: scenarioId
        }]
      }
    });
    const signature = await signWebhook(
      eventId,
      timestamp,
      body,
      secretBytes
    );
    const response = await handleResendWebhook(
      new Request(
        "https://feeds.dustwave.xyz/v1/webhooks/resend",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": eventId,
            "svix-timestamp": timestamp,
            "svix-signature": "v1," + signature
          },
          body
        }
      ),
      { DB: db, RESEND_WEBHOOK_SECRET: webhookSecret }
    );

    expect(await response.json()).toEqual({
      received: true,
      matched: true,
      launchLab: true
    });
    expect(sqlite.prepare(
      "SELECT state, observed_status "
      + "FROM launch_lab_provider_scenarios WHERE id = ?"
    ).get(scenarioId)).toEqual({
      state: "passed",
      observed_status: "delivered"
    });
    expect(sqlite.prepare(
      "SELECT status FROM podcast_announcement_deliveries WHERE id = ?"
    ).get(deliveryId)).toEqual({ status: "pending" });
  });
});

function seedDeliveryFixture(sqlite) {
  sqlite.exec(`
    INSERT INTO shows (
      id, slug, title, canonical_url, rss_slug
    ) VALUES (
      'show_fixture',
      'show-fixture',
      'Show Fixture',
      'https://dustwave.xyz/podcasts/show-fixture/',
      'show-fixture'
    );
    INSERT INTO admin_users (
      id, email_lookup_hash, status
    ) VALUES (
      'admin_fixture',
      '${"a".repeat(64)}',
      'active'
    );
    INSERT INTO listener_accounts (
      id, email_lookup_hash, email_ciphertext
    ) VALUES (
      'listener_fixture',
      '${"b".repeat(64)}',
      'aes-gcm-v1:fixture:fixture'
    );
    INSERT INTO subscriptions (
      id,
      listener_id,
      show_id,
      status,
      updated_at
    ) VALUES (
      'subscription_fixture',
      'listener_fixture',
      'show_fixture',
      'active',
      '2026-07-26 00:00:00'
    );
    INSERT INTO show_notification_preferences (
      listener_id,
      show_id,
      announcements_enabled,
      language,
      consented_at,
      updated_at
    ) VALUES (
      'listener_fixture',
      'show_fixture',
      1,
      'en',
      '2026-07-26 00:00:00',
      '2026-07-26 00:00:00'
    );
    INSERT INTO podcast_announcements (
      id,
      show_id,
      revision,
      language,
      subject,
      body_markdown,
      announcement_revision,
      audience_revision,
      review_hash,
      eligible_recipient_count,
      delivery_mode,
      created_by_admin_user_id,
      approved_by_admin_user_id
    ) VALUES (
      'announcement_fixture',
      'show_fixture',
      1,
      'en',
      'Subject',
      'Body',
      '${"c".repeat(64)}',
      '${"d".repeat(64)}',
      '${"e".repeat(64)}',
      1,
      'dry_run',
      'admin_fixture',
      'admin_fixture'
    );
    INSERT INTO podcast_announcement_deliveries (
      id,
      announcement_id,
      listener_id,
      destination_hash,
      preference_updated_at,
      entitlement_updated_at
    ) VALUES (
      '${deliveryId}',
      'announcement_fixture',
      'listener_fixture',
      '${"b".repeat(64)}',
      '2026-07-26 00:00:00',
      '2026-07-26 00:00:00'
    );
  `);
}

function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      const statement = {
        bind(...bound) {
          values = bound;
          return statement;
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: sqlite.prepare(query).all(...values),
            meta: {}
          };
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) }
          };
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

async function signWebhook(
  eventId,
  timestamp,
  body,
  secret
) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${eventId}.${timestamp}.${body}`)
  ));
  return bytesToBase64(digest);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
