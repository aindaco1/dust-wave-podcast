import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("web-player completion analytics migration", () => {
  it("replays from zero with bounded milestones, retention, and show indexes", () => {
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
        INSERT INTO episodes (
          id, show_id, slug, title, canonical_url
        ) VALUES (
          'episode_fixture',
          'show_fixture',
          'episode-fixture',
          'Episode Fixture',
          'https://dustwave.xyz/episode-fixture/'
        );
        INSERT INTO podcast_analytics_progress_uniques (
          unique_key, methodology_version, window_date, show_id,
          episode_id, milestone_percent, expires_at
        ) VALUES (
          '${"a".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          25,
          '2026-08-30T00:00:00Z'
        );
        INSERT INTO podcast_analytics_progress_rollups (
          id, methodology_version, window_date, show_id, episode_id,
          milestone_percent, event_count
        ) VALUES (
          '${"b".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          25,
          1
        );
        INSERT OR IGNORE INTO podcast_analytics_progress_uniques (
          unique_key, methodology_version, window_date, show_id,
          episode_id, milestone_percent, expires_at
        ) VALUES (
          '${"d".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          50,
          '2026-08-30T00:00:00Z'
        );
        INSERT INTO podcast_analytics_progress_rollups (
          id, methodology_version, window_date, show_id, episode_id,
          milestone_percent, event_count
        )
        SELECT
          '${"e".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          50,
          1
        WHERE changes() = 1
        ON CONFLICT(id) DO UPDATE SET event_count = event_count + 1;
        INSERT OR IGNORE INTO podcast_analytics_progress_uniques (
          unique_key, methodology_version, window_date, show_id,
          episode_id, milestone_percent, expires_at
        ) VALUES (
          '${"d".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          50,
          '2026-08-30T00:00:00Z'
        );
        INSERT INTO podcast_analytics_progress_rollups (
          id, methodology_version, window_date, show_id, episode_id,
          milestone_percent, event_count
        )
        SELECT
          '${"e".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          50,
          1
        WHERE changes() = 1
        ON CONFLICT(id) DO UPDATE SET event_count = event_count + 1;
      `);

      expect(db.prepare(`
        SELECT event_count
        FROM podcast_analytics_progress_rollups
        WHERE id = '${"e".repeat(64)}'
      `).get()).toEqual({ event_count: 1 });

      expect(() => db.exec(`
        INSERT INTO podcast_analytics_progress_rollups (
          id, methodology_version, window_date, show_id, episode_id,
          milestone_percent, event_count
        ) VALUES (
          '${"c".repeat(64)}',
          'dustwave-analytics-v1',
          '2026-07-26',
          'show_fixture',
          'episode_fixture',
          10,
          1
        )
      `)).toThrow(/CHECK constraint failed/);

      const listPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT episode_id, milestone_percent, SUM(event_count)
        FROM podcast_analytics_progress_rollups
        WHERE show_id = 'show_fixture'
          AND window_date BETWEEN '2026-07-01' AND '2026-07-31'
        GROUP BY episode_id, milestone_percent
      `).all()
        .map((step) => String(step.detail))
        .join("\n");
      expect(listPlan).toContain(
        "podcast_analytics_progress_rollups_show_date"
      );
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
