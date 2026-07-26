import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("subscription tax reconciliation migration", () => {
  it("replays from zero and constrains minimized invoice and preview evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      const checkoutColumns = db.prepare(
        "PRAGMA table_info(subscription_checkout_attempts)"
      ).all().map((column) => column.name);
      expect(checkoutColumns).toContain("stripe_integration_identifier");
      expect(() => db.exec(`
        INSERT INTO subscription_checkout_attempts (
          id, show_id, price_id, stripe_integration_identifier, idempotency_key
        ) VALUES (
          'checkout_invalid_integration',
          'show_opera_en_la_selva',
          'price_opera_monthly',
          'dustwave_podcast_12345678',
          'checkout-invalid-integration'
        );
      `)).toThrow();

      db.exec(`
        INSERT INTO listener_accounts (
          id, email_lookup_hash, email_ciphertext
        ) VALUES (
          'listener_tax_fixture',
          '${"a".repeat(64)}',
          'not_retained:test'
        );
        INSERT INTO stripe_event_journal (
          event_id, event_type, livemode, provider_created_at
        ) VALUES
          ('evt_invoice_tax_fixture', 'invoice.paid', 0, 1785024000),
          ('evt_customer_tax_fixture', 'customer.updated', 0, 1785024001);
        INSERT INTO subscription_invoice_tax_evidence (
          event_id,
          provider_invoice_id,
          provider_subscription_id,
          listener_id,
          show_id,
          provider_mode,
          invoice_event_type,
          invoice_status,
          currency,
          observed_tax_rate_ids_json,
          reconciliation_status
        ) VALUES (
          'evt_invoice_tax_fixture',
          'in_invoice_fixture',
          'sub_subscription_fixture',
          'listener_tax_fixture',
          'show_opera_en_la_selva',
          'test',
          'invoice.paid',
          'paid',
          'USD',
          '["txr_fixture"]',
          'matched'
        );
        INSERT INTO subscription_tax_change_previews (
          event_id,
          provider_subscription_id,
          listener_id,
          show_id,
          provider_mode,
          destination_hash,
          preview_status
        ) VALUES (
          'evt_customer_tax_fixture',
          'sub_subscription_fixture',
          'listener_tax_fixture',
          'show_opera_en_la_selva',
          'test',
          '${"b".repeat(64)}',
          'rate_changed'
        );
      `);

      expect(db.prepare(`
        SELECT reconciliation_status
        FROM subscription_invoice_tax_evidence
        WHERE event_id = 'evt_invoice_tax_fixture'
      `).get()).toMatchObject({ reconciliation_status: "matched" });
      expect(db.prepare(`
        SELECT preview_status
        FROM subscription_tax_change_previews
        WHERE event_id = 'evt_customer_tax_fixture'
      `).get()).toMatchObject({ preview_status: "rate_changed" });
      expect(() => db.exec(`
        UPDATE subscription_invoice_tax_evidence
        SET observed_tax_rate_ids_json = 'not-json'
        WHERE event_id = 'evt_invoice_tax_fixture';
      `)).toThrow();
      expect(() => db.exec(`
        UPDATE subscription_tax_change_previews
        SET destination_hash = 'raw-address'
        WHERE event_id = 'evt_customer_tax_fixture';
      `)).toThrow();
      const showExportPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT evidence.event_id, shows.title
        FROM subscription_invoice_tax_evidence evidence
        JOIN shows ON shows.id = evidence.show_id
        WHERE evidence.show_id = ?
        ORDER BY evidence.created_at DESC, evidence.event_id DESC
        LIMIT ?
      `).all("show_opera_en_la_selva", 250)
        .map((step) => String(step.detail))
        .join("\n");
      expect(showExportPlan).toContain(
        "subscription_invoice_tax_evidence_show"
      );
      const recentExportPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT evidence.event_id, shows.title
        FROM subscription_invoice_tax_evidence evidence
        JOIN shows ON shows.id = evidence.show_id
        ORDER BY evidence.created_at DESC, evidence.event_id DESC
        LIMIT ?
      `).all(250)
        .map((step) => String(step.detail))
        .join("\n");
      expect(recentExportPlan).toContain(
        "subscription_invoice_tax_evidence_recent"
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
