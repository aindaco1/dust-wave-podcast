import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("announcement delivery migration", () => {
  it("replays from zero with immutable approvals and indexed due work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.exec(`
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
          '${"b".repeat(64)}',
          '${"c".repeat(64)}',
          '${"d".repeat(64)}',
          0,
          'dry_run',
          'admin_fixture',
          'admin_fixture'
        );
      `);

      expect(() => db.exec(`
        UPDATE podcast_announcements
        SET subject = 'Changed'
        WHERE id = 'announcement_fixture'
      `)).toThrow("podcast_announcement_content_immutable");
      expect(() => db.exec(`
        UPDATE podcast_announcements
        SET status = 'completed'
        WHERE id = 'announcement_fixture'
      `)).not.toThrow();

      const duePlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id
        FROM podcast_announcement_deliveries
        WHERE status IN ('pending', 'retry')
          AND next_attempt_at <= datetime('now')
        ORDER BY next_attempt_at, id
        LIMIT 100
      `).all()
        .map((step) => String(step.detail))
        .join("\n");
      expect(duePlan).toContain("podcast_announcement_deliveries_due");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
