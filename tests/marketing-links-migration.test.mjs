import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("saved marketing links migration", () => {
  it("replays from zero with show-local uniqueness and a recent-list index", () => {
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
        INSERT INTO podcast_marketing_links (
          id,
          show_id,
          code,
          label,
          canonical_url,
          tagged_url,
          created_by_admin_user_id,
          updated_by_admin_user_id
        ) VALUES (
          'marketing_link_fixture',
          'show_fixture',
          'newsletter',
          'Newsletter',
          'https://dustwave.xyz/podcasts/show-fixture/',
          'https://dustwave.xyz/podcasts/show-fixture/?utm_source=newsletter',
          'admin_fixture',
          'admin_fixture'
        );
      `);

      expect(() => db.exec(`
        INSERT INTO podcast_marketing_links (
          id,
          show_id,
          code,
          label,
          canonical_url,
          tagged_url,
          created_by_admin_user_id,
          updated_by_admin_user_id
        ) SELECT
          'marketing_link_duplicate',
          show_id,
          code,
          'Duplicate',
          canonical_url,
          tagged_url,
          created_by_admin_user_id,
          updated_by_admin_user_id
        FROM podcast_marketing_links
        WHERE id = 'marketing_link_fixture'
      `)).toThrow(/UNIQUE constraint failed/);

      const listPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id
        FROM podcast_marketing_links
        WHERE show_id = 'show_fixture'
        ORDER BY updated_at DESC, id DESC
        LIMIT 20
      `).all()
        .map((step) => String(step.detail))
        .join("\n");
      expect(listPlan).toContain("podcast_marketing_links_show_recent");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

