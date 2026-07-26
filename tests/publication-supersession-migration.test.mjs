import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("publication job supersession migration", () => {
  it("cancels retryable older work and blocks a revision race with running work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.exec(`
        INSERT INTO episodes (
          id, show_id, slug, title, canonical_url, publication_revision
        ) VALUES (
          'episode_supersession_fixture',
          'show_opera_en_la_selva',
          'supersession-fixture',
          'Supersession fixture',
          'https://dustwave.xyz/news/podcasts/opera/supersession-fixture/',
          1
        );
        INSERT INTO distribution_jobs (
          id, episode_id, destination, status, scheduled_at,
          publication_revision, idempotency_key
        ) VALUES
          (
            'job_superseded_queued',
            'episode_supersession_fixture',
            'rss',
            'queued',
            '2026-07-27T00:00:00.000Z',
            1,
            'supersession:queued'
          ),
          (
            'job_superseded_failed',
            'episode_supersession_fixture',
            'news',
            'failed',
            '2026-07-27T00:00:00.000Z',
            1,
            'supersession:failed'
          );
        UPDATE episodes
        SET publication_revision = 2
        WHERE id = 'episode_supersession_fixture';
      `);

      expect(db.prepare(`
        SELECT id, status, completed_at, last_error
        FROM distribution_jobs
        WHERE episode_id = 'episode_supersession_fixture'
        ORDER BY id
      `).all()).toEqual([
        expect.objectContaining({
          id: "job_superseded_failed",
          status: "canceled",
          last_error: "Superseded by a newer publication revision."
        }),
        expect.objectContaining({
          id: "job_superseded_queued",
          status: "canceled",
          last_error: "Superseded by a newer publication revision."
        })
      ]);

      db.exec(`
        INSERT INTO distribution_jobs (
          id, episode_id, destination, status, scheduled_at, started_at,
          publication_revision, idempotency_key
        ) VALUES (
          'job_supersession_running',
          'episode_supersession_fixture',
          'news',
          'running',
          '2026-07-27T00:00:00.000Z',
          datetime('now'),
          2,
          'supersession:running'
        );
      `);
      expect(() => db.exec(`
        UPDATE episodes
        SET publication_revision = 3
        WHERE id = 'episode_supersession_fixture';
      `)).toThrow(/publication_jobs_running/);
      expect(db.prepare(`
        SELECT publication_revision
        FROM episodes
        WHERE id = 'episode_supersession_fixture'
      `).get()).toMatchObject({ publication_revision: 2 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
