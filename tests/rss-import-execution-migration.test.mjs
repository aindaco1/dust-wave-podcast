import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("RSS import execution migration", () => {
  it("replays with private-source retention and immutable reconciliation evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      const executionColumns = db.prepare(
        "PRAGMA table_info(rss_import_executions)"
      ).all().map(({ name }) => name);
      expect(executionColumns).toEqual(expect.arrayContaining([
        "feed_url_ciphertext",
        "feed_url_sha256",
        "feed_sha256",
        "selection_sha256",
        "expected_item_count",
        "copied_item_count",
        "draft_item_count",
        "failed_item_count",
        "source_url_expires_at"
      ]));
      const itemColumns = db.prepare(
        "PRAGMA table_info(rss_import_execution_items)"
      ).all().map(({ name }) => name);
      expect(itemColumns).toEqual(expect.arrayContaining([
        "target_episode_id",
        "target_slug",
        "target_object_key",
        "attempt_count",
        "response_resolved_url_sha256",
        "copied_bytes",
        "copied_sha256",
        "copied_etag",
        "episode_id",
        "last_error_code"
      ]));
      const triggers = db.prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name LIKE 'rss_import_%'`
      ).all().map(({ name }) => String(name));
      expect(triggers).toEqual(expect.arrayContaining([
        "rss_import_execution_identity_immutable",
        "rss_import_execution_items_identity_immutable",
        "rss_import_executions_immutable_delete",
        "rss_import_execution_items_immutable_delete",
        "rss_import_plan_execution_lock"
      ]));
      const migration = readFileSync(
        join(migrationsDirectory, "0056_rss_import_executions.sql"),
        "utf8"
      );
      expect(migration).toContain(
        "substr(feed_url_ciphertext, 1, 11) = 'aes-gcm-v1:'"
      );
      expect(migration).toContain("attempt_count BETWEEN 0 AND 5");
      expect(migration).toContain(
        "status IN ('queued', 'running', 'succeeded', 'partial', 'failed')"
      );
      expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
      const reconciliationColumns = db.prepare(
        "PRAGMA table_info(rss_import_reconciliations)"
      ).all().map(({ name }) => name);
      expect(reconciliationColumns).toEqual(expect.arrayContaining([
        "execution_id",
        "plan_id",
        "show_id",
        "evidence_sha256",
        "item_count",
        "copied_bytes",
        "approved_by_admin_user_id",
        "approved_at"
      ]));
      expect(triggers).toEqual(expect.arrayContaining([
        "rss_import_reconciliations_immutable_update",
        "rss_import_reconciliations_immutable_delete",
        "rss_import_reconciled_execution_lock",
        "rss_import_reconciled_item_lock"
      ]));
      const reconciliationMigration = readFileSync(
        join(
          migrationsDirectory,
          "0057_rss_import_reconciliations.sql"
        ),
        "utf8"
      );
      expect(reconciliationMigration).toContain(
        "rss_import_reconciliation_immutable"
      );
      expect(reconciliationMigration).not.toMatch(
        /\bDROP\s+(?:TABLE|COLUMN)\b/iu
      );
      const attestationColumns = db.prepare(
        "PRAGMA table_info(rss_import_redirect_attestations)"
      ).all().map(({ name }) => name);
      expect(attestationColumns).toEqual(expect.arrayContaining([
        "reconciliation_id",
        "execution_id",
        "plan_id",
        "show_id",
        "reconciliation_evidence_sha256",
        "old_feed_url_sha256",
        "new_feed_url_sha256",
        "redirect_method",
        "owner_control_confirmed",
        "permanence_acknowledged",
        "no_activation_confirmed",
        "attested_by_admin_user_id",
        "attested_at"
      ]));
      expect(triggers).toEqual(expect.arrayContaining([
        "rss_import_redirect_attestation_evidence_guard",
        "rss_import_redirect_attestations_immutable_update",
        "rss_import_redirect_attestations_immutable_delete"
      ]));
      const attestationMigration = readFileSync(
        join(
          migrationsDirectory,
          "0058_rss_import_redirect_attestations.sql"
        ),
        "utf8"
      );
      expect(attestationMigration).toContain(
        "'provider_managed_redirect'"
      );
      expect(attestationMigration).toContain(
        "rss_import_redirect_attestation_immutable"
      );
      expect(attestationMigration).not.toMatch(
        /\bDROP\s+(?:TABLE|COLUMN)\b/iu
      );
      const cutoverColumns = db.prepare(
        "PRAGMA table_info(rss_import_cutover_packets)"
      ).all().map(({ name }) => name);
      expect(cutoverColumns).toEqual(expect.arrayContaining([
        "reconciliation_id",
        "redirect_attestation_id",
        "execution_id",
        "plan_id",
        "show_id",
        "reconciliation_evidence_sha256",
        "imported_episode_state_sha256",
        "feed_validation_evidence_sha256",
        "directory_evidence_sha256",
        "evidence_sha256",
        "imported_episode_count",
        "public_episode_count",
        "certified_destination_count",
        "reobserved_destination_count",
        "feed_item_count",
        "expected_feed_item_count",
        "feed_validated_at",
        "show_evidence_version",
        "episode_evidence_version_total",
        "owner_review_confirmed",
        "no_activation_confirmed",
        "prepared_by_admin_user_id",
        "prepared_at"
      ]));
      expect(triggers).toEqual(expect.arrayContaining([
        "rss_import_cutover_packet_evidence_guard",
        "rss_import_cutover_packets_immutable_update",
        "rss_import_cutover_packets_immutable_delete"
      ]));
      const cutoverMigration = readFileSync(
        join(
          migrationsDirectory,
          "0059_rss_import_cutover_packets.sql"
        ),
        "utf8"
      );
      expect(cutoverMigration).toContain(
        "rss_import_cutover_packet_immutable"
      );
      expect(cutoverMigration).toContain(
        "reobserved_destination_count >= 10"
      );
      expect(cutoverMigration).not.toMatch(
        /\bDROP\s+(?:TABLE|COLUMN)\b/iu
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}
