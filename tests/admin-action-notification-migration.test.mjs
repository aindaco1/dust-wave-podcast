import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  DELIVERY_AUDIO_APPROVAL_EVIDENCE_SELECT,
  TRANSCRIPT_REVIEW_EVIDENCE_SELECT,
  WORKING_MASTER_DECISION_EVIDENCE_SELECT
} from "../src/admin-action-notifications";
import { currentWorkingMasterDecisionEvidenceSql } from
  "../src/working-master-decision-evidence";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("admin action notification migration", () => {
  it("replays from zero with bounded, content-minimal lifecycle evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        if (filename === "0070_admin_action_review_kinds.sql") {
          db.exec(`
            INSERT INTO episodes (
              id, show_id, slug, title, canonical_url
            ) VALUES (
              'episode_admin_action_migration',
              'show_opera_en_la_selva',
              'admin-action-migration',
              'Admin action migration',
              'https://dustwave.xyz/news/podcasts/opera/admin-action-migration/'
            );
            INSERT INTO admin_action_notifications (
              id, episode_id, action_kind, target_id, action_digest
            ) VALUES (
              'admin_action_migration',
              'episode_admin_action_migration',
              'working_master_decision',
              'derivative_admin_action_migration',
              '${"e".repeat(64)}'
            );
          `);
        }
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }

      const columns = db.prepare(
        "PRAGMA table_info(admin_action_notifications)"
      ).all().map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "episode_id",
        "action_kind",
        "target_id",
        "action_digest",
        "status",
        "attempt_count",
        "lease_expires_at",
        "provider_id",
        "failure_code",
        "sent_at",
        "resolved_at"
      ]));
      expect(columns).not.toEqual(expect.arrayContaining([
        "email",
        "login_token",
        "media_object_key",
        "provider_response"
      ]));
      expect(() => db.prepare(
        `${WORKING_MASTER_DECISION_EVIDENCE_SELECT} LIMIT 1`
      ).all()).not.toThrow();
      expect(() => db.prepare(
        `${DELIVERY_AUDIO_APPROVAL_EVIDENCE_SELECT} LIMIT 1`
      ).all()).not.toThrow();
      expect(() => db.prepare(
        `${TRANSCRIPT_REVIEW_EVIDENCE_SELECT} LIMIT 1`
      ).all()).not.toThrow();
      expect(() => db.prepare(
        `SELECT id
         FROM audio_enhancement_derivatives
         WHERE ${currentWorkingMasterDecisionEvidenceSql({
           requireRevision: true
         })}`
      ).all(1)).not.toThrow();
      expect(db.prepare(`
        SELECT action_kind, status
        FROM admin_action_notifications
        WHERE id = 'admin_action_migration'
      `).get()).toEqual({
        action_kind: "working_master_decision",
        status: "pending"
      });
      db.exec(`
        INSERT INTO admin_action_notifications (
          id, episode_id, action_kind, target_id, action_digest
        ) VALUES
          (
            'admin_action_delivery_migration',
            'episode_admin_action_migration',
            'delivery_audio_approval',
            'delivery_admin_action_migration',
            '${"f".repeat(64)}'
          ),
          (
            'admin_action_transcript_migration',
            'episode_admin_action_migration',
            'transcript_review',
            'transcript_admin_action_migration',
            '${"1".repeat(64)}'
          );
      `);
      expect(db.prepare(`
        SELECT action_kind
        FROM admin_action_notifications
        ORDER BY action_kind
      `).all()).toEqual([
        { action_kind: "delivery_audio_approval" },
        { action_kind: "transcript_review" },
        { action_kind: "working_master_decision" }
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});
